"""PulseGuard: companion web app and watch API (formerly Health Quest)."""
from __future__ import annotations

import mimetypes
from datetime import timedelta

from flask import Flask, jsonify, request
from werkzeug.middleware.proxy_fix import ProxyFix

from . import config
from .db import close_db, migrate
from .security import csrf_protect, security_headers


def create_app(db_path: str | None = None) -> Flask:
    if db_path:
        config.DB_PATH = db_path
    # Windows registries sometimes map .js to text/plain, which breaks ES modules.
    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("application/json", ".json")
    mimetypes.add_type("font/woff2", ".woff2")

    app = Flask(__name__, static_folder=f"{config.BASE_DIR}/static", template_folder=f"{config.BASE_DIR}/templates")
    app.secret_key = config.load_secret_key()
    app.config.update(
        SESSION_COOKIE_NAME="pg_session",
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=config.COOKIE_SECURE,
        PERMANENT_SESSION_LIFETIME=timedelta(hours=config.SESSION_ABSOLUTE_HOURS),
        MAX_CONTENT_LENGTH=512 * 1024,
        JSON_SORT_KEYS=False,
        # No max-age: browsers revalidate with ETag, so ES module imports never go stale after a deploy.
        SEND_FILE_MAX_AGE_DEFAULT=None,
    )
    if config.TRUST_PROXY:
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    migrate()

    from . import api, pages, watch
    app.register_blueprint(api.bp)
    app.register_blueprint(watch.bp)
    app.register_blueprint(pages.bp)

    app.before_request(csrf_protect)
    app.after_request(security_headers)
    app.teardown_appcontext(close_db)

    @app.errorhandler(404)
    def not_found(_error):
        if request.path.startswith("/api/"):
            return jsonify(error="not_found"), 404
        from .pages import spa
        return spa(), 404

    @app.errorhandler(413)
    def too_large(_error):
        return jsonify(error="payload_too_large"), 413

    @app.errorhandler(500)
    def server_error(_error):
        return jsonify(error="server_error"), 500

    return app
