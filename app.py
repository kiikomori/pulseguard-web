"""Entry point. systemd/gunicorn keep using `app:app`; `python app.py` runs a local dev server."""
import os

from pulseguard import config, create_app

app = create_app()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")), debug=config.DEBUG)
