"""Health domain logic: readings, thresholds, alerts, goals, streaks and aggregates.

Functions take a subject `user_id` so the same code serves the owner and (read-only) caregivers.
"""
from __future__ import annotations

import json
import random
from datetime import date, datetime, timedelta, timezone

from .db import insert, utc_now

# ---------- limits ----------

LIMITS = {
    "bpm": (20, 250),
    "spo2": (50, 100),
    "temp_c": (30, 45),
    "steps": (0, 100000),
    "sleep": (0, 24),
    "water": (0, 15),
    "weight": (20, 400),
}

DEFAULT_THRESHOLDS = {"bpm_low": 45.0, "bpm_high": 120.0, "spo2_low": 92.0, "temp_high": 38.0}
THRESHOLD_LIMITS = {"bpm_low": (30, 80), "bpm_high": (80, 200), "spo2_low": (80, 98), "temp_high": (37, 41)}

SYMPTOMS = ("chest_pain", "palpitations", "dizziness", "short_breath", "fatigue", "headache", "nausea", "other")
# Words in an own symptom that call for the same 112 advice as chest pain or shortness of breath (NL + EN).
URGENT_WORDS = ("borst", "benauwd", "adem", "flauw", "bewusteloos", "verlamd", "scheve mond",
                "chest", "breath", "faint", "unconscious", "paralys")


def sounds_urgent(text_value: str | None) -> bool:
    value = (text_value or "").lower()
    return any(word in value for word in URGENT_WORDS)
ACTIVITIES = ("rest", "light", "moderate", "vigorous", "sleep")
ALERT_DEDUPE_MINUTES = 30
NO_DATA_HOURS = 2


def parse_ts(value) -> datetime:
    """Parse ISO-8601 (with Z or offset, or naive = UTC) into a naive UTC datetime."""
    text = str(value or "").strip()
    if not text:
        raise ValueError("missing_ts")
    parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed.replace(microsecond=0)


def iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)


# ---------- thresholds and alerts ----------

def get_thresholds(connection, user_id: int) -> dict:
    row = connection.execute("SELECT * FROM thresholds WHERE user_id=?", (user_id,)).fetchone()
    if row is None:
        return dict(DEFAULT_THRESHOLDS, custom=False)
    return {k: row[k] for k in DEFAULT_THRESHOLDS} | {"custom": True, "updated_at": row["updated_at"]}


def classify(reading: dict, thresholds: dict) -> list[tuple[str, str, float, float]]:
    """Return (kind, severity, value, threshold) for each out-of-range value. Conservative on purpose."""
    found = []
    bpm, spo2, temp = reading.get("bpm"), reading.get("spo2"), reading.get("temp_c")
    resting = reading.get("activity") in (None, "rest", "sleep")
    if bpm is not None:
        if bpm > thresholds["bpm_high"] and (resting or bpm > thresholds["bpm_high"] + 40):
            urgent = bpm >= max(150, thresholds["bpm_high"] + 30)
            found.append(("bpm_high", "urgent" if urgent else "warning", bpm, thresholds["bpm_high"]))
        elif bpm < thresholds["bpm_low"]:
            found.append(("bpm_low", "urgent" if bpm < 40 else "warning", bpm, thresholds["bpm_low"]))
    if spo2 is not None and spo2 < thresholds["spo2_low"]:
        found.append(("spo2_low", "urgent" if spo2 < 90 else "warning", spo2, thresholds["spo2_low"]))
    if temp is not None and temp > thresholds["temp_high"]:
        found.append(("temp_high", "urgent" if temp >= 39.5 else "warning", temp, thresholds["temp_high"]))
    return found


def raise_alerts(connection, user_id: int, reading: dict, thresholds: dict) -> int:
    created = 0
    for kind, severity, value, threshold in classify(reading, thresholds):
        since = iso(now_utc() - timedelta(minutes=ALERT_DEDUPE_MINUTES))
        recent = connection.execute(
            "SELECT id, severity FROM alerts WHERE user_id=? AND kind=? AND created_at>=? AND acknowledged_at IS NULL "
            "ORDER BY id DESC LIMIT 1",
            (user_id, kind, since),
        ).fetchone()
        if recent and not (recent["severity"] == "warning" and severity == "urgent"):
            continue
        insert(connection, "alerts", {
            "user_id": user_id, "kind": kind, "severity": severity, "value": value, "threshold": threshold,
            "reading_ts": reading.get("ts"), "created_at": utc_now(),
        })
        insert(connection, "notifications", {
            "user_id": user_id, "kind": f"alert_{severity}", "reference": kind,
            "message": json.dumps({"kind": kind, "severity": severity, "value": value}), "created_at": utc_now(),
        })
        created += 1
    return created


