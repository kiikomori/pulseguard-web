"""Auth, sessions, CSRF, rate limiting, audit and response headers."""
from __future__ import annotations

import hashlib
import json
import secrets
import time
from functools import wraps

from flask import abort, g, jsonify, request, session

from . import config
from .db import get_db, utc_now


# ---------- tokens ----------

def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_token(prefix: str = "pg_") -> str:
    return prefix + secrets.token_urlsafe(32)


# ---------- request context ----------

def client_ip() -> str:
    # With TRUST_PROXY=1, ProxyFix (set in create_app) has already applied X-Forwarded-For.
    return request.remote_addr or "unknown"


def audit(action: str, user_id=None, actor_id=None, detail=None, connection=None) -> None:
    """Append-only audit trail. Never store passwords, tokens or health values in `detail`."""
    connection = connection or get_db()
    connection.execute(
        "INSERT INTO audit_log(user_id,actor_id,action,detail,ip,created_at) VALUES(?,?,?,?,?,?)",
        (user_id, actor_id, action, json.dumps(detail, separators=(",", ":")) if detail else None, client_ip(), utc_now()),
    )


# ---------- rate limiting ----------

def rate_limit(key: str, limit: int, window_seconds: int) -> bool:
    """Fixed-window limiter stored in SQLite. Returns True when the request is allowed."""
    connection = get_db()
    now = time.time()
    row = connection.execute("SELECT window_start, count FROM rate_limits WHERE key=?", (key,)).fetchone()
    if row is None or now - row["window_start"] >= window_seconds:
        connection.execute(
            "INSERT INTO rate_limits(key,window_start,count) VALUES(?,?,1) "
            "ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start, count=1",
            (key, now),
        )
        connection.commit()
        return True
    connection.execute("UPDATE rate_limits SET count=count+1 WHERE key=?", (key,))
    connection.commit()
    return row["count"] + 1 <= limit


def reset_limit(key: str) -> None:
    connection = get_db()
    connection.execute("DELETE FROM rate_limits WHERE key=?", (key,))
    connection.commit()


def too_many():
    return jsonify(error="rate_limited"), 429


# ---------- CSRF ----------

STATE_CHANGING = {"POST", "PUT", "PATCH", "DELETE"}


def csrf_protect():
    """Same-origin check for the browser API. The watch API (/api/v1) uses bearer keys, not cookies."""
    if request.method not in STATE_CHANGING or request.path.startswith("/api/v1/"):
        return None
    if request.headers.get("X-PulseGuard") != "1":
        return jsonify(error="csrf"), 403
    fetch_site = request.headers.get("Sec-Fetch-Site")
    if fetch_site and fetch_site not in ("same-origin", "none"):
        return jsonify(error="csrf"), 403
    origin = request.headers.get("Origin")
    if origin and origin.rstrip("/") != request.host_url.rstrip("/"):
        return jsonify(error="csrf"), 403
    return None


# ---------- sessions ----------

def start_session(user) -> None:
    session.clear()
    session.permanent = True
    session["user_id"] = user["id"]
    session["sv"] = int(user["session_version"] or 0)
    session["iat"] = int(time.time())
    session["seen"] = int(time.time())


def current_user():
    """Validate the cookie session against the DB on every request (idle + absolute timeout, version)."""
    if "user" in g:
        return g.user
    g.user = None
    user_id = session.get("user_id")
    if not user_id:
        return None
    now = int(time.time())
    if now - int(session.get("iat", 0)) > config.SESSION_ABSOLUTE_HOURS * 3600 or \
            now - int(session.get("seen", 0)) > config.SESSION_IDLE_MINUTES * 60:
        session.clear()
        return None
    row = get_db().execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    if row is None or int(row["session_version"] or 0) != int(session.get("sv", -1)):
        session.clear()
        return None
    # Only background polling (X-PulseGuard-Poll) doesn't count as activity.
    if request.headers.get("X-PulseGuard-Poll") != "1":
        session["seen"] = now
    g.user = row
    return row


def login_required(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        user = current_user()
        if user is None:
            return jsonify(error="auth_required"), 401
        if user["must_change_password"] and request.endpoint not in ALLOWED_WHILE_PASSWORD_CHANGE:
            return jsonify(error="password_change_required"), 403
        return function(*args, **kwargs)
    return wrapped


ALLOWED_WHILE_PASSWORD_CHANGE = {"api.me", "api.change_password", "api.logout", "api.update_profile", "api.ping"}


def admin_required(function):
    @wraps(function)
    @login_required
    def wrapped(*args, **kwargs):
        if not g.user["is_admin"]:
            return jsonify(error="forbidden"), 403
        return function(*args, **kwargs)
    return wrapped


def password_problem(password: str, username: str = "") -> str | None:
    if len(password) < config.PASSWORD_MIN:
        return "password_too_short"
    if len(password) > config.PASSWORD_MAX:
        return "password_too_long"
    if username and username.lower() in password.lower():
        return "password_contains_username"
    if password == config.LEGACY_DEFAULT_ADMIN_PASSWORD:
        return "password_too_common"
    return None


# ---------- input helpers ----------

def json_body(allowed: set[str] | None = None) -> dict:
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        abort(400, "invalid_json")
    if allowed is not None:
        unknown = set(payload) - allowed
        if unknown:
            abort(400, "unknown_fields")
    return payload


def num(value, low: float, high: float, field: str, required: bool = False):
    if value is None or value == "":
        if required:
            abort(400, f"missing_{field}")
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        abort(400, f"invalid_{field}")
    if result != result or not (low <= result <= high):  # NaN or out of range
        abort(400, f"out_of_range_{field}")
    return result


def text(value, max_len: int, field: str, required: bool = False) -> str:
    result = str(value or "").strip()
    if required and not result:
        abort(400, f"missing_{field}")
    if len(result) > max_len:
        abort(400, f"too_long_{field}")
    return result


# ---------- headers ----------

CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
])


def security_headers(response):
    response.headers.setdefault("Content-Security-Policy", CSP)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()"
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    if config.COOKIE_SECURE:
        # Start at one day (toolkit checklist); raise to 31536000 once HTTPS is confirmed stable.
        response.headers["Strict-Transport-Security"] = "max-age=86400"
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    response.headers.pop("Server", None)
    return response
