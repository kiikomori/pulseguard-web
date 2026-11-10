"""Browser JSON API (cookie session). Every state change is CSRF-checked in create_app."""
from __future__ import annotations

import csv
import io
import json
from datetime import date, datetime, timedelta

from flask import Blueprint, Response, abort, g, jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash

from . import config, health
from .db import get_db, insert, make_friend_code, utc_now, write_tx
from .security import (
    admin_required, audit, client_ip, current_user, hash_token, json_body, login_required, new_token, num,
    password_problem, rate_limit, reset_limit, start_session, text, too_many,
)

bp = Blueprint("api", __name__, url_prefix="/api")

LANGS, THEMES, SIZES = ("nl", "en"), ("system", "light", "dark"), ("normal", "large", "xlarge")


def public_user(row) -> dict:
    return {
        "id": row["id"], "name": row["name"], "username": row["username"], "admin": bool(row["is_admin"]),
        "language": row["language"], "theme": row["theme"], "text_size": row["text_size"],
        "must_change_password": bool(row["must_change_password"]), "consent": bool(row["consent_at"]),
    }


@bp.errorhandler(400)
def bad_request(error):
    return jsonify(error=getattr(error, "description", "bad_request") or "bad_request"), 400


# ---------- auth ----------

@bp.post("/signup")
def signup():
    payload = json_body({"name", "username", "password", "consent", "language"})
    if not rate_limit(f"signup:ip:{client_ip()}", 5, 3600):
        return too_many()
    name = text(payload.get("name"), 80, "name", required=True)
    username = text(payload.get("username"), 40, "username", required=True).lower()
    if len(username) < 3 or not all(c.isalnum() or c in "._-" for c in username):
        abort(400, "invalid_username")
    password = str(payload.get("password") or "")
    problem = password_problem(password, username)
    if problem:
        abort(400, problem)
    if payload.get("consent") is not True:
        abort(400, "consent_required")
    language = payload.get("language") if payload.get("language") in LANGS else "nl"
    connection = get_db()
    with write_tx():
        if connection.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
            abort(400, "username_taken")
        user_id = insert(connection, "users", {
            "name": name, "username": username, "password_hash": generate_password_hash(password),
            "created_at": utc_now(), "friend_code": make_friend_code(connection), "language": language,
            "consent_at": utc_now(), "consent_version": config.CONSENT_VERSION, "last_login_at": utc_now(),
        })
        audit("account.created", user_id, user_id, {"consent_version": config.CONSENT_VERSION})
    start_session(connection.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone())
    return jsonify(ok=True)


@bp.post("/login")
def login():
    payload = json_body({"username", "password"})
    username = str(payload.get("username") or "").strip().lower()[:40]
    password = str(payload.get("password") or "")[: config.PASSWORD_MAX]
    if not rate_limit(f"login:ip:{client_ip()}", 30, 900) or not rate_limit(f"login:acct:{username}", 6, 900):
        return too_many()
    connection = get_db()
    row = connection.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    # Always run one hash check so unknown usernames take the same time.
    ok = check_password_hash(row["password_hash"] if row else DUMMY_HASH, password) and row is not None
    if not ok:
        with write_tx():
            audit("login.failed", row["id"] if row else None, None, {"username_known": row is not None})
        return jsonify(error="invalid_credentials"), 401
    reset_limit(f"login:acct:{username}")
    with write_tx():
        if password == config.LEGACY_DEFAULT_ADMIN_PASSWORD:
            connection.execute("UPDATE users SET must_change_password=1 WHERE id=?", (row["id"],))
        connection.execute("UPDATE users SET last_login_at=? WHERE id=?", (utc_now(), row["id"]))
        audit("login.ok", row["id"], row["id"])
    start_session(connection.execute("SELECT * FROM users WHERE id=?", (row["id"],)).fetchone())
    return jsonify(ok=True)


DUMMY_HASH = generate_password_hash("timing-equaliser-not-a-real-password")