# ---------- readings ----------

def validate_reading(item: dict, now: datetime) -> dict:
    allowed = {"ts", "bpm", "spo2", "temp_c", "steps", "activity", "device"}
    if not isinstance(item, dict):
        raise ValueError("not_an_object")
    unknown = set(item) - allowed
    if unknown:
        raise ValueError("unknown_fields")
    ts = parse_ts(item.get("ts"))
    if ts > now + timedelta(minutes=5):
        raise ValueError("ts_in_future")
    if ts < now - timedelta(days=30):
        raise ValueError("ts_too_old")
    out = {"ts": iso(ts), "device": str(item.get("device") or "watch")[:40]}
    for field in ("bpm", "spo2", "temp_c", "steps"):
        value = item.get(field)
        if value is None or value == "":
            out[field] = None
            continue
        if isinstance(value, bool):
            raise ValueError(f"invalid_{field}")
        number = float(value)
        low, high = LIMITS[field]
        if number != number or not (low <= number <= high):
            raise ValueError(f"out_of_range_{field}")
        out[field] = number
    activity = item.get("activity")
    if activity is not None and activity not in ACTIVITIES:
        raise ValueError("invalid_activity")
    out["activity"] = activity
    if all(out[f] is None for f in ("bpm", "spo2", "temp_c", "steps")):
        raise ValueError("no_values")
    return out


def store_readings(connection, user_id: int, items: list, source: str = "api") -> dict:
    now = now_utc()
    thresholds = get_thresholds(connection, user_id)
    accepted = duplicates = alerts = 0
    errors = []
    for index, item in enumerate(items):
        try:
            reading = validate_reading(item, now)
        except (ValueError, TypeError) as error:
            errors.append({"index": index, "error": str(error) if str(error) else "invalid"})
            continue
        cursor = connection.execute(
            "INSERT OR IGNORE INTO readings(user_id,device,ts,bpm,spo2,temp_c,steps,activity,source,created_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?)",
            (user_id, reading["device"], reading["ts"], reading["bpm"], reading["spo2"], reading["temp_c"],
             reading["steps"], reading["activity"], source, utc_now()),
        )
        if cursor.rowcount == 0:
            duplicates += 1
            continue
        accepted += 1
        # Only recent readings raise alerts; backfilled history shouldn't page anyone.
        if parse_ts(reading["ts"]) >= now - timedelta(hours=6):
            alerts += raise_alerts(connection, user_id, reading, thresholds)
    return {"accepted": accepted, "duplicates": duplicates, "rejected": len(errors), "errors": errors[:50], "alerts": alerts}


# ---------- entries (manual check-ins, legacy API) ----------

def serialise_entry(payload: dict, source: str) -> dict:
    from .db import normalise_date

    def number(name, field=None):
        value = payload.get(name)
        if value in (None, ""):
            return None
        try:
            result = float(value)
        except (TypeError, ValueError):
            raise ValueError(f"invalid_{name}")
        low, high = LIMITS[field or name]
        if result != result or not (low <= result <= high):
            raise ValueError(f"out_of_range_{name}")
        return result

    entry_time = str(payload.get("time") or "").strip()[:5] or None
    if entry_time and not (len(entry_time) == 5 and entry_time[2] == ":" and entry_time.replace(":", "").isdigit()):
        raise ValueError("invalid_time")
    return {
        "entry_date": normalise_date(payload.get("date") or date.today().isoformat()),
        "entry_time": entry_time,
        "steps": number("steps") or 0,
        "sleep": number("sleep") or 0,
        "water": number("water") or 0,
        "weight": number("weight"),
        "bpm": number("bpm"),
        "spo2": number("spo2"),
        "notes": str(payload.get("notes") or "")[:2000],
        "source": source,
    }


def store_entry(connection, user_id: int, payload: dict, source: str) -> dict:
    value = serialise_entry(payload, source)
    insert(connection, "entries", dict(value, user_id=user_id, created_at=utc_now()))
    result = {"alerts": 0}
    if value["bpm"] is not None or value.get("spo2") is not None:
        ts = f"{value['entry_date']}T{(value['entry_time'] or '12:00')}:00"
        reading = {"ts": ts, "bpm": value["bpm"], "spo2": value.get("spo2")}
        connection.execute(
            "INSERT OR IGNORE INTO readings(user_id,device,ts,bpm,spo2,source,created_at) VALUES(?,?,?,?,?,?,?)",
            (user_id, "manual" if source == "human" else "entry", ts, value["bpm"], value.get("spo2"), source, utc_now()),
        )
        if value["entry_date"] >= (date.today() - timedelta(days=1)).isoformat():
            result["alerts"] = raise_alerts(connection, user_id, reading, get_thresholds(connection, user_id))
    return result


