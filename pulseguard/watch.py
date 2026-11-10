"""Watch / device API. Authenticated with `Authorization: Bearer <api key>`; no cookies, so no CSRF.

Every authenticated request is written to `api_requests`, so the owner can see on the API page what arrived:
time, endpoint, result, counts, which fields and devices. The raw body is not stored; accepted readings
are in `readings` already.
"""
from __future__ import annotations

import json

from flask import Blueprint, g, jsonify, request

from . import health
from .db import get_db, insert, utc_now, write_tx
from .security import hash_token, rate_limit

bp = Blueprint("watch", __name__, url_prefix="/api/v1")

MAX_BATCH = 500
PER_HOUR = 120
KEEP_REQUESTS = 200
KNOWN_FIELDS = ("ts", "device", "bpm", "spo2", "temp_c", "steps", "activity")


def _authenticate():
    header = request.headers.get("Authorization", "")
    token = header[7:].strip() if header[:7].lower() == "bearer " else ""
    if not token or len(token) > 200:
        return None
    connection = get_db()
    row = connection.execute(
        "SELECT k.id key_id, k.user_id FROM api_keys k JOIN users u ON u.id=k.user_id "
        "WHERE k.key_hash=? AND k.revoked_at IS NULL", (hash_token(token),)).fetchone()
    if row:
        connection.execute("UPDATE api_keys SET last_used_at=? WHERE id=?", (utc_now(), row["key_id"]))
        connection.commit()
    return row


def _summary(items) -> dict:
    """What a batch contained, without the values: field names, devices and the time span."""
    if not isinstance(items, list):
        return {}
    fields, devices, stamps = set(), [], []
    for item in items[:MAX_BATCH]:
        if not isinstance(item, dict):
            continue
        fields.update(k for k in item if k in KNOWN_FIELDS)
        device = item.get("device")
        if isinstance(device, str) and device[:40] not in devices and len(devices) < 3:
            devices.append(device[:40])
        if isinstance(item.get("ts"), str):
            stamps.append(item["ts"][:40])
    return {"fields": ",".join(f for f in KNOWN_FIELDS if f in fields) or None,
            "devices": ",".join(devices) or None,
            "first_ts": min(stamps) if stamps else None, "last_ts": max(stamps) if stamps else None}


def _record(key, status: int, *, result: dict | None = None, error: str | None = None, summary: dict | None = None):
    result = result or {}
    row = {"user_id": key["user_id"], "key_id": key["key_id"], "ts": utc_now(), "method": request.method,
           "path": request.path[:80], "status": status, "accepted": int(result.get("accepted", 0)),
           "duplicates": int(result.get("duplicates", 0)), "rejected": int(result.get("rejected", 0)),
           "error": (error or "")[:60] or None,
           "errors": json.dumps(result.get("errors", [])[:5]) if result.get("errors") else None}
    row.update(summary or {})
    with write_tx() as connection:
        insert(connection, "api_requests", row)
        connection.execute(
            "DELETE FROM api_requests WHERE user_id=? AND id <= COALESCE((SELECT id FROM api_requests WHERE user_id=? "
            "ORDER BY id DESC LIMIT 1 OFFSET ?), 0)", (key["user_id"], key["user_id"], KEEP_REQUESTS))


def _reply(key, body: dict, status: int = 200, **record):
    _record(key, status, **record)
    return jsonify(body), status


def _guard():
    key = _authenticate()
    if key is None:
        if not rate_limit(f"v1:badkey:{request.remote_addr}", 30, 300):
            return None, (jsonify(error="too_many_requests"), 429)
        return None, (jsonify(error="invalid_api_key"), 401)
    # ~1 request per minute is the expected rate; allow bursts for catch-up uploads.
    if not rate_limit(f"v1:key:{key['key_id']}", PER_HOUR, 3600):
        return None, _reply(key, {"error": "too_many_requests"}, 429, error="too_many_requests")
    g.watch_user_id = key["user_id"]
    return key, None


@bp.get("/status")
def status():
    key, error = _guard()
    if error:
        return error
    return _reply(key, {"ok": True, "server_time": health.iso(health.now_utc()) + "Z", "max_batch": MAX_BATCH})


@bp.post("/readings")
def readings():
    key, error = _guard()
    if error:
        return error
    payload = request.get_json(silent=True)
    if isinstance(payload, dict) and "readings" in payload:
        items = payload["readings"]
    elif isinstance(payload, dict):
        items = [payload]
    elif isinstance(payload, list):
        items = payload
    else:
        return _reply(key, {"error": "invalid_json"}, 400, error="invalid_json")
    summary = _summary(items)
    if not isinstance(items, list) or not items:
        return _reply(key, {"error": "no_readings"}, 400, error="no_readings", summary=summary)
    if len(items) > MAX_BATCH:
        return _reply(key, {"error": "batch_too_large", "max_batch": MAX_BATCH}, 413, error="batch_too_large", summary=summary)
    with write_tx() as connection:
        result = health.store_readings(connection, key["user_id"], items, "api")
    status_code = 200 if result["accepted"] or result["duplicates"] else 400
    return _reply(key, result, status_code, result=result, summary=summary)


@bp.post("/entries")
def legacy_entries():
    """Health Quest compatible endpoint: same payload as before (date, time, steps, sleep, water, weight, bpm, notes)."""
    key, error = _guard()
    if error:
        return error
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return _reply(key, {"error": "invalid_json"}, 400, error="invalid_json")
    allowed = {"date", "time", "steps", "sleep", "water", "weight", "bpm", "notes"}
    fields = {"fields": ",".join(sorted(k for k in payload if k in allowed)) or None}
    if set(payload) - allowed:
        return _reply(key, {"error": "unknown_fields"}, 400, error="unknown_fields", summary=fields)
    try:
        with write_tx() as connection:
            result = health.store_entry(connection, key["user_id"], payload, "api")
    except ValueError as exc:
        return _reply(key, {"error": str(exc)}, 400, error=str(exc), summary=fields)
    return _reply(key, {"ok": True, **result}, 200, result={"accepted": 1}, summary=fields)
