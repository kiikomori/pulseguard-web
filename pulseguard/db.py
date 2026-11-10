"""SQLite access and additive, idempotent migrations.

Rule: never drop or rename a live table or column. Every change here must be safe to run
on every Health Quest database ever released, any number of times.
"""
from __future__ import annotations

import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from datetime import date, datetime, timezone

from flask import g
from werkzeug.security import generate_password_hash

from . import config


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds")


def connect(path: str | None = None) -> sqlite3.Connection:
    connection = sqlite3.connect(path or config.DB_PATH, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout=15000")
    return connection


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = connect()
    return g.db


def close_db(_exc=None) -> None:
    connection = g.pop("db", None)
    if connection is not None:
        connection.close()


@contextmanager
def write_tx():
    """Short write transaction with retry on a temporarily locked database."""
    connection = get_db()
    for attempt in range(5):
        try:
            connection.execute("BEGIN IMMEDIATE")
            break
        except sqlite3.OperationalError as error:
            if "locked" not in str(error).lower() or attempt == 4:
                raise
            time.sleep(0.2 * (attempt + 1))
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise


# ---------- helpers ----------

def table_columns(connection, table_name):
    return {row["name"] for row in connection.execute(f"PRAGMA table_info({table_name})")}


def column_info(connection, table_name):
    return {row["name"]: row for row in connection.execute(f"PRAGMA table_info({table_name})")}


def has_table(connection, table_name):
    return connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table_name,)
    ).fetchone() is not None


def add_column(connection, table_name, definition):
    column_name = definition.split()[0]
    if column_name not in table_columns(connection, table_name):
        connection.execute(f"ALTER TABLE {table_name} ADD COLUMN {definition}")


def normalise_date(value):
    value = str(value or "").strip()
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(value[:10], fmt).date().isoformat()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        return date.today().isoformat()


def make_friend_code(connection):
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    while True:
        code = "".join(secrets.choice(alphabet) for _ in range(10))
        if not connection.execute("SELECT 1 FROM users WHERE friend_code=?", (code,)).fetchone():
            return code


def legacy_fill(connection, table: str, values: dict) -> dict:
    """Older live databases have extra NOT NULL columns (entries.date/created, notifications.type).

    Fill them from the current fields so inserts never fail on those databases.
    """
    info = column_info(connection, table)
    if table == "entries":
        if "date" in info and "date" not in values:
            values["date"] = values.get("entry_date") or date.today().isoformat()
        if "created" in info and "created" not in values:
            values["created"] = values.get("created_at") or utc_now()
    if table == "notifications" and "type" in info and "type" not in values:
        values["type"] = values.get("kind") or "general"
    return values


def insert(connection, table: str, values: dict) -> int:
    values = legacy_fill(connection, table, dict(values))
    columns = ",".join(values.keys())
    marks = ",".join("?" for _ in values)
    cursor = connection.execute(f"INSERT INTO {table}({columns}) VALUES({marks})", tuple(values.values()))
    return cursor.lastrowid


# ---------- migrations ----------

def _ensure_friend_links(connection):
    """Kept from Health Quest: preserve incompatible historical friend tables."""
    if not has_table(connection, "friend_links"):
        connection.execute(
            """CREATE TABLE friend_links(
                user_low INTEGER NOT NULL, user_high INTEGER NOT NULL, requested_by INTEGER,
                status TEXT NOT NULL DEFAULT 'accepted', created_at TEXT NOT NULL, responded_at TEXT,
                UNIQUE(user_low, user_high))"""
        )
        return
    columns = table_columns(connection, "friend_links")
    if {"user_low", "user_high"}.issubset(columns):
        for definition in ("requested_by INTEGER", "status TEXT NOT NULL DEFAULT 'accepted'", "created_at TEXT", "responded_at TEXT"):
            add_column(connection, "friend_links", definition)
        connection.execute("UPDATE friend_links SET status='accepted' WHERE status IS NULL OR status=''")
        connection.execute("UPDATE friend_links SET created_at=? WHERE created_at IS NULL OR created_at=''", (utc_now(),))
        return
    legacy_name, suffix = "friend_links_legacy", 1
    while has_table(connection, legacy_name):
        suffix += 1
        legacy_name = f"friend_links_legacy_{suffix}"
    connection.execute(f"ALTER TABLE friend_links RENAME TO {legacy_name}")
    _ensure_friend_links(connection)


