"""HTML shell for the single-page app, plus redirects for old Health Quest URLs."""
from __future__ import annotations

import os

from flask import Blueprint, redirect, render_template, send_from_directory

from . import config

bp = Blueprint("pages", __name__)

SPA_ROUTES = ["/", "/home", "/api", "/presentatie", "/trends", "/log", "/goals", "/history", "/sharing", "/account", "/notifications",
              "/admin", "/report", "/privacy", "/login", "/signup", "/care/<int:owner_id>", "/care/<int:owner_id>/report",
              "/care/<int:owner_id>/trends", "/care/<int:owner_id>/history"]

OLD_ROUTES = {"/quests": "/goals", "/badges": "/goals", "/checkins": "/history", "/friends": "/sharing", "/leaderboards": "/",
              "/welkom": "/home"}  # the landing page moved to /home


def spa(**_kwargs):
    return render_template("index.html", version=config.APP_VERSION)


for path in SPA_ROUTES:
    bp.add_url_rule(path, view_func=spa, endpoint=f"spa_{path}")

for old, new in OLD_ROUTES.items():
    bp.add_url_rule(old, view_func=(lambda target=new: redirect(target, 301)), endpoint=f"old_{old}")


@bp.get("/assets/<path:filename>")
def legacy_assets(filename):
    """Old image URLs keep working (bookmarks, cached pages)."""
    mapping = {"PG_Logo_1_-Photoroom.png": "pulseguard-wordmark.png", "Firefly_RemoveBackground.png": "pulseguard-shield.png"}
    if filename not in mapping:
        return ("Not found", 404)
    return send_from_directory(os.path.join(config.BASE_DIR, "static", "img"), mapping[filename], max_age=86400)


@bp.get("/app.js")
def legacy_js():
    return redirect(f"/static/js/main.js?v={config.APP_VERSION}", 301)
