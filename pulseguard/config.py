"""Runtime configuration. Everything comes from environment variables; nothing secret is hard-coded."""
from __future__ import annotations

import os
import secrets

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_VERSION = "2.0.0"

# Same variable name as Health Quest, so the systemd unit keeps working.
DB_PATH = os.environ.get("HEALTH_QUEST_DB") or os.environ.get("PULSEGUARD_DB") or os.path.join(BASE_DIR, "health_quest.db")

COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "false").lower() == "true"
TRUST_PROXY = os.environ.get("TRUST_PROXY", "0") == "1"
DEBUG = os.environ.get("FLASK_DEBUG", "0") == "1"

SESSION_ABSOLUTE_HOURS = 12
SESSION_IDLE_MINUTES = 60
PASSWORD_MIN = 12
PASSWORD_MAX = 128
LEGACY_DEFAULT_ADMIN_PASSWORD = "ChangeMe123!"  # only used to detect and force-replace it
CONSENT_VERSION = "2026-11-04"


def load_secret_key() -> str:
    """Use SECRET_KEY if set; otherwise create a random key once, stored next to the DB (mode 600).

    Fails safe: there is no literal fallback key, so sessions can't be forged with a known value.
    """
    env = os.environ.get("SECRET_KEY")
    if env and env != "change-this-secret-key":
        return env
    path = os.environ.get("SECRET_KEY_FILE") or os.path.join(os.path.dirname(os.path.abspath(DB_PATH)), ".pulseguard_secret_key")
    try:
        with open(path, "r", encoding="ascii") as handle:
            value = handle.read().strip()
            if len(value) >= 32:
                return value
    except FileNotFoundError:
        pass
    value = secrets.token_urlsafe(48)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="ascii") as handle:
        handle.write(value)
    return value