def _legacy_health_quest(connection):
    """The Health Quest migrations, unchanged in effect."""
    connection.executescript(
        """CREATE TABLE IF NOT EXISTS users(
               id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE,
               password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
           CREATE TABLE IF NOT EXISTS entries(
               id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, entry_date TEXT, entry_time TEXT,
               steps REAL DEFAULT 0, sleep REAL DEFAULT 0, water REAL DEFAULT 0, weight REAL, bpm REAL,
               notes TEXT, source TEXT DEFAULT 'human', created_at TEXT);
           CREATE TABLE IF NOT EXISTS notifications(
               id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
           CREATE TABLE IF NOT EXISTS long_term_quests(
               id INTEGER PRIMARY KEY, title TEXT, metric TEXT, target REAL, reward INTEGER DEFAULT 0,
               category TEXT DEFAULT 'Custom', active INTEGER DEFAULT 1, description TEXT);
           CREATE TABLE IF NOT EXISTS daily_quest_choices(id INTEGER PRIMARY KEY, quest_key TEXT NOT NULL UNIQUE);
           CREATE TABLE IF NOT EXISTS achievements(
               id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, scope TEXT NOT NULL, achievement_key TEXT NOT NULL,
               xp INTEGER NOT NULL DEFAULT 0, completed_at TEXT NOT NULL, UNIQUE(user_id, scope, achievement_key));"""
    )
    for definition in ("api_key TEXT", "leaderboard_opt_in INTEGER NOT NULL DEFAULT 0",
                       "is_admin INTEGER NOT NULL DEFAULT 0", "friend_code TEXT"):
        add_column(connection, "users", definition)

    before = table_columns(connection, "entries")
    for definition in ("entry_date TEXT", "entry_time TEXT", "steps REAL DEFAULT 0", "sleep REAL DEFAULT 0",
                       "water REAL DEFAULT 0", "weight REAL", "bpm REAL", "notes TEXT",
                       "source TEXT DEFAULT 'human'", "created_at TEXT"):
        add_column(connection, "entries", definition)
    source_date = "date" if "date" in before else ("created" if "created" in before else None)
    if source_date:
        for row in connection.execute(
            f"SELECT id, {source_date} AS old_date, created_at FROM entries WHERE entry_date IS NULL OR entry_date=''"
        ).fetchall():
            connection.execute("UPDATE entries SET entry_date=? WHERE id=?",
                               (normalise_date(row["old_date"] or row["created_at"]), row["id"]))
    connection.execute("UPDATE entries SET entry_date=? WHERE entry_date IS NULL OR entry_date=''", (date.today().isoformat(),))
    connection.execute("UPDATE entries SET source='human' WHERE source IS NULL OR source=''")
    connection.execute("UPDATE entries SET created_at=? WHERE created_at IS NULL OR created_at=''", (utc_now(),))

    nbefore = table_columns(connection, "notifications")
    for definition in ("kind TEXT", "reference TEXT", "read_at TEXT"):
        add_column(connection, "notifications", definition)
    if "type" in nbefore:
        connection.execute("UPDATE notifications SET kind=type WHERE kind IS NULL OR kind=''")
    connection.execute("UPDATE notifications SET kind='general' WHERE kind IS NULL OR kind=''")

    lbefore = table_columns(connection, "long_term_quests")
    for definition in ("title TEXT", "metric TEXT", "target REAL", "reward INTEGER DEFAULT 0",
                       "category TEXT DEFAULT 'Custom'", "active INTEGER DEFAULT 1", "description TEXT"):
        add_column(connection, "long_term_quests", definition)
    if "name" in lbefore:
        connection.execute("UPDATE long_term_quests SET title=name WHERE (title IS NULL OR title='') AND name IS NOT NULL")
    if "xp" in lbefore:
        connection.execute("UPDATE long_term_quests SET reward=xp WHERE (reward IS NULL OR reward=0) AND xp IS NOT NULL")
    connection.execute("UPDATE long_term_quests SET title='Long-term quest #' || id WHERE title IS NULL OR title=''")
    connection.execute("UPDATE long_term_quests SET metric='checkins' WHERE metric IS NULL OR metric=''")
    connection.execute("UPDATE long_term_quests SET target=1 WHERE target IS NULL OR target<=0")
    connection.execute("UPDATE long_term_quests SET category='Custom' WHERE category IS NULL OR category=''")
    connection.execute("UPDATE long_term_quests SET active=1 WHERE active IS NULL")

    dbefore = table_columns(connection, "daily_quest_choices")
    add_column(connection, "daily_quest_choices", "quest_key TEXT")
    if "key" in dbefore:
        connection.execute("UPDATE daily_quest_choices SET quest_key=key WHERE quest_key IS NULL OR quest_key=''")

    for definition in ("user_id INTEGER", "scope TEXT", "achievement_key TEXT", "xp INTEGER DEFAULT 0", "completed_at TEXT"):
        add_column(connection, "achievements", definition)
    connection.execute("UPDATE achievements SET scope='legacy' WHERE scope IS NULL OR scope=''")
    connection.execute("UPDATE achievements SET achievement_key='legacy-' || id WHERE achievement_key IS NULL OR achievement_key=''")
    connection.execute("UPDATE achievements SET xp=0 WHERE xp IS NULL")
    connection.execute("UPDATE achievements SET completed_at=? WHERE completed_at IS NULL OR completed_at=''", (utc_now(),))
    connection.execute("""DELETE FROM achievements WHERE id NOT IN (
                            SELECT MIN(id) FROM achievements GROUP BY user_id, scope, achievement_key)""")

    _ensure_friend_links(connection)
    connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_friend_code ON users(friend_code) WHERE friend_code IS NOT NULL")
    connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_quest_choice ON daily_quest_choices(quest_key) WHERE quest_key IS NOT NULL")
    connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_achievement_once ON achievements(user_id, scope, achievement_key)")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_entries_user_date ON entries(user_id, entry_date)")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id)")

    for row in connection.execute("SELECT id FROM users WHERE friend_code IS NULL OR friend_code=''").fetchall():
        connection.execute("UPDATE users SET friend_code=? WHERE id=?", (make_friend_code(connection), row["id"]))

    defaults = [
        ("Sleep starter", "sleep", 250, 250, "Sleep"), ("Sleep explorer", "sleep", 1000, 1000, "Sleep"),
        ("Sleep champion", "sleep", 2500, 2500, "Sleep"), ("Step starter", "steps", 50000, 50, "Steps"),
        ("Step explorer", "steps", 250000, 250, "Steps"), ("Step champion", "steps", 1000000, 1000, "Steps"),
        ("Water starter", "water", 100, 100, "Water"), ("Water explorer", "water", 500, 500, "Water"),
        ("Water champion", "water", 1500, 1500, "Water"), ("Check-in starter", "checkins", 25, 25, "Check-ins"),
        ("Check-in explorer", "checkins", 100, 100, "Check-ins"), ("Check-in champion", "checkins", 250, 250, "Check-ins"),
    ]
    for title, metric, target, reward, category in defaults:
        if not connection.execute("SELECT 1 FROM long_term_quests WHERE title=?", (title,)).fetchone():
            connection.execute("INSERT INTO long_term_quests(title,metric,target,reward,category,active) VALUES(?,?,?,?,?,1)",
                               (title, metric, target, reward, category))