@bp.post("/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@bp.get("/me")
@login_required
def me():
    connection = get_db()
    unread = connection.execute("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read_at IS NULL",
                                (g.user["id"],)).fetchone()["c"]
    caring = connection.execute(
        "SELECT g.owner_id id, u.name FROM care_grants g JOIN users u ON u.id=g.owner_id "
        "WHERE g.caregiver_id=? AND g.revoked_at IS NULL ORDER BY u.name", (g.user["id"],)).fetchall()
    return jsonify(public_user(g.user) | {
        "unread": unread, "caring_for": [dict(r) for r in caring],
        "session": {"idle_minutes": config.SESSION_IDLE_MINUTES},
    })


@bp.post("/session/ping")
@login_required
def ping():
    return jsonify(ok=True)


# ---------- account ----------

@bp.post("/account/profile")
@login_required
def update_profile():
    payload = json_body({"name", "language", "theme", "text_size"})
    updates = {}
    if "name" in payload:
        updates["name"] = text(payload["name"], 80, "name", required=True)
    for field, allowed in (("language", LANGS), ("theme", THEMES), ("text_size", SIZES)):
        if field in payload:
            if payload[field] not in allowed:
                abort(400, f"invalid_{field}")
            updates[field] = payload[field]
    if updates:
        with write_tx() as connection:
            sets = ",".join(f"{k}=?" for k in updates)
            connection.execute(f"UPDATE users SET {sets} WHERE id=?", (*updates.values(), g.user["id"]))
    return jsonify(ok=True)


@bp.post("/account/password")
@login_required
def change_password():
    payload = json_body({"current", "new"})
    if not rate_limit(f"pwchange:{g.user['id']}", 10, 3600):
        return too_many()
    if not check_password_hash(g.user["password_hash"], str(payload.get("current") or "")):
        return jsonify(error="wrong_current_password"), 400
    new = str(payload.get("new") or "")
    problem = password_problem(new, g.user["username"])
    if problem:
        abort(400, problem)
    if check_password_hash(g.user["password_hash"], new):
        abort(400, "password_unchanged")
    with write_tx() as connection:
        connection.execute(
            "UPDATE users SET password_hash=?, must_change_password=0, session_version=session_version+1 WHERE id=?",
            (generate_password_hash(new), g.user["id"]))
        audit("password.changed", g.user["id"], g.user["id"])
        user = connection.execute("SELECT * FROM users WHERE id=?", (g.user["id"],)).fetchone()
    start_session(user)  # this browser stays signed in; every other session ends
    return jsonify(ok=True)


@bp.post("/account/logout-everywhere")
@login_required
def logout_everywhere():
    with write_tx() as connection:
        connection.execute("UPDATE users SET session_version=session_version+1 WHERE id=?", (g.user["id"],))
        audit("sessions.revoked", g.user["id"], g.user["id"])
    session.clear()
    return jsonify(ok=True)


@bp.post("/account/delete")
@login_required
def delete_account():
    payload = json_body({"password"})
    if g.user["is_admin"]:
        abort(400, "admin_cannot_delete")
    if not check_password_hash(g.user["password_hash"], str(payload.get("password") or "")):
        return jsonify(error="wrong_current_password"), 400
    uid = g.user["id"]
    with write_tx() as connection:
        for table in ("entries", "notifications", "achievements", "readings", "alerts", "symptom_logs", "mood_logs",
                      "medication_logs", "medications", "thresholds", "api_keys", "api_requests"):
            connection.execute(f"DELETE FROM {table} WHERE user_id=?", (uid,))
        connection.execute("DELETE FROM care_invites WHERE owner_id=?", (uid,))
        connection.execute("DELETE FROM care_grants WHERE owner_id=? OR caregiver_id=?", (uid, uid))
        connection.execute("DELETE FROM friend_links WHERE user_low=? OR user_high=?", (uid, uid))
        connection.execute("DELETE FROM users WHERE id=?", (uid,))
        audit("account.deleted", uid, uid)  # no personal data in the record
    session.clear()
    return jsonify(ok=True)


@bp.get("/account/audit")
@login_required
def my_audit():
    rows = get_db().execute(
        "SELECT a.action, a.created_at, a.ip, a.actor_id, u.name actor_name FROM audit_log a "
        "LEFT JOIN users u ON u.id=a.actor_id WHERE a.user_id=? ORDER BY a.id DESC LIMIT 100", (g.user["id"],)).fetchall()
    return jsonify(events=[dict(r) for r in rows])


# ---------- API keys ----------

@bp.get("/keys")
@login_required
def list_keys():
    rows = get_db().execute(
        "SELECT id,name,prefix,created_at,last_used_at FROM api_keys WHERE user_id=? AND revoked_at IS NULL ORDER BY id",
        (g.user["id"],)).fetchall()
    return jsonify(keys=[dict(r) for r in rows])


@bp.post("/keys")
@login_required
def create_key():
    """One API key per account: making a new one revokes the old one(s). The key is shown once."""
    payload = json_body({"name"})
    name = text(payload.get("name") or "API", 40, "name")
    token = new_token("pg_")
    with write_tx() as connection:
        revoked = connection.execute("UPDATE api_keys SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",
                                     (utc_now(), g.user["id"])).rowcount
        insert(connection, "api_keys", {"user_id": g.user["id"], "name": name, "prefix": token[:7],
                                        "key_hash": hash_token(token), "created_at": utc_now()})
        audit("api_key.regenerated" if revoked else "api_key.created", g.user["id"], g.user["id"], {"revoked": revoked})
    return jsonify(key=token, prefix=token[:7])  # shown once


@bp.delete("/keys")
@login_required
def revoke_all_keys():
    with write_tx() as connection:
        revoked = connection.execute("UPDATE api_keys SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",
                                     (utc_now(), g.user["id"])).rowcount
        if revoked:
            audit("api_key.revoked", g.user["id"], g.user["id"], {"count": revoked})
    return jsonify(ok=True, revoked=revoked)


@bp.get("/developer")
@login_required
def developer():
    """The API page: the active key (never the key itself), what arrived, and the latest readings from the API."""
    from .watch import MAX_BATCH, PER_HOUR
    connection = get_db()
    uid = g.user["id"]
    key = connection.execute("SELECT id,prefix,created_at,last_used_at FROM api_keys WHERE user_id=? AND revoked_at IS NULL "
                             "ORDER BY id DESC LIMIT 1", (uid,)).fetchone()
    requests_ = []
    for row in connection.execute("SELECT id,ts,method,path,status,accepted,duplicates,rejected,error,errors,fields,devices,"
                                  "first_ts,last_ts FROM api_requests WHERE user_id=? ORDER BY id DESC LIMIT 50", (uid,)):
        item = dict(row)
        item["errors"] = json.loads(item["errors"]) if item["errors"] else []
        requests_.append(item)
    readings = connection.execute("SELECT ts,device,bpm,spo2,temp_c,steps,activity,created_at FROM readings "
                                  "WHERE user_id=? AND source='api' ORDER BY created_at DESC, ts DESC LIMIT 25", (uid,)).fetchall()
    since = (datetime.fromisoformat(utc_now()) - timedelta(hours=24)).isoformat(timespec="seconds")
    day = connection.execute("SELECT COUNT(*) n, COALESCE(SUM(accepted),0) a FROM api_requests WHERE user_id=? AND ts>=?",
                             (uid, since)).fetchone()
    return jsonify(key=dict(key) if key else None, requests=requests_, readings=[dict(r) for r in readings],
                   last_24h={"requests": day["n"], "accepted": day["a"]},
                   limits={"max_batch": MAX_BATCH, "per_hour": PER_HOUR})


@bp.delete("/developer/requests")
@login_required
def clear_requests():
    with write_tx() as connection:
        connection.execute("DELETE FROM api_requests WHERE user_id=?", (g.user["id"],))
        audit("api_log.cleared", g.user["id"], g.user["id"], {})
    return jsonify(ok=True)


@bp.delete("/keys/<int:key_id>")
@login_required
def revoke_key(key_id):
    with write_tx() as connection:
        cursor = connection.execute("UPDATE api_keys SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL",
                                    (utc_now(), key_id, g.user["id"]))
        if cursor.rowcount:
            audit("api_key.revoked", g.user["id"], g.user["id"], {"id": key_id})
    return jsonify(ok=True)


# ---------- thresholds and alerts ----------

@bp.get("/thresholds")
@login_required
def get_thresholds():
    return jsonify(health.get_thresholds(get_db(), g.user["id"]) | {"defaults": health.DEFAULT_THRESHOLDS,
                                                                   "limits": health.THRESHOLD_LIMITS})


@bp.put("/thresholds")
@login_required
def put_thresholds():
    payload = json_body(set(health.DEFAULT_THRESHOLDS))
    values = {}
    for field, (low, high) in health.THRESHOLD_LIMITS.items():
        values[field] = num(payload.get(field), low, high, field, required=True)
    if values["bpm_low"] >= values["bpm_high"]:
        abort(400, "bpm_low_above_high")
    with write_tx() as connection:
        connection.execute(
            "INSERT INTO thresholds(user_id,bpm_low,bpm_high,spo2_low,temp_high,updated_at) VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(user_id) DO UPDATE SET bpm_low=excluded.bpm_low,bpm_high=excluded.bpm_high,"
            "spo2_low=excluded.spo2_low,temp_high=excluded.temp_high,updated_at=excluded.updated_at",
            (g.user["id"], values["bpm_low"], values["bpm_high"], values["spo2_low"], values["temp_high"], utc_now()))
        audit("thresholds.changed", g.user["id"], g.user["id"], values)
    return jsonify(ok=True)


@bp.post("/alerts/<int:alert_id>/ack")
@login_required
def ack_alert(alert_id):
    with write_tx() as connection:
        connection.execute("UPDATE alerts SET acknowledged_at=? WHERE id=? AND user_id=? AND acknowledged_at IS NULL",
                           (utc_now(), alert_id, g.user["id"]))
    return jsonify(ok=True)


# ---------- read models ----------

@bp.get("/dashboard")
@login_required
def dashboard():
    with write_tx() as connection:  # awards goals/milestones, so it writes
        data = health.dashboard(connection, g.user["id"], award=True)
        health.milestones(connection, g.user["id"], award=True)
    return jsonify(data)


@bp.get("/trends")
@login_required
def trends():
    return jsonify(health.trends(get_db(), g.user["id"], request.args.get("range", "7d")))


def _history_args():
    kind = request.args.get("type", "all")
    if kind not in ("all", "checkins", "symptoms", "mood", "medication", "alerts"):
        abort(400, "invalid_type")
    try:
        offset = max(0, min(int(request.args.get("offset", 0)), 5000))
    except ValueError:
        abort(400, "invalid_offset")
    return kind, offset


@bp.get("/history")
@login_required
def history():
    kind, offset = _history_args()
    return jsonify(health.history_page(get_db(), g.user["id"], kind, offset))


@bp.get("/pulse")
@login_required
def pulse():
    try:
        days = int(request.args.get("days", 7))
    except ValueError:
        abort(400, "invalid_days")
    return jsonify(health.pulse(get_db(), g.user["id"], days))


@bp.get("/goals")
@login_required
def goals():
    connection = get_db()
    xp = connection.execute("SELECT COALESCE(SUM(xp),0) x FROM achievements WHERE user_id=?", (g.user["id"],)).fetchone()["x"]
    daily = health.goal_progress(connection, g.user["id"], award=False)
    return jsonify(daily=daily, overview=health.goals_overview(connection, g.user["id"], daily),
                   milestones=health.milestones(connection, g.user["id"], award=False),
                   streak=health.streak(connection, g.user["id"]), level=health.level_info(xp))


# ---------- manual logging ----------

@bp.post("/entries")
@login_required
def add_entry():
    payload = json_body({"date", "time", "steps", "sleep", "water", "weight", "bpm", "spo2", "notes"})
    try:
        with write_tx() as connection:
            result = health.store_entry(connection, g.user["id"], payload, "human")
    except ValueError as error:
        abort(400, str(error))
    return jsonify(ok=True, **result)


def _log_ts(payload) -> str:
    raw = payload.get("ts")
    if not raw:
        return health.iso(health.now_utc())
    try:
        ts = health.parse_ts(raw)
    except ValueError:
        abort(400, "invalid_ts")
    if ts > health.now_utc() + timedelta(minutes=5) or ts < health.now_utc() - timedelta(days=60):
        abort(400, "invalid_ts")
    return health.iso(ts)


@bp.post("/symptoms")
@login_required
def add_symptoms():
    payload = json_body({"symptoms", "severity", "notes", "ts", "custom"})
    custom = text(payload.get("custom"), 80, "custom")       # an own symptom, typed by the user
    items = payload.get("symptoms") if payload.get("symptoms") is not None else []
    if not isinstance(items, list) or any(s not in health.SYMPTOMS for s in items):
        abort(400, "invalid_symptoms")
    if custom and "other" not in items:
        items = items + ["other"]      # keeps older views meaningful: an own symptom is "something else"
    if not items:
        abort(400, "invalid_symptoms")
    severity = int(num(payload.get("severity"), 1, 5, "severity", required=True))
    with write_tx() as connection:
        insert(connection, "symptom_logs", {"user_id": g.user["id"], "ts": _log_ts(payload),
                                            "symptoms": json.dumps(sorted(set(items))), "severity": severity,
                                            "notes": text(payload.get("notes"), 1000, "notes"), "custom": custom or None,
                                            "created_at": utc_now()})
    urgent = "chest_pain" in items or "short_breath" in items or health.sounds_urgent(custom)
    # Free text can be serious too: the 112 advice also shows for an own symptom rated 5 ("heel erg").
    return jsonify(ok=True, show_emergency=(urgent and severity >= 3) or (bool(custom) and severity >= 5))


@bp.post("/mood")
@login_required
def add_mood():
    payload = json_body({"stress", "mood", "notes", "ts"})
    stress = num(payload.get("stress"), 1, 5, "stress")
    mood = num(payload.get("mood"), 1, 5, "mood")
    if stress is None and mood is None:
        abort(400, "missing_stress")
    with write_tx() as connection:
        insert(connection, "mood_logs", {"user_id": g.user["id"], "ts": _log_ts(payload),
                                         "stress": int(stress) if stress else None, "mood": int(mood) if mood else None,
                                         "notes": text(payload.get("notes"), 1000, "notes"), "created_at": utc_now()})
    return jsonify(ok=True)


@bp.get("/medications")
@login_required
def list_medications():
    rows = get_db().execute("SELECT id,name,dose,times_per_day,times,active FROM medications WHERE user_id=? ORDER BY active DESC,name",
                            (g.user["id"],)).fetchall()
    meds = [dict(r) | {"times": health.parse_times(r["times"])} for r in rows]
    return jsonify(medications=meds, today=health.medication_today(get_db(), g.user["id"]))


def _dose_times(value, count):
    if value is None:
        return None
    if not isinstance(value, list) or len(value) > 6:
        abort(400, "invalid_times")
    cleaned = []
    for item in value:
        text_value = str(item or "").strip()
        if len(text_value) != 5 or text_value[2] != ":" or not text_value.replace(":", "").isdigit():
            abort(400, "invalid_times")
        hours, minutes = int(text_value[:2]), int(text_value[3:])
        if hours > 23 or minutes > 59:
            abort(400, "invalid_times")
        cleaned.append(text_value)
    return json.dumps(sorted(set(cleaned)))


@bp.post("/medications")
@login_required
def add_medication():
    payload = json_body({"name", "dose", "times_per_day", "times"})
    with write_tx() as connection:
        count = connection.execute("SELECT COUNT(*) c FROM medications WHERE user_id=? AND active=1", (g.user["id"],)).fetchone()["c"]
        if count >= 30:
            abort(400, "too_many_medications")
        insert(connection, "medications", {"user_id": g.user["id"], "name": text(payload.get("name"), 80, "name", required=True),
                                           "dose": text(payload.get("dose"), 60, "dose"),
                                           "times_per_day": int(num(payload.get("times_per_day") or len(payload.get("times") or []) or 1, 1, 6, "times_per_day")),
                                           "times": _dose_times(payload.get("times"), None),
                                           "created_at": utc_now()})
    return jsonify(ok=True)


@bp.put("/medications/<int:med_id>/times")
@login_required
def set_medication_times(med_id):
    payload = json_body({"times"})
    times = _dose_times(payload.get("times") or [], None)
    count = max(1, len(json.loads(times)))
    with write_tx() as connection:
        cursor = connection.execute("UPDATE medications SET times=?, times_per_day=? WHERE id=? AND user_id=? AND active=1",
                                    (times, count, med_id, g.user["id"]))
        if not cursor.rowcount:
            abort(404)
    return jsonify(ok=True)


@bp.delete("/medications/<int:med_id>")
@login_required
def archive_medication(med_id):
    with write_tx() as connection:
        connection.execute("UPDATE medications SET active=0 WHERE id=? AND user_id=?", (med_id, g.user["id"]))
    return jsonify(ok=True)


@bp.post("/medications/<int:med_id>/log")
@login_required
def log_medication(med_id):
    payload = json_body({"status", "ts"})
    if payload.get("status") not in ("taken", "skipped"):
        abort(400, "invalid_status")
    with write_tx() as connection:
        if not connection.execute("SELECT 1 FROM medications WHERE id=? AND user_id=? AND active=1", (med_id, g.user["id"])).fetchone():
            abort(404)
        insert(connection, "medication_logs", {"user_id": g.user["id"], "medication_id": med_id, "ts": _log_ts(payload),
                                               "status": payload["status"], "created_at": utc_now()})
    return jsonify(ok=True)


# ---------- notifications ----------

@bp.get("/notifications")
@login_required
def notifications():
    rows = get_db().execute("SELECT id,kind,reference,message,created_at,read_at FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 200",
                            (g.user["id"],)).fetchall()
    return jsonify(notifications=[dict(r) for r in rows])


@bp.post("/notifications/read")
@login_required
def read_notifications():
    with write_tx() as connection:
        connection.execute("UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL", (utc_now(), g.user["id"]))
    return jsonify(ok=True)


# ---------- exports ----------

def _period():
    try:
        end = date.fromisoformat(request.args.get("end") or date.today().isoformat())
        start = date.fromisoformat(request.args.get("start") or (end - timedelta(days=29)).isoformat())
    except ValueError:
        abort(400, "invalid_period")
    if start > end or (end - start).days > 366:
        abort(400, "invalid_period")
    return start.isoformat(), end.isoformat()


def _export_allowed(user_id):
    return rate_limit(f"export:{user_id}", 30, 3600)


@bp.get("/export.csv")
@login_required
def export_csv():
    if not _export_allowed(g.user["id"]):
        return too_many()
    start, end = _period()
    end_next = (date.fromisoformat(end) + timedelta(days=1)).isoformat()
    connection = get_db()
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["type", "timestamp", "bpm", "spo2", "temp_c", "steps", "sleep_h", "water_l", "weight_kg",
                     "stress", "mood", "symptoms", "severity", "medication", "status", "notes"])
    for r in connection.execute("SELECT ts,bpm,spo2,temp_c,steps FROM readings WHERE user_id=? AND ts>=? AND ts<? ORDER BY ts",
                                (g.user["id"], start, end_next)):
        writer.writerow(["reading", r["ts"], r["bpm"], r["spo2"], r["temp_c"], r["steps"], "", "", "", "", "", "", "", "", "", ""])
    for r in connection.execute("SELECT * FROM entries WHERE user_id=? AND entry_date>=? AND entry_date<=? ORDER BY entry_date",
                                (g.user["id"], start, end)):
        writer.writerow(["checkin", f"{r['entry_date']}T{r['entry_time'] or '00:00'}", r["bpm"], r["spo2"], "", r["steps"], r["sleep"],
                         r["water"], r["weight"], "", "", "", "", "", "", _csv_safe(r["notes"])])
    for r in connection.execute("SELECT * FROM mood_logs WHERE user_id=? AND ts>=? AND ts<? ORDER BY ts", (g.user["id"], start, end_next)):
        writer.writerow(["mood", r["ts"], "", "", "", "", "", "", "", r["stress"], r["mood"], "", "", "", "", _csv_safe(r["notes"])])
    for r in connection.execute("SELECT * FROM symptom_logs WHERE user_id=? AND ts>=? AND ts<? ORDER BY ts", (g.user["id"], start, end_next)):
        listed = " ".join(json.loads(r["symptoms"])) + (f" ({r['custom']})" if r["custom"] else "")
        writer.writerow(["symptom", r["ts"], "", "", "", "", "", "", "", "", "", _csv_safe(listed), r["severity"],
                         "", "", _csv_safe(r["notes"])])
    for r in connection.execute("SELECT l.ts,l.status,m.name FROM medication_logs l JOIN medications m ON m.id=l.medication_id "
                                "WHERE l.user_id=? AND l.ts>=? AND l.ts<? ORDER BY l.ts", (g.user["id"], start, end_next)):
        writer.writerow(["medication", r["ts"], "", "", "", "", "", "", "", "", "", "", "", _csv_safe(r["name"]), r["status"], ""])
    with write_tx():
        audit("export.csv", g.user["id"], g.user["id"], {"start": start, "end": end})
    return Response("﻿" + buffer.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="pulseguard-{start}-{end}.csv"'})


def _csv_safe(value):
    """Neutralise spreadsheet formula injection (=, +, -, @ at the start of a cell)."""
    value = str(value or "")
    return "'" + value if value[:1] in ("=", "+", "-", "@", "\t", "\r") else value


@bp.get("/export.json")
@login_required
def export_json():
    if not _export_allowed(g.user["id"]):
        return too_many()
    uid = g.user["id"]
    connection = get_db()

    def rows(sql):
        return [dict(r) for r in connection.execute(sql, (uid,))]

    data = {
        "format": "pulseguard-export/1", "exported_at": utc_now(),
        "account": {k: g.user[k] for k in ("name", "username", "created_at", "language", "consent_at", "consent_version")},
        "thresholds": health.get_thresholds(connection, uid),
        "readings": rows("SELECT ts,device,bpm,spo2,temp_c,steps,activity,source FROM readings WHERE user_id=? ORDER BY ts"),
        "checkins": rows("SELECT entry_date,entry_time,steps,sleep,water,weight,bpm,spo2,notes,source FROM entries WHERE user_id=? ORDER BY entry_date"),
        "symptoms": rows("SELECT ts,symptoms,custom,severity,notes FROM symptom_logs WHERE user_id=? ORDER BY ts"),
        "mood": rows("SELECT ts,stress,mood,notes FROM mood_logs WHERE user_id=? ORDER BY ts"),
        "medications": rows("SELECT id,name,dose,times_per_day,times,active,created_at FROM medications WHERE user_id=?"),
        "medication_logs": rows("SELECT medication_id,ts,status FROM medication_logs WHERE user_id=? ORDER BY ts"),
        "alerts": rows("SELECT kind,severity,value,threshold,reading_ts,created_at,acknowledged_at FROM alerts WHERE user_id=? ORDER BY id"),
        "care_grants": rows("SELECT label,created_at,revoked_at FROM care_grants WHERE owner_id=?"),
        "audit_log": rows("SELECT action,created_at,ip FROM audit_log WHERE user_id=? ORDER BY id"),
    }
    for item in data["symptoms"]:
        item["symptoms"] = json.loads(item["symptoms"])
    with write_tx():
        audit("export.json", uid, uid)
    return Response(json.dumps(data, ensure_ascii=False, indent=1), mimetype="application/json",
                    headers={"Content-Disposition": f'attachment; filename="pulseguard-export-{date.today().isoformat()}.json"'})


@bp.get("/report")
@login_required
def report():
    start, end = _period()
    with write_tx() as connection:
        audit("report.viewed", g.user["id"], g.user["id"], {"start": start, "end": end})
    return jsonify(health.report(get_db(), g.user["id"], start, end) | {"patient": {"name": g.user["name"]}})


# ---------- caregiver access ----------

@bp.get("/care")
@login_required
def care_overview():
    connection = get_db()
    uid = g.user["id"]
    grants = connection.execute(
        "SELECT g.id, g.label, g.created_at, u.name caregiver_name, u.username caregiver_username, "
        "(SELECT MAX(created_at) FROM audit_log a WHERE a.user_id=g.owner_id AND a.actor_id=g.caregiver_id AND a.action='care.viewed') last_viewed "
        "FROM care_grants g JOIN users u ON u.id=g.caregiver_id WHERE g.owner_id=? AND g.revoked_at IS NULL ORDER BY g.id", (uid,)).fetchall()
    invites = connection.execute(
        "SELECT id,label,created_at,expires_at FROM care_invites WHERE owner_id=? AND used_at IS NULL AND expires_at>? ORDER BY id",
        (uid, utc_now())).fetchall()
    patients = connection.execute(
        "SELECT g.owner_id id, u.name, g.created_at FROM care_grants g JOIN users u ON u.id=g.owner_id "
        "WHERE g.caregiver_id=? AND g.revoked_at IS NULL ORDER BY u.name", (uid,)).fetchall()
    return jsonify(grants=[dict(r) for r in grants], invites=[dict(r) for r in invites], patients=[dict(r) for r in patients])


@bp.post("/care/invites")
@login_required
def create_invite():
    payload = json_body({"label"})
    label = text(payload.get("label"), 60, "label", required=True)
    if not rate_limit(f"invite:{g.user['id']}", 10, 86400):
        return too_many()
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    import secrets
    code = "-".join("".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(3))
    expires = health.iso(health.now_utc() + timedelta(days=7))
    with write_tx() as connection:
        insert(connection, "care_invites", {"owner_id": g.user["id"], "label": label, "code_hash": hash_token(code),
                                            "created_at": utc_now(), "expires_at": expires})
        audit("care.invite_created", g.user["id"], g.user["id"], {"label": label})
    return jsonify(code=code, expires_at=expires)


@bp.delete("/care/invites/<int:invite_id>")
@login_required
def delete_invite(invite_id):
    with write_tx() as connection:
        connection.execute("DELETE FROM care_invites WHERE id=? AND owner_id=? AND used_at IS NULL", (invite_id, g.user["id"]))
    return jsonify(ok=True)


@bp.post("/care/accept")
@login_required
def accept_invite():
    payload = json_body({"code"})
    if not rate_limit(f"care_accept:{g.user['id']}", 10, 3600):
        return too_many()
    code = str(payload.get("code") or "").strip().upper()
    with write_tx() as connection:
        invite = connection.execute("SELECT * FROM care_invites WHERE code_hash=? AND used_at IS NULL AND expires_at>?",
                                    (hash_token(code), utc_now())).fetchone()
        if not invite or invite["owner_id"] == g.user["id"]:
            return jsonify(error="invalid_code"), 400
        if not connection.execute("SELECT 1 FROM care_grants WHERE owner_id=? AND caregiver_id=? AND revoked_at IS NULL",
                                  (invite["owner_id"], g.user["id"])).fetchone():
            insert(connection, "care_grants", {"owner_id": invite["owner_id"], "caregiver_id": g.user["id"],
                                               "label": invite["label"], "created_at": utc_now()})
        connection.execute("UPDATE care_invites SET used_at=?, used_by=? WHERE id=?", (utc_now(), g.user["id"], invite["id"]))
        audit("care.granted", invite["owner_id"], g.user["id"], {"label": invite["label"]})
        insert(connection, "notifications", {"user_id": invite["owner_id"], "kind": "care_granted", "reference": str(g.user["id"]),
                                             "message": json.dumps({"name": g.user["name"]}), "created_at": utc_now()})
    return jsonify(ok=True, owner_id=invite["owner_id"])


@bp.delete("/care/grants/<int:grant_id>")
@login_required
def revoke_grant(grant_id):
    """Owner revokes a caregiver, or a caregiver stops viewing someone."""
    with write_tx() as connection:
        grant = connection.execute("SELECT * FROM care_grants WHERE id=? AND revoked_at IS NULL", (grant_id,)).fetchone()
        if not grant or g.user["id"] not in (grant["owner_id"], grant["caregiver_id"]):
            abort(404)
        connection.execute("UPDATE care_grants SET revoked_at=? WHERE id=?", (utc_now(), grant_id))
        audit("care.revoked", grant["owner_id"], g.user["id"], {"label": grant["label"]})
    return jsonify(ok=True)


@bp.delete("/care/patients/<int:owner_id>")
@login_required
def leave_patient(owner_id):
    with write_tx() as connection:
        grant = connection.execute("SELECT id,label FROM care_grants WHERE owner_id=? AND caregiver_id=? AND revoked_at IS NULL",
                                   (owner_id, g.user["id"])).fetchone()
        if grant:
            connection.execute("UPDATE care_grants SET revoked_at=? WHERE id=?", (utc_now(), grant["id"]))
            audit("care.revoked", owner_id, g.user["id"], {"label": grant["label"]})
    return jsonify(ok=True)


def _grant_or_404(owner_id: int):
    """Server-side enforcement: every caregiver read needs an active grant row."""
    connection = get_db()
    grant = connection.execute(
        "SELECT g.*, u.name owner_name FROM care_grants g JOIN users u ON u.id=g.owner_id "
        "WHERE g.owner_id=? AND g.caregiver_id=? AND g.revoked_at IS NULL", (owner_id, g.user["id"])).fetchone()
    if not grant:
        abort(404)
    return grant


def _care_view_audit(owner_id: int, what: str):
    with write_tx():
        last = get_db().execute(
            "SELECT created_at FROM audit_log WHERE user_id=? AND actor_id=? AND action='care.viewed' ORDER BY id DESC LIMIT 1",
            (owner_id, g.user["id"])).fetchone()
        # One record per 10 minutes per caregiver keeps the log useful, not noisy.
        if not last or last["created_at"] < health.iso(health.now_utc() - timedelta(minutes=10)):
            audit("care.viewed", owner_id, g.user["id"], {"what": what})


@bp.get("/care/<int:owner_id>/dashboard")
@login_required
def care_dashboard(owner_id):
    grant = _grant_or_404(owner_id)
    _care_view_audit(owner_id, "dashboard")
    data = health.dashboard(get_db(), owner_id, award=False)
    data.pop("level", None)
    return jsonify(data | {"patient": {"id": owner_id, "name": grant["owner_name"]}, "read_only": True})


@bp.get("/care/<int:owner_id>/trends")
@login_required
def care_trends(owner_id):
    _grant_or_404(owner_id)
    _care_view_audit(owner_id, "trends")
    return jsonify(health.trends(get_db(), owner_id, request.args.get("range", "7d")))


@bp.get("/care/<int:owner_id>/history")
@login_required
def care_history(owner_id):
    _grant_or_404(owner_id)
    _care_view_audit(owner_id, "history")
    kind, offset = _history_args()
    return jsonify(health.history_page(get_db(), owner_id, kind, offset))


@bp.get("/care/<int:owner_id>/pulse")
@login_required
def care_pulse(owner_id):
    _grant_or_404(owner_id)
    _care_view_audit(owner_id, "pulse")
    try:
        days = int(request.args.get("days", 7))
    except ValueError:
        abort(400, "invalid_days")
    return jsonify(health.pulse(get_db(), owner_id, days))


@bp.get("/care/<int:owner_id>/report")
@login_required
def care_report(owner_id):
    grant = _grant_or_404(owner_id)
    start, end = _period()
    _care_view_audit(owner_id, "report")
    return jsonify(health.report(get_db(), owner_id, start, end) | {"patient": {"name": grant["owner_name"]}})


# ---------- admin ----------

@bp.get("/admin/config")
@admin_required
def admin_config():
    connection = get_db()
    selected = [r["quest_key"] for r in connection.execute("SELECT quest_key FROM daily_quest_choices ORDER BY id")]
    ltq = [dict(r) for r in connection.execute("SELECT * FROM long_term_quests ORDER BY category,target,id")]
    users = [dict(r) for r in connection.execute(
        "SELECT id,name,username,created_at,last_login_at,is_admin,must_change_password FROM users ORDER BY id")]
    return jsonify(pool=[{"key": q["key"], "xp": q["xp"], "needs": q["needs"]} for q in health.DAILY_POOL],
                   selected=selected, ltq=ltq, users=users)


@bp.post("/admin/daily-goals")
@admin_required
def save_daily_goals():
    payload = json_body({"keys"})
    keys = payload.get("keys")
    if not isinstance(keys, list):
        abort(400, "invalid_keys")
    cleaned = list(dict.fromkeys(k for k in keys if k in health.POOL_BY_KEY))[:3]
    with write_tx() as connection:
        connection.execute("DELETE FROM daily_quest_choices")
        connection.executemany("INSERT INTO daily_quest_choices(quest_key) VALUES(?)", [(k,) for k in cleaned])
        audit("admin.daily_goals", None, g.user["id"], {"keys": cleaned})
    return jsonify(ok=True, selected=cleaned)


@bp.post("/admin/milestones")
@admin_required
def create_milestone():
    payload = json_body({"title", "metric", "target", "reward", "category"})
    title = text(payload.get("title"), 100, "title", required=True)
    metric = payload.get("metric")
    if metric not in ("steps", "sleep", "water", "checkins"):
        abort(400, "invalid_metric")
    target = num(payload.get("target"), 0.1, 1e9, "target", required=True)
    reward = int(num(payload.get("reward") or 0, 0, 100000, "reward"))
    with write_tx() as connection:
        insert(connection, "long_term_quests", {"title": title, "metric": metric, "target": target, "reward": reward,
                                                "category": text(payload.get("category") or "Custom", 60, "category"), "active": 1})
        audit("admin.milestone_created", None, g.user["id"], {"title": title})
    return jsonify(ok=True)


@bp.post("/admin/users/<int:user_id>/reset-password")
@admin_required
def admin_reset_password(user_id):
    import secrets
    temporary = secrets.token_urlsafe(12)
    with write_tx() as connection:
        cursor = connection.execute(
            "UPDATE users SET password_hash=?, must_change_password=1, session_version=session_version+1 WHERE id=? AND id<>?",
            (generate_password_hash(temporary), user_id, g.user["id"]))
        if not cursor.rowcount:
            abort(404)
        audit("admin.password_reset", user_id, g.user["id"])
    return jsonify(temporary_password=temporary)