# ---------- goals (softened quests) ----------

DAILY_POOL = [
    {"key": "steps_3000", "xp": 3, "needs": [("steps", 3000)]},
    {"key": "steps_5000", "xp": 5, "needs": [("steps", 5000)]},
    {"key": "steps_8000", "xp": 8, "needs": [("steps", 8000)]},
    {"key": "steps_10000", "xp": 10, "needs": [("steps", 10000)]},
    {"key": "sleep_7", "xp": 7, "needs": [("sleep", 7)]},
    {"key": "sleep_8", "xp": 8, "needs": [("sleep", 8)]},
    {"key": "water_1_5", "xp": 3, "needs": [("water", 1.5)]},
    {"key": "water_2", "xp": 4, "needs": [("water", 2)]},
    {"key": "water_3", "xp": 6, "needs": [("water", 3)]},
    {"key": "human_1", "xp": 3, "needs": [("checkins", 1)]},
    {"key": "human_2", "xp": 5, "needs": [("checkins", 2)]},
    {"key": "walk_water", "xp": 7, "needs": [("steps", 4000), ("water", 1.5)]},
    {"key": "rested_runner", "xp": 10, "needs": [("steps", 5000), ("sleep", 7)]},
    {"key": "sleep_water", "xp": 8, "needs": [("sleep", 7), ("water", 2)]},
    {"key": "balanced", "xp": 12, "needs": [("steps", 5000), ("sleep", 7), ("water", 2)]},
    {"key": "steady", "xp": 9, "needs": [("steps", 3000), ("water", 2), ("checkins", 1)]},
    {"key": "power_day", "xp": 15, "needs": [("steps", 8000), ("sleep", 8), ("water", 2)]},
    {"key": "early_bird", "xp": 6, "needs": [("steps", 2500), ("checkins", 1)]},
    {"key": "double_up", "xp": 9, "needs": [("steps", 6000), ("water", 2.5)]},
    {"key": "full_day", "xp": 14, "needs": [("steps", 7500), ("sleep", 7.5), ("water", 2), ("checkins", 1)]},
    {"key": "calm_check", "xp": 4, "needs": [("mood_logs", 1)]},
]
POOL_BY_KEY = {quest["key"]: quest for quest in DAILY_POOL}


def daily_goals(connection) -> list[dict]:
    selected = [r["quest_key"] for r in connection.execute("SELECT quest_key FROM daily_quest_choices ORDER BY id LIMIT 3")
                if r["quest_key"] in POOL_BY_KEY]
    selected = list(dict.fromkeys(selected))[:3]
    remaining = [key for key in POOL_BY_KEY if key not in selected]
    random.Random(date.today().isoformat()).shuffle(remaining)
    return [POOL_BY_KEY[key] for key in (selected + remaining[: 3 - len(selected)])]


def day_totals(connection, user_id: int, day: str) -> dict:
    entry = connection.execute(
        "SELECT COALESCE(SUM(steps),0) steps, COALESCE(SUM(sleep),0) sleep, COALESCE(SUM(water),0) water, "
        "COALESCE(SUM(CASE WHEN COALESCE(source,'human')='human' THEN 1 ELSE 0 END),0) checkins "
        "FROM entries WHERE user_id=? AND entry_date=?", (user_id, day)).fetchone()
    reading_steps = connection.execute(
        "SELECT COALESCE(SUM(steps),0) s FROM readings WHERE user_id=? AND substr(ts,1,10)=? AND source='api'",
        (user_id, day)).fetchone()["s"]
    moods = connection.execute("SELECT COUNT(*) c FROM mood_logs WHERE user_id=? AND substr(ts,1,10)=?", (user_id, day)).fetchone()["c"]
    symptoms = connection.execute("SELECT COUNT(*) c FROM symptom_logs WHERE user_id=? AND substr(ts,1,10)=?", (user_id, day)).fetchone()["c"]
    # A check-in is any manual note of how you are: the measurement form, symptoms or mood.
    return {"steps": float(entry["steps"]) + float(reading_steps), "sleep": float(entry["sleep"]),
            "water": float(entry["water"]), "checkins": float(entry["checkins"]) + float(symptoms) + float(moods),
            "mood_logs": float(moods)}


