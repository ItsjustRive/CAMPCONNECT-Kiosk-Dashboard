"""Create the initial owner account without saving a plaintext password."""
import getpass
from datetime import datetime, timezone

from werkzeug.security import generate_password_hash
from server import connect_db, init_db

init_db()
with connect_db() as con:
    if con.execute("SELECT 1 FROM users WHERE role='owner' LIMIT 1").fetchone():
        print("An owner account already exists; no changes were made.")
        raise SystemExit(0)

username = input("Owner username [Administrator]: ").strip() or "Administrator"
while True:
    password = getpass.getpass("Set owner password: ")
    confirm = getpass.getpass("Confirm owner password: ")
    if password != confirm:
        print("Passwords did not match. Try again.")
    elif len(password) < 12:
        print("Use at least 12 characters.")
    else:
        break
with connect_db() as con:
    con.execute("INSERT INTO users(username,password_hash,role,active,created_at) VALUES(?,?, 'owner',1,?)",
                (username, generate_password_hash(password), datetime.now(timezone.utc).isoformat(timespec="seconds")))
print("Owner account created. The password was stored as a hash.")