def _pulseguard_v2(connection):
    """New in PulseGuard 2.0. Additive only."""
    for definition in (
        "session_version INTEGER NOT NULL DEFAULT 0",
        "language TEXT NOT NULL DEFAULT 'nl'",
        "theme TEXT NOT NULL DEFAULT 'system'",
        "text_size TEXT NOT NULL DEFAULT 'large'",
        "consent_at TEXT",
        "consent_version TEXT",
        "must_change_password INTEGER NOT NULL DEFAULT 0",
        "last_login_at TEXT",
    ):
        add_column(connection, "users", definition)

    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS api_keys(
            id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, prefix TEXT NOT NULL,
            key_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
        CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

        CREATE TABLE IF NOT EXISTS readings(
            id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, device TEXT NOT NULL DEFAULT 'watch', ts TEXT NOT NULL,
            bpm REAL, spo2 REAL, temp_c REAL, steps REAL, activity TEXT, source TEXT NOT NULL DEFAULT 'api',
            created_at TEXT NOT NULL, UNIQUE(user_id, device, ts));
        CREATE INDEX IF NOT EXISTS idx_readings_user_ts ON readings(user_id, ts);

        CREATE TABLE IF NOT EXISTS thresholds(
            user_id INTEGER PRIMARY KEY, bpm_low REAL NOT NULL, bpm_high REAL NOT NULL,
            spo2_low REAL NOT NULL, temp_high REAL NOT NULL, updated_at TEXT NOT NULL);

        CREATE TABLE IF NOT EXISTS alerts(
            id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, severity TEXT NOT NULL,
            value REAL, threshold REAL, reading_ts TEXT, created_at TEXT NOT NULL, acknowledged_at TEXT);
        CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id, created_at);

        CREATE TABLE IF NOT EXISTS symptom_logs(
            id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, ts TEXT NOT NULL, symptoms TEXT NOT NULL,
            severity INTEGER NOT NULL, notes TEXT, created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_symptoms_user ON symptom_logs(user_id, ts);

        CREATE TABLE IF NOT EXISTS mood_logs(
            id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, ts TEXT NOT NULL, stress INTEGER, mood INTEGER,
            notes TEXT, created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_mood_user ON mood_logs(user_id, ts);

        CREATE TABLE IF NOT EXISTS medications(
            id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, dose TEXT,
            times_per_day INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS medication_logs(
            id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, medication_id INTEGER NOT NULL, ts TEXT NOT NULL,
            status TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_medlogs_user ON medication_logs(user_id, ts);

        CREATE TABLE IF NOT EXISTS care_invites(
            id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, label TEXT NOT NULL, code_hash TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, used_by INTEGER);
        CREATE TABLE IF NOT EXISTS care_grants(
            id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, caregiver_id INTEGER NOT NULL, label TEXT NOT NULL,
            created_at TEXT NOT NULL, revoked_at TEXT);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_care_active ON care_grants(owner_id, caregiver_id) WHERE revoked_at IS NULL;

        CREATE TABLE IF NOT EXISTS audit_log(
            id INTEGER PRIMARY KEY, user_id INTEGER, actor_id INTEGER, action TEXT NOT NULL, detail TEXT,
            ip TEXT, created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at);

        CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY, window_start REAL NOT NULL, count INTEGER NOT NULL);
        """
    )
    add_column(connection, "medications", "times TEXT")  # JSON list of "HH:MM" dose times (reminders)

    # Audit log is append-only at the database level too.
    connection.executescript(
        """
        CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
        """
    )

    # Move plaintext API keys into hashed api_keys rows. The watch keeps working with the same key.
    from .security import hash_token  # local import avoids a cycle

    if "api_key" in table_columns(connection, "users"):
        for row in connection.execute("SELECT id, api_key FROM users WHERE api_key IS NOT NULL AND api_key<>''").fetchall():
            digest = hash_token(row["api_key"])
            if not connection.execute("SELECT 1 FROM api_keys WHERE key_hash=?", (digest,)).fetchone():
                connection.execute(
                    "INSERT INTO api_keys(user_id,name,prefix,key_hash,created_at) VALUES(?,?,?,?,?)",
                    (row["id"], "Watch", row["api_key"][:6], digest, utc_now()),
                )
            connection.execute("UPDATE users SET api_key=NULL WHERE id=?", (row["id"],))


def _bootstrap_admin(connection):
    admin = connection.execute("SELECT id FROM users WHERE username='admin'").fetchone()
    if admin:
        connection.execute("UPDATE users SET is_admin=1 WHERE id=?", (admin["id"],))
        return
    password = os.environ.get("INITIAL_ADMIN_PASSWORD")
    generated = not password
    if generated:
        password = secrets.token_urlsafe(14)
    connection.execute(
        """INSERT INTO users(name,username,password_hash,created_at,is_admin,friend_code,must_change_password)
           VALUES(?,?,?,?,1,?,1)""",
        ("Administrator", "admin", generate_password_hash(password), utc_now(), make_friend_code(connection)),
    )
    if generated:
        print(f"[pulseguard] Created admin account 'admin' with one-time password: {password}  (change it at first login)", flush=True)


def _goals_v3(connection):
    """Doelen redesign (2026-11-05): check-in milestones at 7, 30, 100 and 250 in total.

    Additive: two new default milestones are inserted, and the old 25 check-in default is switched off once,
    only if it still has its untouched default title and target. A one-time marker keeps a later choice by an
    administrator (switching it back on) from being undone on the next start.
    """
    connection.execute("CREATE TABLE IF NOT EXISTS migration_marks(name TEXT PRIMARY KEY, done_at TEXT NOT NULL)")
    for title, target in (("Check-in first week", 7), ("Check-in month", 30)):
        if not connection.execute("SELECT 1 FROM long_term_quests WHERE title=?", (title,)).fetchone():
            connection.execute("INSERT INTO long_term_quests(title,metric,target,reward,category,active) VALUES(?,?,?,?,?,1)",
                               (title, "checkins", target, target, "Check-ins"))
    if not connection.execute("SELECT 1 FROM migration_marks WHERE name='goals_v3_checkin_25_off'").fetchone():
        connection.execute("UPDATE long_term_quests SET active=0 WHERE title='Check-in starter' AND metric='checkins' AND target=25")
        connection.execute("INSERT INTO migration_marks(name, done_at) VALUES('goals_v3_checkin_25_off', ?)", (utc_now(),))


def _api_v4(connection):
    """API page (2026-11-05): a log of what arrived on the watch API. Additive and idempotent."""
    connection.executescript("""
        CREATE TABLE IF NOT EXISTS api_requests(
            id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, key_id INTEGER, ts TEXT NOT NULL, method TEXT NOT NULL,
            path TEXT NOT NULL, status INTEGER NOT NULL, accepted INTEGER DEFAULT 0, duplicates INTEGER DEFAULT 0,
            rejected INTEGER DEFAULT 0, error TEXT, errors TEXT, fields TEXT, devices TEXT, first_ts TEXT, last_ts TEXT);
        CREATE INDEX IF NOT EXISTS idx_api_requests_user ON api_requests(user_id, id);
    """)


def _symptoms_v5(connection):
    """Own symptoms (2026-11-05): the user can type a symptom that isn't in the list. Additive and idempotent."""
    add_column(connection, "symptom_logs", "custom TEXT")


def _entries_v6(connection):
    """Manual oxygen (2026-11-05): the Meting form accepts SpO2. Additive and idempotent."""
    add_column(connection, "entries", "spo2 REAL")


def migrate(path: str | None = None) -> None:
    # Note: executescript() commits implicitly, so this can't be a single transaction.
    # Each step is idempotent instead, which makes a half-finished run safe to repeat.
    connection = connect(path)
    try:
        connection.execute("PRAGMA journal_mode=WAL")
        _legacy_health_quest(connection)
        _pulseguard_v2(connection)
        _goals_v3(connection)
        _api_v4(connection)
        _symptoms_v5(connection)
        _entries_v6(connection)
        _bootstrap_admin(connection)
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