def goal_progress(connection, user_id: int, award: bool) -> list[dict]:
    today = date.today().isoformat()
    totals = day_totals(connection, user_id, today)
    result = []
    for goal in daily_goals(connection):
        requirements = []
        complete = True
        for metric, target in goal["needs"]:
            progress = totals.get(metric, 0.0)
            done = progress >= target
            complete = complete and done
            requirements.append({"metric": metric, "target": target, "progress": progress, "done": done})
        if complete and award:
            connection.execute(
                "INSERT OR IGNORE INTO achievements(user_id,scope,achievement_key,xp,completed_at) VALUES(?,?,?,?,?)",
                (user_id, "daily", f"{today}:{goal['key']}", goal["xp"], utc_now()))
        result.append({"key": goal["key"], "complete": complete, "requirements": requirements})
    return result


def milestones(connection, user_id: int, award: bool) -> list[dict]:
    totals = connection.execute(
        "SELECT COALESCE(SUM(steps),0) steps, COALESCE(SUM(sleep),0) sleep, COALESCE(SUM(water),0) water, "
        "COALESCE(SUM(CASE WHEN COALESCE(source,'human')='human' THEN 1 ELSE 0 END),0) checkins FROM entries WHERE user_id=?",
        (user_id,)).fetchone()
    reading_steps = connection.execute("SELECT COALESCE(SUM(steps),0) s FROM readings WHERE user_id=? AND source='api'",
                                       (user_id,)).fetchone()["s"]
    all_totals = {"steps": float(totals["steps"]) + float(reading_steps), "sleep": float(totals["sleep"]),
                  "water": float(totals["water"]), "checkins": float(totals["checkins"]) + checkin_logs(connection, user_id)}
    rows = connection.execute("SELECT * FROM long_term_quests WHERE COALESCE(active,1)=1 ORDER BY category,target,id").fetchall()
    out = []
    for row in rows:
        metric = row["metric"] or "checkins"
        progress = all_totals.get(metric, 0.0)
        target = float(row["target"] or 1)
        complete = progress >= target
        if complete and award:
            cursor = connection.execute(
                "INSERT OR IGNORE INTO achievements(user_id,scope,achievement_key,xp,completed_at) VALUES(?,?,?,?,?)",
                (user_id, "ltq", str(row["id"]), int(row["reward"] or 0), utc_now()))
            if cursor.rowcount:
                insert(connection, "notifications", {"user_id": user_id, "kind": "milestone", "reference": str(row["id"]),
                                                    "message": json.dumps({"title": row["title"]}), "created_at": utc_now()})
        out.append({"id": row["id"], "title": row["title"], "metric": metric, "category": row["category"],
                    "target": target, "progress": progress, "complete": complete})
    return out


def checkin_logs(connection, user_id: int) -> float:
    """Symptom and mood logs count as check-ins, next to the manual measurement form."""
    row = connection.execute("SELECT (SELECT COUNT(*) FROM symptom_logs WHERE user_id=?) + (SELECT COUNT(*) FROM mood_logs WHERE user_id=?) n",
                             (user_id, user_id)).fetchone()
    return float(row["n"])


# What a day in "Uw week" can show. Behaviour only, never a health value to beat.
WEEK_KINDS = ("checkin", "mood", "medication", "water", "sleep", "movement")
MANUAL_KINDS = {"checkin", "mood", "medication", "water", "sleep"}
MOVEMENT_STEPS = 2000


