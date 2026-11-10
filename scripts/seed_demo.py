"""Create a demo account with synthetic watch data for local testing and screenshots.

Usage (local only, never on the live server):
    HEALTH_QUEST_DB=./demo.db python scripts/seed_demo.py [--username demo] [--password "..."]

All data generated here is synthetic.
"""
import argparse
import math
import os
import random
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from werkzeug.security import generate_password_hash  # noqa: E402

from pulseguard import config, db  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--username", default="demo")
    parser.add_argument("--name", default="Anne de Vries")
    parser.add_argument("--password", default="rustig ademen bij de zee")
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--alert", action="store_true", help="add an open high-heart-rate alert")
    args = parser.parse_args()
    if os.path.abspath(config.DB_PATH).startswith("/var/lib"):
        sys.exit("Refusing to seed demo data into what looks like the production database.")

    db.migrate()
    c = db.connect()
    rng = random.Random(42)
    now = datetime.now(timezone.utc).replace(tzinfo=None, second=0, microsecond=0)
    row = c.execute("SELECT id FROM users WHERE username=?", (args.username,)).fetchone()
    if row:
        uid = row["id"]
        for table in ("readings", "entries", "mood_logs", "symptom_logs", "medication_logs", "medications", "alerts", "thresholds"):
            c.execute(f"DELETE FROM {table} WHERE user_id=?", (uid,))
    else:
        uid = db.insert(c, "users", {"name": args.name, "username": args.username, "password_hash": generate_password_hash(args.password),
                                     "created_at": db.utc_now(), "friend_code": db.make_friend_code(c), "consent_at": db.utc_now(),
                                     "consent_version": config.CONSENT_VERSION})
    c.execute("INSERT INTO thresholds(user_id,bpm_low,bpm_high,spo2_low,temp_high,updated_at) VALUES(?,?,?,?,?,?)",
              (uid, 48, 115, 93, 37.8, db.utc_now()))

    rows = []
    start = now - timedelta(days=args.days)
    t = start
    while t <= now:
        hour = (t.hour + 1) % 24  # roughly local time
        asleep = hour < 7 or hour >= 23
        activity = "sleep" if asleep else ("light" if 9 <= hour <= 18 and rng.random() < 0.4 else "rest")
        base = 58 if asleep else 70 + 6 * math.sin((hour - 8) / 24 * 2 * math.pi)
        bpm = base + (14 if activity == "light" else 0) + rng.gauss(0, 3)
        spo2 = min(99.5, 96.5 + rng.gauss(0, 0.8))
        temp = 36.4 + 0.3 * math.sin((hour - 4) / 24 * 2 * math.pi) + rng.gauss(0, 0.08)
        steps = 0 if asleep else max(0, int(rng.gauss(140 if activity == "light" else 25, 30)))
        rows.append((uid, "watch", t.isoformat(), round(bpm), round(spo2, 1), round(temp, 1), steps, activity, "api", db.utc_now()))
        t += timedelta(minutes=10)
    c.executemany("INSERT OR IGNORE INTO readings(user_id,device,ts,bpm,spo2,temp_c,steps,activity,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", rows)

    for d in range(args.days):
        if d in (2, 5, 11):
            continue  # quiet days: nothing logged by hand, like real life
        day = (now - timedelta(days=d)).date().isoformat()
        db.insert(c, "entries", {"user_id": uid, "entry_date": day, "entry_time": "08:00", "steps": 0, "sleep": round(rng.uniform(6.2, 8.1), 1),
                                 "water": round(rng.uniform(1.2, 2.4), 1), "source": "human", "created_at": db.utc_now()})
        ts = f"{day}T19:00:00"
        db.insert(c, "mood_logs", {"user_id": uid, "ts": ts, "stress": rng.choice([1, 2, 2, 3, 3, 4]), "mood": rng.choice([3, 3, 4, 4, 5]), "created_at": db.utc_now()})
    for name, dose, times in (("Metoprolol", "50 mg", 2), ("Acetylsalicylzuur", "80 mg", 1)):
        med_id = db.insert(c, "medications", {"user_id": uid, "name": name, "dose": dose, "times_per_day": times,
                                              "times": '["08:00", "20:00"]' if times == 2 else '["08:00"]', "created_at": db.utc_now()})
        for d in range(1, args.days):
            day = (now - timedelta(days=d)).date().isoformat()
            for slot in range(times):
                db.insert(c, "medication_logs", {"user_id": uid, "medication_id": med_id, "ts": f"{day}T{8 + 12 * slot:02d}:00:00",
                                                 "status": "taken" if rng.random() < 0.93 else "skipped", "created_at": db.utc_now()})
        today = now.date().isoformat()
        db.insert(c, "medication_logs", {"user_id": uid, "medication_id": med_id, "ts": f"{today}T07:00:00", "status": "taken", "created_at": db.utc_now()})
    db.insert(c, "symptom_logs", {"user_id": uid, "ts": (now - timedelta(days=3, hours=4)).isoformat(), "symptoms": '["palpitations"]',
                                  "severity": 2, "notes": "Na de trap, ging vanzelf over.", "created_at": db.utc_now()})
    if args.alert:
        ts = (now - timedelta(minutes=20)).isoformat()
        c.execute("UPDATE readings SET bpm=128, activity='rest' WHERE user_id=? AND ts=(SELECT MAX(ts) FROM readings WHERE user_id=? AND ts<=?)", (uid, uid, ts))
        db.insert(c, "alerts", {"user_id": uid, "kind": "bpm_high", "severity": "warning", "value": 128, "threshold": 115,
                                "reading_ts": ts, "created_at": ts})
    c.commit()
    print(f"Seeded synthetic data for '{args.username}' (password: {args.password}) in {config.DB_PATH}")


if __name__ == "__main__":
    main()
