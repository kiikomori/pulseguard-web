"""Reset the LOCAL demo database to its starting state. Never for the live server.

Deletes the demo database and builds it again from scratch:
  * admin       / INITIAL_ADMIN_PASSWORD (default "admin demo password"); asks for a new password at first login
  * demo        / "rustig ademen bij de zee"      (Anne de Vries, 30 days of synthetic watch data, one open alert)
  * dr.jansen   / "zorgvuldig meekijken bij anne" (caregiver, already following Anne read-only)

Usage, from the top folder (the dev server may keep running; if Windows reports the file in use, stop it first):
    .venv/Scripts/python src/scripts/reset_demo.py            # asks for confirmation
    .venv/Scripts/python src/scripts/reset_demo.py --yes      # no question
Old browser sessions and API keys stop working. All data is synthetic.
"""
import argparse
import os
import subprocess
import sys

SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOP = os.path.dirname(SRC)
DEFAULT_DB = os.path.join(TOP, ".dev", "demo.db")

ADMIN_PASSWORD = "admin demo password"
CARER = {"username": "dr.jansen", "name": "Dr. M. Jansen", "password": "zorgvuldig meekijken bij anne"}


def refuse(reason: str) -> None:
    sys.exit(f"Niet gedaan: {reason}")


def safe_path(path: str) -> str:
    """Only ever touch a database in a folder called .dev; never anything that looks like the live server."""
    path = os.path.abspath(path)
    normalised = path.replace("\\", "/")
    if normalised.startswith(("/var/", "/opt/", "/srv/", "/etc/")):
        refuse(f"{path} lijkt op de live server.")
    if os.path.basename(os.path.dirname(path)) != ".dev":
        refuse(f"{path} staat niet in een map .dev. Dit script reset alleen de lokale demodatabase.")
    if not path.endswith(".db"):
        refuse(f"{path} is geen .db-bestand.")
    return path


def delete_database(path: str) -> None:
    # All or nothing: first move every file aside; if one is locked, put the others back and stop,
    # so a half-finished reset never leaves the demo database missing.
    moved = []
    for suffix in ("-wal", "-shm", "-journal", ""):
        target = path + suffix
        if os.path.exists(target):
            try:
                os.replace(target, target + ".resetting")
                moved.append(target)
            except PermissionError:
                for done in moved:
                    os.replace(done + ".resetting", done)
                refuse(f"{target} is in gebruik. Stop eerst de dev-server en probeer het opnieuw. Er is niets veranderd.")
    for done in moved:
        os.remove(done + ".resetting")


def main() -> None:
    parser = argparse.ArgumentParser(description="Reset the local PulseGuard demo database.")
    parser.add_argument("--db", default=DEFAULT_DB, help="demo database (must be inside a .dev folder)")
    parser.add_argument("--yes", action="store_true", help="don't ask for confirmation")
    parser.add_argument("--admin-password", default=os.environ.get("INITIAL_ADMIN_PASSWORD") or ADMIN_PASSWORD)
    args = parser.parse_args()

    path = safe_path(args.db)
    if not args.yes:
        answer = input(f"Alle gegevens in {path} worden verwijderd en opnieuw opgebouwd. Doorgaan? [j/N] ")
        if answer.strip().lower() not in ("j", "ja", "y", "yes"):
            refuse("afgebroken.")

    os.makedirs(os.path.dirname(path), exist_ok=True)
    delete_database(path)

    # Fresh schema and the admin account (with "change password at first login"), exactly as on a first start.
    os.environ["HEALTH_QUEST_DB"] = path
    os.environ["INITIAL_ADMIN_PASSWORD"] = args.admin_password
    sys.path.insert(0, SRC)
    from werkzeug.security import generate_password_hash
    from pulseguard import config, db
    db.migrate(path)

    # The demo patient with synthetic data, through the normal seed script.
    subprocess.run([sys.executable, os.path.join(SRC, "scripts", "seed_demo.py"), "--alert"],
                   env=dict(os.environ), cwd=SRC, check=True, stdout=subprocess.DEVNULL)

    # The caregiver, already following the demo patient read-only.
    connection = db.connect(path)
    try:
        owner = connection.execute("SELECT id FROM users WHERE username='demo'").fetchone()["id"]
        carer = db.insert(connection, "users", {
            "name": CARER["name"], "username": CARER["username"], "password_hash": generate_password_hash(CARER["password"]),
            "created_at": db.utc_now(), "friend_code": db.make_friend_code(connection),
            "consent_at": db.utc_now(), "consent_version": config.CONSENT_VERSION})
        db.insert(connection, "care_grants", {"owner_id": owner, "caregiver_id": carer, "label": "Dr. Jansen", "created_at": db.utc_now()})
        connection.commit()
    finally:
        connection.close()

    print(f"Demodatabase opnieuw opgebouwd: {path}")
    print(f"  admin      / {args.admin_password}   (nieuw wachtwoord kiezen bij eerste keer inloggen)")
    print("  demo       / rustig ademen bij de zee")
    print(f"  {CARER['username']}  / {CARER['password']}   (kijkt mee met Anne de Vries)")
    print("Oude sessies en API-sleutels werken niet meer: log opnieuw in en maak zo nodig een nieuwe sleutel op /api.")


if __name__ == "__main__":
    main()