def activity_by_day(connection, user_id: int, start: str) -> dict:
    """Which kinds of activity happened on each day since `start` (YYYY-MM-DD)."""
    days: dict = {}

    def mark(sql, kind, params):
        for row in connection.execute(sql, params):
            if row["d"]:
                days.setdefault(row["d"], set()).add(kind)

    mark("SELECT DISTINCT entry_date d FROM entries WHERE user_id=? AND entry_date>=? AND COALESCE(source,'human')='human'", "checkin", (user_id, start))
    mark("SELECT DISTINCT substr(ts,1,10) d FROM symptom_logs WHERE user_id=? AND ts>=?", "checkin", (user_id, start))
    mark("SELECT DISTINCT substr(ts,1,10) d FROM mood_logs WHERE user_id=? AND ts>=?", "mood", (user_id, start))
    mark("SELECT DISTINCT substr(ts,1,10) d FROM medication_logs WHERE user_id=? AND ts>=? AND status='taken'", "medication", (user_id, start))
    mark("SELECT DISTINCT entry_date d FROM entries WHERE user_id=? AND entry_date>=? AND water>0", "water", (user_id, start))
    mark("SELECT DISTINCT entry_date d FROM entries WHERE user_id=? AND entry_date>=? AND sleep>0", "sleep", (user_id, start))
    steps: dict = {}
    for row in connection.execute("SELECT entry_date d, SUM(steps) s FROM entries WHERE user_id=? AND entry_date>=? GROUP BY d", (user_id, start)):
        steps[row["d"]] = steps.get(row["d"], 0) + float(row["s"] or 0)
    for row in connection.execute("SELECT substr(ts,1,10) d, SUM(steps) s FROM readings WHERE user_id=? AND ts>=? AND source='api' GROUP BY d",
                                  (user_id, start)):
        steps[row["d"]] = steps.get(row["d"], 0) + float(row["s"] or 0)
    for d, s in steps.items():
        if d and s >= MOVEMENT_STEPS:
            days.setdefault(d, set()).add("movement")
    return days


def _next_step(today_kinds: set, daily: list) -> dict:
    """One small, doable thing for today, or a calm 'all done'. Never a health value."""
    if not today_kinds & {"checkin", "mood"}:
        return {"kind": "checkin", "href": "/log"}
    for goal in daily:
        if goal["complete"]:
            continue
        for req in goal["requirements"]:
            if req["done"]:
                continue
            if req["metric"] == "mood_logs":
                return {"kind": "mood", "href": "/log?tab=mood", "goal": goal["key"]}
            # Sleep only when nothing is filled in yet: a short night can't be made up during the day.
            if req["metric"] == "water" or (req["metric"] == "sleep" and req["progress"] == 0):
                return {"kind": req["metric"], "href": "/log?tab=measure", "goal": goal["key"],
                        "left": round(req["target"] - req["progress"], 1)}
            if req["metric"] == "checkins":
                return {"kind": "checkin_more", "href": "/log", "goal": goal["key"]}
    # Either everything is reached, or what is left (steps, a night's sleep) the watch counts by itself.
    return {"kind": "done" if all(goal["complete"] for goal in daily) else "rest", "href": None}


def goals_overview(connection, user_id: int, daily: list) -> dict:
    """The Doelen page: the last seven days, a recap against the seven before, totals and the next small step."""
    today = date.today()
    by_day = activity_by_day(connection, user_id, (today - timedelta(days=13)).isoformat())
    week = []
    for offset in range(6, -1, -1):
        d = (today - timedelta(days=offset)).isoformat()
        week.append({"day": d, "kinds": [k for k in WEEK_KINDS if k in by_day.get(d, set())]})

    def logged_days(first, last):
        return sum(1 for offset in range(first, last + 1)
                   if by_day.get((today - timedelta(days=offset)).isoformat(), set()) & MANUAL_KINDS)

    entries = connection.execute("SELECT COUNT(*) n FROM entries WHERE user_id=? AND COALESCE(source,'human')='human'",
                                 (user_id,)).fetchone()["n"]
    all_days = activity_by_day(connection, user_id, "0000-00-00")
    return {
        "week": week,
        "recap": {"days": logged_days(0, 6), "days_last_week": logged_days(7, 13)},
        "totals": {"checkins": int(entries + checkin_logs(connection, user_id)),
                   "days": sum(1 for kinds in all_days.values() if kinds & MANUAL_KINDS)},
        "next": _next_step(by_day.get(today.isoformat(), set()), daily),
    }


def streak(connection, user_id: int) -> int:
    days = {r["d"] for r in connection.execute(
        "SELECT entry_date d FROM entries WHERE user_id=? AND entry_date>=? UNION "
        "SELECT substr(ts,1,10) d FROM readings WHERE user_id=? AND ts>=? UNION "
        "SELECT substr(ts,1,10) d FROM mood_logs WHERE user_id=? AND ts>=?",
        (user_id, (date.today() - timedelta(days=400)).isoformat(),) * 3)}
    cursor = date.today()
    if cursor.isoformat() not in days:
        cursor -= timedelta(days=1)  # today not logged yet doesn't break the streak
    count = 0
    while cursor.isoformat() in days:
        count += 1
        cursor -= timedelta(days=1)
    return count


def level_info(xp_value: int) -> dict:
    level, remaining, needed = 1, int(xp_value), 160
    while remaining >= needed:
        remaining -= needed
        level += 1
        needed = 160 + (level - 1) * 40
    return {"level": level, "xp": int(xp_value), "progress": remaining, "needed": needed}


