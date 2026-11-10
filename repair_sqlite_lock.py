#!/usr/bin/env python3
"""Recover a Health Quest SQLite database after a stale SQLite lock.

Run only while healthquest.service is stopped:
    systemctl stop healthquest
    python3 repair_sqlite_lock.py
"""
import os
import shutil
import sqlite3
import sys
from datetime import datetime

DB_PATH = os.environ.get("HEALTH_QUEST_DB", "/var/lib/healthquest/health_quest.db")

def fail(message):
    print(f"\nERROR: {message}")
    print("\nDo not restart the website yet. Check which process holds the database:")
    print(f"  fuser -v {DB_PATH} {DB_PATH}-wal {DB_PATH}-shm 2>/dev/null")
    sys.exit(1)

if not os.path.exists(DB_PATH):
    fail(f"Database not found: {DB_PATH}")

try:
    con = sqlite3.connect(DB_PATH, timeout=20)
    con.execute("PRAGMA busy_timeout = 20000")
    integrity = con.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity.lower() != "ok":
        fail(f"Integrity check failed: {integrity}")

    # Make a consistent backup that includes uncheckpointed WAL data.
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = f"{DB_PATH}.backup-before-lock-repair-{stamp}"
    destination = sqlite3.connect(backup)
    con.backup(destination)
    destination.close()
    print(f"Created backup: {backup}")

    # WAL improves concurrent browser/API reads while one request writes.
    mode = con.execute("PRAGMA journal_mode=WAL").fetchone()[0]
    checkpoint = con.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
    con.execute("BEGIN EXCLUSIVE")
    con.execute("COMMIT")
    con.close()

    print(f"SQLite journal mode: {mode}")
    print(f"Checkpoint result: {checkpoint}")
    print("Database lock recovery completed successfully.")
except sqlite3.OperationalError as error:
    try:
        con.close()
    except Exception:
        pass
    if "locked" in str(error).lower():
        fail("The database is still locked by another process.")
    raise