# ---------- read models ----------

def latest_reading(connection, user_id: int):
    row = connection.execute(
        "SELECT ts,bpm,spo2,temp_c,activity,device FROM readings WHERE user_id=? ORDER BY ts DESC LIMIT 1", (user_id,)).fetchone()
    return dict(row) if row else None


def latest_value(connection, user_id: int, field: str):
    row = connection.execute(
        f"SELECT ts,{field} v FROM readings WHERE user_id=? AND {field} IS NOT NULL ORDER BY ts DESC LIMIT 1", (user_id,)).fetchone()
    return {"ts": row["ts"], "value": row["v"]} if row else None


def open_alerts(connection, user_id: int) -> list[dict]:
    return [dict(r) for r in connection.execute(
        "SELECT id,kind,severity,value,threshold,reading_ts,created_at FROM alerts "
        "WHERE user_id=? AND acknowledged_at IS NULL ORDER BY CASE severity WHEN 'urgent' THEN 0 ELSE 1 END, id DESC LIMIT 10",
        (user_id,))]


def parse_times(raw) -> list[str]:
    try:
        values = json.loads(raw) if raw else []
    except (TypeError, ValueError):
        return []
    return [v for v in values if isinstance(v, str) and len(v) == 5 and v[2] == ":"]


def medication_today(connection, user_id: int) -> list[dict]:
    today = date.today().isoformat()
    meds = connection.execute("SELECT id,name,dose,times_per_day,times FROM medications WHERE user_id=? AND active=1 ORDER BY name",
                              (user_id,)).fetchall()
    out = []
    for med in meds:
        logs = connection.execute(
            "SELECT status,ts FROM medication_logs WHERE user_id=? AND medication_id=? AND substr(ts,1,10)=? ORDER BY ts",
            (user_id, med["id"], today)).fetchall()
        item = {k: med[k] for k in ("id", "name", "dose", "times_per_day")}
        item["times"] = parse_times(med["times"])
        item["taken"] = sum(1 for l in logs if l["status"] == "taken")
        item["skipped"] = sum(1 for l in logs if l["status"] == "skipped")
        out.append(item)
    return out


def pulse(connection, user_id: int, days: int = 7, buckets: int = 96) -> dict:
    """Heart rate per day as `buckets` averages (15 min each by default), oldest day first, for the Pulse Plot."""
    days = max(1, min(days, 31))
    start = (date.today() - timedelta(days=days - 1)).isoformat()
    width = 1440 // buckets
    series = {(date.today() - timedelta(days=offset)).isoformat(): [None] * buckets for offset in range(days)}
    for row in connection.execute(
        "SELECT substr(ts,1,10) d, (CAST(substr(ts,12,2) AS INTEGER)*60 + CAST(substr(ts,15,2) AS INTEGER)) / ? b, AVG(bpm) v "
        "FROM readings WHERE user_id=? AND ts>=? AND bpm IS NOT NULL GROUP BY d, b", (width, user_id, start)):
        if row["d"] in series and 0 <= row["b"] < buckets:
            series[row["d"]][row["b"]] = round(row["v"], 1)
    ordered = [{"day": d, "points": series[d]} for d in sorted(series)]
    return {"days": ordered, "bucket_minutes": width, "thresholds": get_thresholds(connection, user_id)}


def dashboard(connection, user_id: int, award: bool) -> dict:
    latest = latest_reading(connection, user_id)
    last_sync = latest["ts"] if latest else None
    stale = True
    if last_sync:
        stale = parse_ts(last_sync) < now_utc() - timedelta(hours=NO_DATA_HOURS)
    today = date.today().isoformat()
    hr_today = connection.execute(
        "SELECT MIN(bpm) mn, AVG(bpm) av, MAX(bpm) mx, COUNT(bpm) n FROM readings WHERE user_id=? AND substr(ts,1,10)=? AND bpm IS NOT NULL",
        (user_id, today)).fetchone()
    resting = connection.execute(
        "SELECT AVG(bpm) v FROM (SELECT bpm FROM readings WHERE user_id=? AND bpm IS NOT NULL AND ts>=? "
        "AND COALESCE(activity,'rest') IN ('rest','sleep') ORDER BY bpm LIMIT 20)",
        (user_id, iso(now_utc() - timedelta(days=1)))).fetchone()["v"]
    mood = connection.execute("SELECT stress,mood,ts FROM mood_logs WHERE user_id=? ORDER BY ts DESC LIMIT 1", (user_id,)).fetchone()
    xp = connection.execute("SELECT COALESCE(SUM(xp),0) x FROM achievements WHERE user_id=?", (user_id,)).fetchone()["x"]
    return {
        "server_date": today,
        "latest": latest,
        "latest_spo2": latest_value(connection, user_id, "spo2"),
        "latest_temp": latest_value(connection, user_id, "temp_c"),
        "last_sync": last_sync,
        "stale": stale,
        "thresholds": get_thresholds(connection, user_id),
        "alerts": open_alerts(connection, user_id),
        "today": day_totals(connection, user_id, today) | {
            "bpm_min": hr_today["mn"], "bpm_avg": hr_today["av"], "bpm_max": hr_today["mx"], "bpm_count": hr_today["n"],
            "resting_bpm": resting},
        "goals": goal_progress(connection, user_id, award),
        "streak": streak(connection, user_id),
        "medication": medication_today(connection, user_id),
        "mood": dict(mood) if mood else None,
        "level": level_info(xp),
    }


RANGES = {"24h": 1, "7d": 7, "30d": 30, "90d": 90}


def trends(connection, user_id: int, range_key: str) -> dict:
    days = RANGES.get(range_key, 7)
    start_dt = now_utc() - timedelta(days=days)
    start_day = (date.today() - timedelta(days=days - 1)).isoformat()
    if range_key == "24h":
        points = [dict(r) for r in connection.execute(
            "SELECT ts,bpm,spo2,temp_c,steps FROM readings WHERE user_id=? AND ts>=? ORDER BY ts", (user_id, iso(start_dt)))]
        return {"range": range_key, "granularity": "reading", "points": points[-1500:], "thresholds": get_thresholds(connection, user_id)}
    daily = {}
    for r in connection.execute(
        "SELECT substr(ts,1,10) d, MIN(bpm) bmin, AVG(bpm) bavg, MAX(bpm) bmax, AVG(spo2) spo2, MIN(spo2) spo2min, "
        "MAX(temp_c) temp, SUM(CASE WHEN source='api' THEN COALESCE(steps,0) ELSE 0 END) rsteps "
        "FROM readings WHERE user_id=? AND ts>=? GROUP BY d", (user_id, start_day)):
        daily[r["d"]] = {"bpm_min": r["bmin"], "bpm_avg": r["bavg"], "bpm_max": r["bmax"], "spo2": r["spo2"],
                         "spo2_min": r["spo2min"], "temp": r["temp"], "steps": float(r["rsteps"] or 0)}
    for r in connection.execute(
        "SELECT entry_date d, SUM(steps) steps, SUM(sleep) sleep, SUM(water) water, AVG(weight) weight "
        "FROM entries WHERE user_id=? AND entry_date>=? GROUP BY d", (user_id, start_day)):
        item = daily.setdefault(r["d"], {})
        item["steps"] = item.get("steps", 0.0) + float(r["steps"] or 0)
        item.update({"sleep": r["sleep"], "water": r["water"], "weight": r["weight"]})
    for r in connection.execute(
        "SELECT substr(ts,1,10) d, AVG(stress) stress, AVG(mood) mood FROM mood_logs WHERE user_id=? AND ts>=? GROUP BY d",
        (user_id, start_day)):
        daily.setdefault(r["d"], {}).update({"stress": r["stress"], "mood": r["mood"]})
    series = [dict(day=d, **daily[d]) for d in sorted(daily)]
    return {"range": range_key, "granularity": "day", "days": series, "thresholds": get_thresholds(connection, user_id)}


def history_page(connection, user_id: int, kind: str, offset: int = 0, limit: int = 60) -> dict:
    """One page of the combined timeline; fetches offset+limit+1 per source so `has_more` is exact."""
    rows = history(connection, user_id, kind, offset + limit + 1)
    return {"items": rows[offset:offset + limit], "has_more": len(rows) > offset + limit, "next_offset": offset + limit}


def history(connection, user_id: int, kind: str, limit: int = 200) -> list[dict]:
    items = []
    if kind in ("all", "checkins"):
        for r in connection.execute(
            "SELECT id,entry_date,entry_time,steps,sleep,water,weight,bpm,spo2,notes,source,created_at FROM entries "
            "WHERE user_id=? ORDER BY entry_date DESC, entry_time DESC, id DESC LIMIT ?", (user_id, limit)):
            items.append({"type": "checkin", "ts": f"{r['entry_date']}T{(r['entry_time'] or '00:00')}:00", **dict(r)})
    if kind in ("all", "symptoms"):
        for r in connection.execute("SELECT id,ts,symptoms,custom,severity,notes FROM symptom_logs WHERE user_id=? ORDER BY ts DESC LIMIT ?",
                                    (user_id, limit)):
            items.append({"type": "symptom", **dict(r), "symptoms": json.loads(r["symptoms"])})
    if kind in ("all", "mood"):
        for r in connection.execute("SELECT id,ts,stress,mood,notes FROM mood_logs WHERE user_id=? ORDER BY ts DESC LIMIT ?",
                                    (user_id, limit)):
            items.append({"type": "mood", **dict(r)})
    if kind in ("all", "medication"):
        for r in connection.execute(
            "SELECT l.id,l.ts,l.status,m.name,m.dose FROM medication_logs l JOIN medications m ON m.id=l.medication_id "
            "WHERE l.user_id=? ORDER BY l.ts DESC LIMIT ?", (user_id, limit)):
            items.append({"type": "medication", **dict(r)})
    if kind in ("all", "alerts"):
        for r in connection.execute(
            "SELECT id,kind,severity,value,threshold,reading_ts,created_at,acknowledged_at FROM alerts WHERE user_id=? "
            "ORDER BY id DESC LIMIT ?", (user_id, limit)):
            items.append({"type": "alert", "ts": r["reading_ts"] or r["created_at"], **dict(r)})
    items.sort(key=lambda item: item.get("ts") or "", reverse=True)
    return items[:limit]


def report(connection, user_id: int, start: str, end: str) -> dict:
    """Doctor report for [start, end] inclusive (YYYY-MM-DD)."""
    end_next = (date.fromisoformat(end) + timedelta(days=1)).isoformat()
    hr = connection.execute(
        "SELECT MIN(bpm) mn, AVG(bpm) av, MAX(bpm) mx, COUNT(bpm) n, AVG(spo2) spo2, MIN(spo2) spo2min, MAX(temp_c) tmax "
        "FROM readings WHERE user_id=? AND ts>=? AND ts<?", (user_id, start, end_next)).fetchone()
    alerts = [dict(r) for r in connection.execute(
        "SELECT kind,severity,value,threshold,reading_ts,created_at,acknowledged_at FROM alerts "
        "WHERE user_id=? AND created_at>=? AND created_at<? ORDER BY created_at", (user_id, start, end_next))]
    symptoms = [dict(r) | {"symptoms": json.loads(r["symptoms"])} for r in connection.execute(
        "SELECT ts,symptoms,custom,severity,notes FROM symptom_logs WHERE user_id=? AND ts>=? AND ts<? ORDER BY ts",
        (user_id, start, end_next))]
    mood = connection.execute("SELECT AVG(stress) stress, AVG(mood) mood, COUNT(*) n FROM mood_logs WHERE user_id=? AND ts>=? AND ts<?",
                              (user_id, start, end_next)).fetchone()
    meds = []
    span = (date.fromisoformat(end) - date.fromisoformat(start)).days + 1
    for med in connection.execute("SELECT id,name,dose,times_per_day FROM medications WHERE user_id=?", (user_id,)).fetchall():
        logs = connection.execute(
            "SELECT status, COUNT(*) c FROM medication_logs WHERE user_id=? AND medication_id=? AND ts>=? AND ts<? GROUP BY status",
            (user_id, med["id"], start, end_next)).fetchall()
        counts = {row["status"]: row["c"] for row in logs}
        meds.append({"name": med["name"], "dose": med["dose"], "expected": span * int(med["times_per_day"] or 1),
                     "taken": counts.get("taken", 0), "skipped": counts.get("skipped", 0)})
    days = trends_between(connection, user_id, start, end_next)
    return {"start": start, "end": end, "heart": dict(hr), "alerts": alerts, "symptoms": symptoms, "mood": dict(mood),
            "medication": meds, "days": days, "thresholds": get_thresholds(connection, user_id)}


def trends_between(connection, user_id: int, start: str, end_next: str) -> list[dict]:
    rows = connection.execute(
        "SELECT substr(ts,1,10) d, MIN(bpm) bmin, AVG(bpm) bavg, MAX(bpm) bmax, MIN(spo2) spo2min FROM readings "
        "WHERE user_id=? AND ts>=? AND ts<? GROUP BY d ORDER BY d", (user_id, start, end_next)).fetchall()
    return [{"day": r["d"], "bpm_min": r["bmin"], "bpm_avg": r["bavg"], "bpm_max": r["bmax"], "spo2_min": r["spo2min"]} for r in rows]
