"""Local Flask service for the Balakbak kiosk prototype."""
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path
import os
import platform
import re
import secrets
import sqlite3
import socket
import subprocess
import tempfile
import csv
import io
import math
import xml.etree.ElementTree as ET

from flask import Flask, abort, jsonify, redirect, request, send_file, send_from_directory, session, url_for
from werkzeug.security import check_password_hash

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
REPORTS = DATA / "reports"
DB = DATA / "kiosk.sqlite3"
SECRET_FILE = DATA / ".flask-secret"
DATA.mkdir(exist_ok=True)
REPORTS.mkdir(exist_ok=True)

def _secret_key():
    if not SECRET_FILE.exists():
        SECRET_FILE.write_text(secrets.token_urlsafe(48), encoding="utf-8")
    return SECRET_FILE.read_text(encoding="utf-8").strip()


app = Flask(__name__, static_folder=None)
app.secret_key = os.environ.get("KIOSK_SECRET_KEY") or _secret_key()
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax", PERMANENT_SESSION_LIFETIME=timedelta(hours=8))
app.config["DEMO_ACTIVE"] = False
app.config["DEMO_SESSIONS"] = []
app.config["DEMO_HAS_CAMPER_INPUT"] = False
app.config["DEMO_RECOVERY_AUDIT"] = []
app.config["DEMO_REPORT_SESSIONS"] = []
app.config["DEMO_FEEDBACK"] = []
app.config["DEMO_PIN_HASHES"] = {}
app.config["HARDWARE_STATUS"] = {
    "battery_detected": False, "battery_percent": None, "lora_connected": False,
    "energy_meter_detected": False, "energy_kwh": None,
    "gps_fix": False, "latitude": None, "longitude": None, "gps_accuracy_m": None,
    "gps_updated_at": None, "responder_latitude": None, "responder_longitude": None,
    "responder_updated_at": None, "responder_alert_id": None,
}

def default_demo_sessions():
    return []


def default_demo_report_sessions():
    now = datetime.now().astimezone()
    examples = [
        ("Demo Camper One", "02", 100, 30, 0.42, 0),
        ("Demo Camper Two", "03", 50, 24, 0.31, 3),
        ("Demo Camper Three", "01", 80, 45, 0.57, 10),
    ]
    rows = []
    for name, locker, paid, minutes, energy, days_ago in examples:
        returned_at = now - timedelta(days=days_ago)
        rows.append({
            "id": f"demo-sample-{locker}", "name": name, "locker": locker,
            "paid": paid, "minutes": minutes, "used": f"{minutes} min",
            "status": "Completed", "energy": energy,
            "started": (returned_at - timedelta(minutes=minutes)).strftime("%I:%M %p").lstrip("0"),
            "returned": returned_at.strftime("%I:%M %p").lstrip("0"),
            "created_at": returned_at.isoformat(timespec="seconds"), "demo_sample": True,
        })
    return rows


def default_demo_feedback():
    now = datetime.now().astimezone()
    return [
        {"locker": "02", "rating": 5, "comment": "Quick and easy to use.", "created_at": (now - timedelta(hours=2)).isoformat(timespec="seconds")},
        {"locker": "03", "rating": 4, "comment": "Charging worked well.", "created_at": (now - timedelta(hours=5)).isoformat(timespec="seconds")},
        {"locker": "01", "rating": 3, "comment": "Could use clearer instructions.", "created_at": (now - timedelta(days=2)).isoformat(timespec="seconds")},
    ]


def connect_db():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    with connect_db() as con:
        con.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','staff')),
            active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS audit (
            id INTEGER PRIMARY KEY, actor_id INTEGER, action TEXT NOT NULL,
            subject TEXT, created_at TEXT NOT NULL,
            FOREIGN KEY(actor_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS camper_sessions (
            id TEXT PRIMARY KEY, camper_name TEXT NOT NULL, locker TEXT NOT NULL,
            paid_php INTEGER NOT NULL DEFAULT 0, minutes_paid INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT,
            ended_at TEXT, used_minutes INTEGER NOT NULL DEFAULT 0,
            energy_kwh REAL
        );
        CREATE INDEX IF NOT EXISTS idx_camper_sessions_started ON camper_sessions(started_at);
        CREATE INDEX IF NOT EXISTS idx_camper_sessions_status ON camper_sessions(status);
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS emergency_alerts (
            id TEXT PRIMARY KEY, alert_type TEXT NOT NULL, details TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'New', created_at TEXT NOT NULL,
            resolved_at TEXT, latitude REAL, longitude REAL, gps_accuracy_m REAL
        );
        CREATE TABLE IF NOT EXISTS camper_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT, locker TEXT NOT NULL,
            rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
            comment TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
        );
        INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES('communication_mode','lora',CURRENT_TIMESTAMP);
        """)
        emergency_columns = {row[1] for row in con.execute("PRAGMA table_info(emergency_alerts)").fetchall()}
        for column in ("latitude", "longitude", "gps_accuracy_m"):
            if column not in emergency_columns:
                con.execute(f"ALTER TABLE emergency_alerts ADD COLUMN {column} REAL")
        if "is_demo" not in emergency_columns:
            con.execute("ALTER TABLE emergency_alerts ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0")
        # A process restart ends the in-memory demo; discard its leftover alerts too.
        con.execute("DELETE FROM emergency_alerts WHERE is_demo=1")
        feedback_columns = {row[1] for row in con.execute("PRAGMA table_info(camper_feedback)").fetchall()}
        if "session_id" in feedback_columns:
            # Replace the old session-linked table with anonymous locker-only records.
            con.executescript("""
                CREATE TABLE camper_feedback_anonymous (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, locker TEXT NOT NULL,
                    rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
                    comment TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
                );
                INSERT INTO camper_feedback_anonymous(locker,rating,comment,created_at)
                SELECT COALESCE(s.locker,'—'),f.rating,f.comment,f.created_at
                FROM camper_feedback f LEFT JOIN camper_sessions s ON s.id=f.session_id;
                DROP TABLE camper_feedback;
                ALTER TABLE camper_feedback_anonymous RENAME TO camper_feedback;
            """)


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def accepted_payment_minutes(paid):
    if isinstance(paid, int) and not isinstance(paid, bool) and 10 <= paid <= 100 and paid % 10 == 0:
        return (paid // 10) * 30
    return 0


def valid_coin_total(paid):
    return isinstance(paid, int) and not isinstance(paid, bool) and 0 <= paid <= 100 and paid % 5 == 0


def session_record(row):
    started = row["started_at"] or row["created_at"]
    started_local = datetime.fromisoformat(started).astimezone().strftime("%I:%M %p").lstrip("0")
    return {
        "id": row["id"], "name": row["camper_name"], "locker": row["locker"],
        "paid": row["paid_php"], "minutes": row["minutes_paid"],
        "started": started_local, "used": f'{row["used_minutes"]} min',
        "status": row["status"], "energy": row["energy_kwh"],
        "returned": datetime.fromisoformat(row["ended_at"]).astimezone().strftime("%I:%M %p").lstrip("0") if row["ended_at"] else "—",
    }


def completed_session_rows(start=None, end=None):
    query = "SELECT * FROM camper_sessions WHERE status IN ('Completed','Recovered')"
    params = []
    if start:
        query += " AND ended_at >= ?"
        params.append(start)
    if end:
        query += " AND ended_at < ?"
        params.append(end)
    query += " ORDER BY ended_at DESC"
    with connect_db() as con:
        return [session_record(row) for row in con.execute(query, params).fetchall()]


def communication_mode():
    with connect_db() as con:
        row = con.execute("SELECT value FROM settings WHERE key='communication_mode'").fetchone()
    return row["value"] if row else "lora"


def wifi_is_connected():
    system = platform.system()
    try:
        if system == "Windows":
            result = subprocess.run(["netsh", "wlan", "show", "interfaces"], capture_output=True, text=True, timeout=3, check=False)
            return result.returncode == 0 and bool(re.search(r"^\s*State\s*:\s*connected\s*$", result.stdout, re.IGNORECASE | re.MULTILINE))
        if system == "Linux":
            interfaces = [item.name for item in Path("/sys/class/net").iterdir() if (Path("/sys/class/net") / item.name / "wireless").exists()]
            for interface in interfaces:
                result = subprocess.run(["iw", "dev", interface, "link"], capture_output=True, text=True, timeout=3, check=False)
                if result.returncode == 0 and "connected to" in result.stdout.lower():
                    return True
                result = subprocess.run(["iwgetid", interface, "-r"], capture_output=True, text=True, timeout=3, check=False)
                if result.returncode == 0 and result.stdout.strip():
                    return True
    except (OSError, subprocess.SubprocessError):
        return False
    return False


def wifi_adapter_available():
    system = platform.system()
    try:
        if system == "Windows":
            result = subprocess.run(["netsh", "wlan", "show", "interfaces"], capture_output=True, text=True, timeout=3, check=False)
            return result.returncode == 0 and bool(re.search(r"^\s*Name\s*:", result.stdout, re.IGNORECASE | re.MULTILINE))
        if system == "Linux":
            return any((Path("/sys/class/net") / item.name / "wireless").exists() for item in Path("/sys/class/net").iterdir())
    except (OSError, subprocess.SubprocessError):
        return False
    return False


def local_network_ip():
    """Find the IPv4 address the kiosk uses to reach devices on its local network."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # UDP connect selects a route but sends no packet to this documentation-only address.
        probe.connect(("192.0.2.1", 80))
        address = probe.getsockname()[0]
        if address and not address.startswith("127."):
            return address
    except OSError:
        pass
    finally:
        probe.close()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            address = info[4][0]
            if address and not address.startswith("127.") and not address.startswith("169.254."):
                return address
    except OSError:
        pass
    return None


def scan_wifi_networks():
    """Return visible nearby networks using the host operating system's Wi-Fi tools."""
    system = platform.system()
    networks = {}
    if system == "Windows":
        result = subprocess.run(["netsh", "wlan", "show", "networks", "mode=bssid"], capture_output=True, text=True, timeout=10, check=False)
        if result.returncode != 0:
            raise RuntimeError("Windows could not scan for Wi-Fi networks. Check that the Wi-Fi adapter is enabled.")
        current = None
        for line in result.stdout.splitlines():
            match = re.match(r"\s*SSID\s+\d+\s*:\s*(.*)$", line, re.IGNORECASE)
            if match:
                current = {"ssid": match.group(1).strip(), "signal": 0, "security": "Open"}
                if current["ssid"]:
                    current = networks.setdefault(current["ssid"], current)
                continue
            if not current:
                continue
            match = re.match(r"\s*Authentication\s*:\s*(.*)$", line, re.IGNORECASE)
            if match:
                current["security"] = match.group(1).strip() or "Open"
            match = re.match(r"\s*Signal\s*:\s*(\d+)%", line, re.IGNORECASE)
            if match:
                current["signal"] = max(current["signal"], int(match.group(1)))
    elif system == "Linux":
        result = subprocess.run(["nmcli", "--terse", "--escape", "yes", "--fields", "SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "yes"], capture_output=True, text=True, timeout=15, check=False)
        if result.returncode != 0:
            raise RuntimeError("Could not scan Wi-Fi. Ensure NetworkManager and nmcli are installed and running.")
        for line in result.stdout.splitlines():
            fields, value, escaped = [], [], False
            for char in line:
                if escaped:
                    value.append(char)
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == ":":
                    fields.append("".join(value)); value = []
                else:
                    value.append(char)
            fields.append("".join(value))
            if len(fields) < 3:
                continue
            ssid, signal, security = fields[0].strip(), fields[1].strip(), fields[2].strip() or "Open"
            if not ssid:
                continue
            network = {"ssid": ssid, "signal": int(signal) if signal.isdigit() else 0, "security": security}
            if ssid not in networks or network["signal"] > networks[ssid]["signal"]:
                networks[ssid] = network
    else:
        raise RuntimeError("Wi-Fi scanning is currently supported on Windows and Raspberry Pi OS with NetworkManager.")
    return sorted(networks.values(), key=lambda item: (-item["signal"], item["ssid"].casefold()))


def connect_wifi_network(ssid, password, security):
    """Connect through Windows WLAN or NetworkManager; this app does not persist the password."""
    system = platform.system()
    if "enterprise" in security.casefold() or "802.1x" in security.casefold():
        raise RuntimeError("This network requires enterprise sign-in, which the kiosk Wi-Fi setup does not support yet.")
    if system == "Linux":
        command = ["nmcli", "--wait", "30", "device", "wifi", "connect", ssid]
        if security != "Open":
            command.extend(["password", password])
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=40, check=False)
        except subprocess.TimeoutExpired:
            raise RuntimeError("The Wi-Fi connection attempt timed out. Check the signal and try again.") from None
        if result.returncode != 0:
            # Do not return command output because some nmcli versions include sensitive data.
            raise RuntimeError("NetworkManager could not connect. Check the password, signal, and Wi-Fi security type.")
        return
    if system == "Windows":
        profile_id = "CampConnect-" + secrets.token_hex(6)
        namespace = "http://www.microsoft.com/networking/WLAN/profile/v1"
        ET.register_namespace("", namespace)
        tag = lambda name: f"{{{namespace}}}{name}"
        profile = ET.Element(tag("WLANProfile"))
        ET.SubElement(profile, tag("name")).text = profile_id
        ssid_config = ET.SubElement(profile, tag("SSIDConfig"))
        ssid_node = ET.SubElement(ssid_config, tag("SSID"))
        ET.SubElement(ssid_node, tag("name")).text = ssid
        ET.SubElement(profile, tag("connectionType")).text = "ESS"
        ET.SubElement(profile, tag("connectionMode")).text = "manual"
        msm = ET.SubElement(profile, tag("MSM"))
        security_node = ET.SubElement(msm, tag("security"))
        auth = ET.SubElement(security_node, tag("authEncryption"))
        if security.casefold() == "open":
            authentication, encryption = "open", "none"
        elif "wpa3" in security.casefold():
            authentication, encryption = "WPA3SAE", "AES"
        elif "wpa2" in security.casefold():
            authentication, encryption = "WPA2PSK", "AES"
        elif "wpa-personal" in security.casefold() or security.casefold() == "wpa":
            authentication, encryption = "WPAPSK", "AES"
        else:
            raise RuntimeError("This network uses enterprise or unsupported Wi-Fi security. Use a personal Wi-Fi network.")
        ET.SubElement(auth, tag("authentication")).text = authentication
        ET.SubElement(auth, tag("encryption")).text = encryption
        ET.SubElement(auth, tag("useOneX")).text = "false"
        if authentication not in {"open"}:
            shared = ET.SubElement(security_node, tag("sharedKey"))
            ET.SubElement(shared, tag("keyType")).text = "passPhrase"
            ET.SubElement(shared, tag("protected")).text = "false"
            ET.SubElement(shared, tag("keyMaterial")).text = password
        temporary_profile = None
        try:
            with tempfile.NamedTemporaryFile(mode="wb", suffix=".xml", prefix="wifi-profile-", delete=False) as handle:
                temporary_profile = Path(handle.name)
                handle.write(ET.tostring(profile, encoding="utf-8", xml_declaration=True))
            added = subprocess.run(["netsh", "wlan", "add", "profile", f"filename={temporary_profile}", "user=current"], capture_output=True, text=True, timeout=10, check=False)
            if added.returncode != 0:
                raise RuntimeError("Windows could not save the temporary Wi-Fi profile. Check the adapter and account permissions.")
            connected = subprocess.run(["netsh", "wlan", "connect", f"name={profile_id}", f"ssid={ssid}"], capture_output=True, text=True, timeout=15, check=False)
            if connected.returncode != 0:
                raise RuntimeError("Windows could not start the Wi-Fi connection. Check the adapter and try again.")
        finally:
            if temporary_profile:
                temporary_profile.unlink(missing_ok=True)
        return
    raise RuntimeError("Wi-Fi joining is currently supported on Windows and Raspberry Pi OS with NetworkManager.")


def audit(action, subject=None):
    with connect_db() as con:
        con.execute("INSERT INTO audit(actor_id, action, subject, created_at) VALUES(?,?,?,?)",
                    (session.get("user_id"), action, subject, now_iso()))


def require_role(role):
    def decorator(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            if session.get("role") != role:
                if request.path.startswith("/api/"):
                    return jsonify(error="Please sign in with the required account."), 401
                return redirect(url_for("login_page"))
            return fn(*args, **kwargs)
        return wrapped
    return decorator


def cleanup_expired_reports():
    cutoff = datetime.now(timezone.utc) - timedelta(days=60)
    for path in REPORTS.iterdir():
        if path.is_file() and path.suffix.lower() in {".xlsx", ".csv"}:
            try:
                modified = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
                if modified < cutoff:
                    path.unlink()
            except (OSError, ValueError):
                app.logger.exception("Could not clean expired report %s", path.name)


def cleanup_expired_sessions():
    cutoff = (datetime.now(timezone.utc) - timedelta(days=60)).isoformat(timespec="seconds")
    with connect_db() as con:
        con.execute("DELETE FROM camper_feedback WHERE created_at < ?", (cutoff,))
        con.execute("DELETE FROM camper_sessions WHERE ended_at IS NOT NULL AND ended_at < ?", (cutoff,))


init_db()
cleanup_expired_reports()
cleanup_expired_sessions()


@app.get("/")
def root():
    return redirect("/camper.html")


@app.get("/login")
def login_page():
    return send_from_directory(ROOT, "auth.html")


@app.get("/<path:asset>")
def page_or_asset(asset):
    allowed_assets = {"auth.css", "auth.js", "camper.html", "camper.css", "camper.js", "staff.html", "staff.css", "staff.js", "owner.html", "owner.css", "owner.js", "phone.html", "phone.css", "phone.js", "index.html", "portal.css"}
    if asset not in allowed_assets:
        abort(404)
    if asset.startswith("owner.") or asset == "owner.html":
        if session.get("role") != "owner": return redirect(url_for("login_page"))
    if asset.startswith("staff.") or asset == "staff.html":
        if session.get("role") not in {"staff", "owner"}: return redirect(url_for("login_page"))
        if session.get("role") == "owner" and not app.config["DEMO_ACTIVE"]: return redirect("/owner.html")
    if asset == "owner.html" and session.get("role") != "owner":
        return redirect("/login")
    return send_from_directory(ROOT, asset)


@app.post("/api/login")
def login():
    payload = request.get_json(silent=True) or {}
    role, username, password = payload.get("role"), str(payload.get("username", "")).strip(), payload.get("password", "")
    if role not in {"owner", "staff"} or not username or not isinstance(password, str):
        return jsonify(error="Enter a valid username and password."), 400
    with connect_db() as con:
        user = con.execute("SELECT * FROM users WHERE username=? AND active=1", (username,)).fetchone()
    if not user or user["role"] != role or not check_password_hash(user["password_hash"], password):
        return jsonify(error="The account type or credentials do not match."), 401
    session.clear()
    session.permanent = True
    session.update(user_id=user["id"], username=user["username"], role=user["role"])
    return jsonify(redirect="/owner.html" if role == "owner" else "/staff.html")


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/me")
def me():
    if "user_id" not in session: return jsonify(error="Sign in required."), 401
    return jsonify(username=session["username"], role=session["role"])


@app.get("/api/connectivity/status")
def connectivity_status():
    mode = communication_mode()
    wifi_connected = wifi_is_connected()
    hardware = app.config["HARDWARE_STATUS"]
    lora_connected = bool(hardware["lora_connected"])
    lan_ip = local_network_ip()
    ethernet_connected = bool(lan_ip and not wifi_connected)
    active_link = "wifi" if mode == "wifi" and wifi_connected else "lan" if mode == "wifi" and ethernet_connected else "lora" if mode == "lora" and lora_connected else "lora" if mode == "wifi" and not wifi_connected and not ethernet_connected and lora_connected else None
    phone_link_available = wifi_connected or ethernet_connected
    battery_detected = bool(hardware["battery_detected"] and hardware["battery_percent"] is not None)
    gps_fix = bool(hardware.get("gps_fix") and hardware.get("latitude") is not None and hardware.get("longitude") is not None)
    with connect_db() as con:
        active_sos_row = con.execute("""
            SELECT id,status,latitude,longitude,created_at FROM emergency_alerts
            WHERE status!='Resolved' ORDER BY created_at DESC LIMIT 1
        """).fetchone()
    active_sos = dict(active_sos_row) if active_sos_row else None
    return jsonify(mode=mode, wifi_connected=wifi_connected, lora_connected=lora_connected,
                   active_link=active_link, battery_detected=battery_detected,
                   battery_percent=hardware["battery_percent"] if battery_detected else None,
                   energy_meter_detected=bool(hardware.get("energy_meter_detected")),
                   energy_kwh=hardware.get("energy_kwh") if hardware.get("energy_meter_detected") else None,
                   gps_fix=gps_fix, latitude=hardware.get("latitude") if gps_fix else None,
                   longitude=hardware.get("longitude") if gps_fix else None,
                   gps_accuracy_m=hardware.get("gps_accuracy_m") if gps_fix else None,
                   gps_updated_at=hardware.get("gps_updated_at"),
                   responder_latitude=hardware.get("responder_latitude"),
                   responder_longitude=hardware.get("responder_longitude"),
                   responder_updated_at=hardware.get("responder_updated_at"),
                   responder_alert_id=hardware.get("responder_alert_id"),
                   active_sos=active_sos,
                   wifi_adapter_available=wifi_adapter_available(), ethernet_connected=ethernet_connected,
                   network_type="Wi-Fi" if wifi_connected else "Ethernet" if ethernet_connected else None,
                   lan_ip=lan_ip if phone_link_available else None,
                   phone_url=f"http://{lan_ip}:5000/phone.html" if phone_link_available and lan_ip else None)


@app.post("/api/emergency")
def create_emergency_alert():
    payload = request.get_json(silent=True) or {}
    alert_type = str(payload.get("type", "")).strip()
    details = str(payload.get("details", "")).strip()
    allowed_types = {"Wounded camper", "Wounded staff member", "Missing camper", "Other emergency"}
    if alert_type not in allowed_types or len(details) > 120:
        return jsonify(error="Choose an emergency type and keep details to 120 characters."), 400
    latitude, longitude = payload.get("latitude"), payload.get("longitude")
    accuracy = payload.get("gps_accuracy_m")
    if latitude is not None or longitude is not None:
        if (not isinstance(latitude, (int, float)) or isinstance(latitude, bool)
                or not isinstance(longitude, (int, float)) or isinstance(longitude, bool)
                or not math.isfinite(latitude) or not math.isfinite(longitude)
                or not -90 <= latitude <= 90 or not -180 <= longitude <= 180):
            return jsonify(error="The kiosk GPS coordinates are invalid."), 400
    if accuracy is not None and (not isinstance(accuracy, (int, float)) or isinstance(accuracy, bool)
                                 or not math.isfinite(accuracy) or accuracy < 0):
        return jsonify(error="GPS accuracy must be a non-negative number of meters."), 400
    status = connectivity_status().get_json()
    transport = status["active_link"]
    # In a demo, the phone can still receive the alert from the kiosk over its
    # local network even when LoRa is selected but the radio is not connected.
    if app.config["DEMO_ACTIVE"] and transport is None:
        if status.get("wifi_connected"):
            transport = "wifi"
        elif status.get("ethernet_connected"):
            transport = "lan"
    if transport not in {"wifi", "lan", "lora"}:
        return jsonify(error="No communication link is available for the SOS."), 503
    alert_id = secrets.token_urlsafe(12)
    created = now_iso()
    delivery_status = "Queued for LoRa" if transport == "lora" else "New"
    with connect_db() as con:
        con.execute("INSERT INTO emergency_alerts(id,alert_type,details,status,created_at,latitude,longitude,gps_accuracy_m,is_demo) VALUES(?,?,?,?,?,?,?,?,?)",
                    (alert_id, alert_type, details, delivery_status, created, latitude, longitude, accuracy, int(app.config["DEMO_ACTIVE"])))
    return jsonify(ok=True, id=alert_id, created_at=created, transport=transport,
                   queued=transport == "lora", demo=bool(app.config["DEMO_ACTIVE"]), gps_attached=latitude is not None), 201


@app.get("/api/hardware/emergency-outbox")
def hardware_emergency_outbox():
    if request.remote_addr not in {"127.0.0.1", "::1"}:
        return jsonify(error="Hardware SOS queue is available only to the kiosk bridge."), 403
    with connect_db() as con:
        rows = con.execute("""
            SELECT id,alert_type,details,created_at,latitude,longitude,gps_accuracy_m,is_demo
            FROM emergency_alerts WHERE status='Queued for LoRa' ORDER BY created_at ASC LIMIT 20
        """).fetchall()
    return jsonify(alerts=[dict(row) for row in rows])


@app.post("/api/hardware/emergency-outbox/<alert_id>/ack")
def acknowledge_hardware_emergency(alert_id):
    if request.remote_addr not in {"127.0.0.1", "::1"}:
        return jsonify(error="Hardware SOS acknowledgement is available only to the kiosk bridge."), 403
    payload = request.get_json(silent=True) or {}
    sent = payload.get("sent")
    if not isinstance(sent, bool):
        return jsonify(error="Provide sent as true or false."), 400
    next_status = "Sent over LoRa" if sent else "LoRa send failed"
    with connect_db() as con:
        cursor = con.execute("UPDATE emergency_alerts SET status=? WHERE id=? AND status='Queued for LoRa'", (next_status, alert_id))
    if cursor.rowcount == 0:
        return jsonify(error="Queued SOS not found."), 404
    return jsonify(ok=True, status=next_status)


@app.get("/api/mobile/alerts")
def mobile_alerts():
    if session.get("role") not in {"staff", "owner"}:
        return jsonify(error="Sign in with a staff or owner account on the phone."), 401
    with connect_db() as con:
        rows = con.execute("SELECT id,alert_type,details,status,created_at,resolved_at,latitude,longitude,gps_accuracy_m,is_demo FROM emergency_alerts ORDER BY created_at DESC LIMIT 100").fetchall()
    return jsonify(alerts=[dict(row) for row in rows])


@app.post("/api/mobile/alerts/<alert_id>/resolve")
def resolve_mobile_alert(alert_id):
    if session.get("role") not in {"staff", "owner"}:
        return jsonify(error="Sign in with a staff or owner account on the phone."), 401
    now = now_iso()
    with connect_db() as con:
        cursor = con.execute("UPDATE emergency_alerts SET status='Resolved', resolved_at=? WHERE id=?", (now, alert_id))
    if cursor.rowcount == 0:
        return jsonify(error="Emergency alert not found."), 404
    return jsonify(ok=True)


@app.post("/api/hardware/telemetry")
def update_hardware_telemetry():
    if request.remote_addr not in {"127.0.0.1", "::1"}:
        return jsonify(error="Hardware telemetry is accepted only from this device."), 403
    payload = request.get_json(silent=True) or {}
    detected = payload.get("battery_detected") is True
    percent = payload.get("battery_percent")
    if detected and (not isinstance(percent, (int, float)) or isinstance(percent, bool) or not 0 <= percent <= 100):
        return jsonify(error="A detected battery must report a percentage from 0 to 100."), 400
    current = app.config["HARDWARE_STATUS"]
    energy_detected = payload.get("energy_meter_detected") is True
    energy_kwh = payload.get("energy_kwh")
    if energy_detected and (not isinstance(energy_kwh, (int, float)) or isinstance(energy_kwh, bool)
                            or not math.isfinite(energy_kwh) or energy_kwh < 0):
        return jsonify(error="A detected energy meter must report a non-negative kWh reading."), 400
    gps_fields_present = any(key in payload for key in ("gps_fix", "latitude", "longitude", "gps_accuracy_m"))
    gps_fix = payload.get("gps_fix") is True
    latitude, longitude = payload.get("latitude"), payload.get("longitude")
    accuracy = payload.get("gps_accuracy_m")
    if gps_fix and (
        not isinstance(latitude, (int, float)) or isinstance(latitude, bool)
        or not isinstance(longitude, (int, float)) or isinstance(longitude, bool)
        or not math.isfinite(latitude) or not math.isfinite(longitude)
        or not -90 <= latitude <= 90 or not -180 <= longitude <= 180
    ):
        return jsonify(error="A GPS fix requires valid latitude and longitude coordinates."), 400
    if accuracy is not None and (not isinstance(accuracy, (int, float)) or isinstance(accuracy, bool)
                                 or not math.isfinite(accuracy) or accuracy < 0):
        return jsonify(error="GPS accuracy must be a non-negative number of meters."), 400
    responder_lat, responder_lon = payload.get("responder_latitude"), payload.get("responder_longitude")
    responder_fields_present = "responder_latitude" in payload or "responder_longitude" in payload
    if responder_fields_present and (
        not isinstance(responder_lat, (int, float)) or isinstance(responder_lat, bool)
        or not isinstance(responder_lon, (int, float)) or isinstance(responder_lon, bool)
        or not math.isfinite(responder_lat) or not math.isfinite(responder_lon)
        or not -90 <= responder_lat <= 90 or not -180 <= responder_lon <= 180
    ):
        return jsonify(error="Rescuer location requires valid latitude and longitude coordinates."), 400
    app.config["HARDWARE_STATUS"] = {
        "battery_detected": detected,
        "battery_percent": round(float(percent)) if detected else None,
        "lora_connected": payload.get("lora_connected") is True,
        "energy_meter_detected": energy_detected if "energy_meter_detected" in payload else current.get("energy_meter_detected", False),
        "energy_kwh": float(energy_kwh) if energy_detected else None if "energy_meter_detected" in payload else current.get("energy_kwh"),
        "gps_fix": gps_fix if gps_fields_present else current.get("gps_fix", False),
        "latitude": float(latitude) if gps_fix else None if gps_fields_present else current.get("latitude"),
        "longitude": float(longitude) if gps_fix else None if gps_fields_present else current.get("longitude"),
        "gps_accuracy_m": float(accuracy) if gps_fix and accuracy is not None else None if gps_fields_present else current.get("gps_accuracy_m"),
        "gps_updated_at": now_iso() if gps_fields_present else current.get("gps_updated_at"),
        "responder_latitude": float(responder_lat) if responder_fields_present else current.get("responder_latitude"),
        "responder_longitude": float(responder_lon) if responder_fields_present else current.get("responder_longitude"),
        "responder_updated_at": now_iso() if responder_fields_present else current.get("responder_updated_at"),
        "responder_alert_id": str(payload.get("responder_alert_id", ""))[:80] or None if responder_fields_present else current.get("responder_alert_id"),
    }
    return jsonify(ok=True)


@app.get("/api/owner/connectivity")
@require_role("owner")
def owner_connectivity():
    return jsonify(mode=communication_mode())


@app.put("/api/owner/connectivity")
@require_role("owner")
def update_connectivity():
    payload = request.get_json(silent=True) or {}
    mode = payload.get("mode")
    if mode not in {"wifi", "lora"}:
        return jsonify(error="Choose Wi-Fi or LoRa."), 400
    with connect_db() as con:
        con.execute("INSERT INTO settings(key,value,updated_at) VALUES('communication_mode',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", (mode, now_iso()))
    audit("communication_mode_changed", mode)
    return jsonify(mode=mode)


@app.get("/api/owner/wifi/networks")
@require_role("owner")
def owner_wifi_networks():
    try:
        return jsonify(networks=scan_wifi_networks())
    except (OSError, subprocess.SubprocessError, RuntimeError) as error:
        return jsonify(error=str(error)), 503


@app.post("/api/owner/wifi/connect")
@require_role("owner")
def owner_wifi_connect():
    payload = request.get_json(silent=True) or {}
    ssid = payload.get("ssid")
    password = payload.get("password", "")
    if not isinstance(ssid, str) or not ssid.strip() or len(ssid.encode("utf-8")) > 32:
        return jsonify(error="Choose a visible Wi-Fi network."), 400
    if not isinstance(password, str) or len(password) > 63:
        return jsonify(error="Enter a valid Wi-Fi password."), 400
    ssid = ssid.strip()
    try:
        network = next((item for item in scan_wifi_networks() if item["ssid"] == ssid), None)
        if not network:
            return jsonify(error="That network is no longer visible. Scan again and choose a current network."), 409
        security = network["security"]
        if security != "Open" and len(password) < 8:
            return jsonify(error="This Wi-Fi password must be at least 8 characters."), 400
        connect_wifi_network(ssid, password, security)
    except (OSError, subprocess.SubprocessError, RuntimeError) as error:
        return jsonify(error=str(error)), 503
    audit("wifi_network_connect_requested", ssid)
    return jsonify(ok=True, message="Wi-Fi connection requested. The status will update when the kiosk joins the network.")


@app.get("/api/demo/status")
def demo_status():
    if session.get("role") not in {"owner", "staff"}:
        return jsonify(error="Please sign in with a staff or owner account."), 401
    return jsonify(active=bool(app.config["DEMO_ACTIVE"]))


@app.post("/api/owner/demo/start")
@require_role("owner")
def start_demo():
    app.config["DEMO_ACTIVE"] = True
    app.config["DEMO_SESSIONS"] = default_demo_sessions()
    app.config["DEMO_HAS_CAMPER_INPUT"] = False
    app.config["DEMO_RECOVERY_AUDIT"] = []
    app.config["DEMO_REPORT_SESSIONS"] = default_demo_report_sessions()
    app.config["DEMO_FEEDBACK"] = default_demo_feedback()
    app.config["DEMO_PIN_HASHES"] = {}
    audit("demo_started", session.get("username"))
    return jsonify(active=True)


@app.post("/api/owner/demo/stop")
@require_role("owner")
def stop_demo():
    app.config["DEMO_ACTIVE"] = False
    app.config["DEMO_SESSIONS"] = []
    app.config["DEMO_HAS_CAMPER_INPUT"] = False
    app.config["DEMO_RECOVERY_AUDIT"] = []
    app.config["DEMO_REPORT_SESSIONS"] = []
    app.config["DEMO_FEEDBACK"] = []
    app.config["DEMO_PIN_HASHES"] = {}
    with connect_db() as con:
        con.execute("DELETE FROM emergency_alerts WHERE is_demo=1")
    audit("demo_stopped", session.get("username"))
    return jsonify(active=False)


def require_active_owner_demo():
    if not app.config["DEMO_ACTIVE"]:
        return jsonify(error="Start owner demo mode first."), 409
    return None


@app.get("/api/owner/demo/sessions")
@require_role("owner")
def get_demo_sessions():
    inactive = require_active_owner_demo()
    if inactive:
        return inactive
    completed = [record for record in app.config["DEMO_SESSIONS"] if record.get("status") in {"Completed", "Recovered"}]
    feedback = list(app.config["DEMO_FEEDBACK"])
    feedback.extend({"locker": row["locker"], "rating": row["rating"], "comment": row.get("feedback", ""),
                     "created_at": row.get("returned_at", row.get("created_at"))}
                    for row in completed if row.get("rating"))
    return jsonify(sessions=app.config["DEMO_SESSIONS"], hasCamperInput=app.config["DEMO_HAS_CAMPER_INPUT"],
                   reportSessions=app.config["DEMO_REPORT_SESSIONS"] + completed,
                   feedback=feedback, recoveryAudit=app.config["DEMO_RECOVERY_AUDIT"])


def demo_feedback_rows():
    feedback = list(app.config["DEMO_FEEDBACK"])
    feedback.extend({"locker": row["locker"], "rating": row["rating"], "comment": row.get("feedback", ""),
                     "created_at": row.get("returned_at", row.get("created_at"))}
                    for row in app.config["DEMO_SESSIONS"]
                    if row.get("status") in {"Completed", "Recovered"} and row.get("rating"))
    return feedback


@app.post("/api/owner/demo/sessions")
@require_role("owner")
def create_demo_session():
    inactive = require_active_owner_demo()
    if inactive:
        return inactive
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "")).strip()
    locker = str(payload.get("locker", ""))
    if not name or len(name) > 80 or locker not in {"01", "02", "03"}:
        return jsonify(error="Enter a camper name and a valid locker."), 400
    if not app.config["DEMO_HAS_CAMPER_INPUT"]:
        app.config["DEMO_SESSIONS"] = []
        app.config["DEMO_HAS_CAMPER_INPUT"] = True
    record = {
        "id": secrets.token_urlsafe(12),
        "name": name,
        "locker": locker,
        "started": datetime.now().astimezone().strftime("%I:%M %p").lstrip("0"),
        "used": "0 min",
        "status": "Waiting for payment",
        "paid": 0,
        "minutes": 0,
        "energy": None,
        "energy_start": app.config["HARDWARE_STATUS"].get("energy_kwh") if app.config["HARDWARE_STATUS"].get("energy_meter_detected") else None,
        "created_at": now_iso(),
    }
    app.config["DEMO_SESSIONS"].append(record)
    return jsonify(session=record), 201


@app.post("/api/owner/demo/sessions/<session_id>/pin")
@require_role("owner")
def set_demo_pin(session_id):
    inactive = require_active_owner_demo()
    if inactive:
        return inactive
    payload = request.get_json(silent=True) or {}
    pin = payload.get("pin")
    if not isinstance(pin, str) or not re.fullmatch(r"\d{6}", pin):
        return jsonify(error="Demo PIN must contain exactly six digits."), 400
    if not any(row["id"] == session_id for row in app.config["DEMO_SESSIONS"]):
        return jsonify(error="Demo session not found."), 404
    from werkzeug.security import generate_password_hash
    app.config["DEMO_PIN_HASHES"][session_id] = generate_password_hash(pin)
    return jsonify(ok=True)


@app.post("/api/owner/demo/sessions/<session_id>/verify-pin")
@require_role("owner")
def verify_demo_pin(session_id):
    inactive = require_active_owner_demo()
    if inactive:
        return inactive
    payload = request.get_json(silent=True) or {}
    pin = payload.get("pin")
    if not isinstance(pin, str) or not re.fullmatch(r"\d{6}", pin):
        return jsonify(error="Enter a six-digit PIN."), 400
    if not any(row["id"] == session_id for row in app.config["DEMO_SESSIONS"]):
        return jsonify(error="Demo session not found."), 404
    pin_hash = app.config["DEMO_PIN_HASHES"].get(session_id)
    if not pin_hash:
        return jsonify(error="This older demo session has no saved PIN verifier. Restart that demo session to continue."), 409
    from werkzeug.security import check_password_hash
    return jsonify(valid=check_password_hash(pin_hash, pin))


@app.patch("/api/owner/demo/sessions/<session_id>")
@require_role("owner")
def update_demo_session(session_id):
    inactive = require_active_owner_demo()
    if inactive:
        return inactive
    payload = request.get_json(silent=True) or {}
    allowed = {"Waiting for payment", "Payment received", "Loading gear", "Charging", "Awaiting pickup", "Locker open", "Completed", "Recovered"}
    status = payload.get("status")
    if status is not None and status not in allowed:
        return jsonify(error="Invalid demo session status."), 400
    for record in app.config["DEMO_SESSIONS"]:
        if record["id"] == session_id:
            final_paid = payload.get("paid", record.get("paid", 0))
            final_minutes = payload.get("minutes", record.get("minutes", 0))
            if "paid" in payload and not valid_coin_total(final_paid):
                return jsonify(error="Payment must be in ₱5 increments, up to ₱100."), 400
            if "minutes" in payload and (not isinstance(final_minutes, int) or isinstance(final_minutes, bool) or not 0 <= final_minutes <= 300):
                return jsonify(error="Charging time must be between 0 and 300 minutes."), 400
            if ("paid" in payload or "minutes" in payload) and final_minutes != accepted_payment_minutes(final_paid):
                return jsonify(error="Charging time must match a valid payment total."), 400
            if status in {"Payment received", "Charging"} and (
                accepted_payment_minutes(final_paid) == 0 or final_minutes != accepted_payment_minutes(final_paid)
            ):
                return jsonify(error="A valid even ₱10 payment total is required before charging."), 400
            if "rating" in payload and (not isinstance(payload["rating"], int) or isinstance(payload["rating"], bool) or not 1 <= payload["rating"] <= 5):
                return jsonify(error="Feedback rating must be from 1 to 5 stars."), 400
            if "feedback" in payload and (not isinstance(payload["feedback"], str) or len(payload["feedback"]) > 100):
                return jsonify(error="Feedback comment must be 100 characters or fewer."), 400
            if status is not None:
                record["status"] = status
                if status == "Charging":
                    record.setdefault("started_at", now_iso())
                if status in {"Completed", "Recovered"}:
                    record["returned_at"] = now_iso()
                    record["returned"] = datetime.now().astimezone().strftime("%I:%M %p").lstrip("0")
                    hardware = app.config["HARDWARE_STATUS"]
                    if record.get("energy_start") is not None and hardware.get("energy_meter_detected") and hardware.get("energy_kwh") is not None:
                        record["energy"] = round(max(0, hardware["energy_kwh"] - record["energy_start"]), 3)
                if status == "Completed":
                    app.config["DEMO_PIN_HASHES"].pop(session_id, None)
            for key in ("used", "paid", "minutes", "rating", "feedback"):
                if key in payload:
                    record[key] = payload[key]
            return jsonify(session=record)
    return jsonify(error="Demo session not found."), 404


@app.delete("/api/owner/demo/sessions/<session_id>")
@require_role("owner")
def delete_demo_session(session_id):
    inactive = require_active_owner_demo()
    if inactive:
        return inactive
    records = app.config["DEMO_SESSIONS"]
    remaining = [record for record in records if record["id"] != session_id]
    if len(remaining) == len(records):
        return jsonify(error="Demo session not found."), 404
    app.config["DEMO_SESSIONS"] = remaining
    app.config["DEMO_PIN_HASHES"].pop(session_id, None)
    return jsonify(ok=True)


@app.post("/api/sessions")
def create_camper_session():
    payload = request.get_json(silent=True) or {}
    name, locker = str(payload.get("name", "")).strip(), str(payload.get("locker", ""))
    if not name or len(name) > 80 or locker not in {"01", "02", "03"}:
        return jsonify(error="Enter a camper name and a valid locker."), 400
    session_id = secrets.token_urlsafe(18)
    created = now_iso()
    with connect_db() as con:
        con.execute("INSERT INTO camper_sessions(id,camper_name,locker,status,created_at) VALUES(?,?,?,?,?)",
                    (session_id, name, locker, "Waiting for payment", created))
    return jsonify(id=session_id), 201


@app.post("/api/feedback")
def submit_camper_feedback():
    payload = request.get_json(silent=True) or {}
    session_id = str(payload.get("session_id", ""))
    rating = payload.get("rating")
    comment = payload.get("comment", "")
    if not session_id or len(session_id) > 80:
        return jsonify(error="The completed camper session could not be identified."), 400
    if not isinstance(rating, int) or isinstance(rating, bool) or not 1 <= rating <= 5:
        return jsonify(error="Choose a star rating from 1 to 5."), 400
    if not isinstance(comment, str) or len(comment) > 100:
        return jsonify(error="Feedback comment must be 100 characters or fewer."), 400
    with connect_db() as con:
        row = con.execute("SELECT status,locker FROM camper_sessions WHERE id=?", (session_id,)).fetchone()
        if not row or row["status"] not in {"Completed", "Recovered"}:
            return jsonify(error="Feedback is available after the locker session is completed."), 409
        con.execute("INSERT INTO camper_feedback(locker,rating,comment,created_at) VALUES(?,?,?,?)",
                    (row["locker"], rating, comment.strip(), now_iso()))
    return jsonify(ok=True), 201


@app.get("/api/owner/feedback")
@require_role("owner")
def owner_feedback():
    cleanup_expired_sessions()
    period = request.args.get("period", "Today")
    if period not in {"Today", "This week", "This month"}:
        return jsonify(error="Choose a valid reporting period."), 400
    start, end = owner_period_bounds(period)
    if app.config["DEMO_ACTIVE"]:
        start_dt, end_dt = datetime.fromisoformat(start), datetime.fromisoformat(end)
        feedback = []
        for row in demo_feedback_rows():
            try:
                created_dt = datetime.fromisoformat(row["created_at"]).astimezone(timezone.utc)
            except (TypeError, ValueError):
                continue
            if start_dt <= created_dt < end_dt:
                feedback.append(row)
        feedback.sort(key=lambda item: item["created_at"], reverse=True)
    else:
        with connect_db() as con:
            rows = con.execute("""
                SELECT rating, comment, created_at, locker FROM camper_feedback
                WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC
            """, (start, end)).fetchall()
        feedback = [{"rating": row["rating"], "comment": row["comment"],
                     "created_at": row["created_at"], "locker": row["locker"]} for row in rows]
    satisfied = sum(item["rating"] >= 4 for item in feedback)
    return jsonify(period=period, feedback=feedback, total=len(feedback), satisfied=satisfied,
                   needs_improvement=len(feedback) - satisfied)


@app.get("/api/owner/feedback.csv")
@require_role("owner")
def export_owner_feedback():
    period = request.args.get("period", "Today")
    if period not in {"Today", "This week", "This month"}:
        return jsonify(error="Choose a valid reporting period."), 400
    start, end = owner_period_bounds(period)
    if app.config["DEMO_ACTIVE"]:
        start_dt, end_dt = datetime.fromisoformat(start), datetime.fromisoformat(end)
        rows = [row for row in demo_feedback_rows()
                if start_dt <= datetime.fromisoformat(row["created_at"]).astimezone(timezone.utc) < end_dt]
        rows.sort(key=lambda item: item["created_at"], reverse=True)
    else:
        with connect_db() as con:
            rows = [dict(row) for row in con.execute("""
                SELECT locker,created_at,rating,comment FROM camper_feedback
                WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC
            """, (start, end)).fetchall()]
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(["Locker", "Date and time (UTC)", "Rating (1-5)", "Feedback"])
    writer.writerows((row["locker"], row["created_at"], row["rating"], row.get("comment", "")) for row in rows)
    filename = f'camper-feedback-{period.lower().replace(" ", "-")}-{datetime.now().strftime("%Y%m%d-%H%M%S")}.csv'
    report_path = REPORTS / filename
    report_path.write_text("\ufeff" + output.getvalue(), encoding="utf-8", newline="")
    return send_file(report_path, as_attachment=True, download_name=filename, mimetype="text/csv")


@app.patch("/api/sessions/<session_id>")
def update_camper_session(session_id):
    payload = request.get_json(silent=True) or {}
    allowed_statuses = {"Waiting for payment", "Payment received", "Charging", "Awaiting pickup", "Completed"}
    status = payload.get("status")
    if status is not None and status not in allowed_statuses:
        return jsonify(error="Invalid session status."), 400
    paid = payload.get("paid")
    minutes = payload.get("minutes")
    used = payload.get("usedMinutes")
    for value, maximum, label in ((paid, 100, "payment"), (minutes, 300, "charging time"), (used, 1440, "time used")):
        if value is not None and (not isinstance(value, int) or value < 0 or value > maximum):
            return jsonify(error=f"Invalid {label} value."), 400
    if paid is not None and not valid_coin_total(paid):
        return jsonify(error="Payment must be in ₱5 increments, up to ₱100."), 400
    if (paid is not None or minutes is not None) and paid is not None and minutes is not None:
        if minutes != accepted_payment_minutes(paid):
            return jsonify(error="Charging time must match a valid payment total."), 400
    if status in {"Payment received", "Charging"} and (
        paid is None or minutes is None or accepted_payment_minutes(paid) == 0
        or minutes != accepted_payment_minutes(paid)
    ):
        return jsonify(error="A valid even ₱10 payment total is required before charging."), 400
    fields, values = [], []
    if status is not None:
        fields.append("status=?")
        values.append(status)
        if status == "Charging":
            fields.append("started_at=COALESCE(started_at, ?)")
            values.append(now_iso())
        if status == "Completed":
            fields.append("ended_at=?")
            values.append(now_iso())
    if paid is not None:
        fields.append("paid_php=?")
        values.append(paid)
    if minutes is not None:
        fields.append("minutes_paid=?")
        values.append(minutes)
    if used is not None:
        fields.append("used_minutes=?")
        values.append(used)
    if not fields:
        return jsonify(error="No session changes were provided."), 400
    with connect_db() as con:
        cursor = con.execute(f"UPDATE camper_sessions SET {', '.join(fields)} WHERE id=?", (*values, session_id))
    if cursor.rowcount == 0:
        return jsonify(error="Session not found."), 404
    return jsonify(ok=True)


@app.delete("/api/sessions/<session_id>")
def delete_unpaid_camper_session(session_id):
    with connect_db() as con:
        cursor = con.execute("DELETE FROM camper_sessions WHERE id=? AND status IN ('Waiting for payment','Payment received')", (session_id,))
    if cursor.rowcount == 0:
        return jsonify(error="Session was not found or charging has already started."), 404
    return jsonify(ok=True)


@app.get("/api/staff/sessions")
def staff_sessions():
    if session.get("role") not in {"staff", "owner"}:
        return jsonify(error="Please sign in with a staff or owner account."), 401
    if app.config["DEMO_ACTIVE"]:
        rows = [row for row in app.config["DEMO_SESSIONS"] if row.get("status") not in {"Completed", "Recovered"}]
        return jsonify(sessions=rows, demo_active=True)
    with connect_db() as con:
        rows = con.execute("SELECT * FROM camper_sessions WHERE status NOT IN ('Completed','Recovered') ORDER BY created_at DESC").fetchall()
    return jsonify(sessions=[session_record(row) for row in rows], demo_active=False)


@app.post("/api/staff/sessions/<session_id>/recover")
def recover_camper_session(session_id):
    if session.get("role") not in {"staff", "owner"}:
        return jsonify(error="Please sign in with a staff or owner account."), 401
    if app.config["DEMO_ACTIVE"]:
        for row in app.config["DEMO_SESSIONS"]:
            if row["id"] == session_id:
                if row["status"] != "Awaiting pickup":
                    return jsonify(error="Recovery is available after charging has ended."), 409
                row["status"] = "Recovered"
                row["returned_at"] = now_iso()
                row["returned"] = datetime.now().astimezone().strftime("%I:%M %p").lstrip("0")
                hardware = app.config["HARDWARE_STATUS"]
                if row.get("energy_start") is not None and hardware.get("energy_meter_detected") and hardware.get("energy_kwh") is not None:
                    row["energy"] = round(max(0, hardware["energy_kwh"] - row["energy_start"]), 3)
                app.config["DEMO_RECOVERY_AUDIT"].insert(0, {
                    "username": session.get("username", "Staff"), "action": "Locker recovery authorized",
                    "subject": f'{row["name"]} · locker {row["locker"]}', "created_at": now_iso(),
                })
                return jsonify(ok=True, demo=True)
        return jsonify(error="Demo session not found."), 404
    with connect_db() as con:
        row = con.execute("SELECT camper_name, locker, status FROM camper_sessions WHERE id=?", (session_id,)).fetchone()
        if not row:
            return jsonify(error="Session not found."), 404
        if row["status"] != "Awaiting pickup":
            return jsonify(error="Recovery is available after charging has ended."), 409
        con.execute("UPDATE camper_sessions SET status='Recovered', ended_at=? WHERE id=?", (now_iso(), session_id))
    audit("locker_recovered", f'{row["camper_name"]} · locker {row["locker"]}')
    return jsonify(ok=True)


@app.get("/api/staff/audit")
def staff_recovery_audit():
    if session.get("role") not in {"staff", "owner"}:
        return jsonify(error="Please sign in with a staff or owner account."), 401
    if app.config["DEMO_ACTIVE"]:
        return jsonify(entries=app.config["DEMO_RECOVERY_AUDIT"], demo_active=True)
    with connect_db() as con:
        rows = con.execute("""
            SELECT u.username, a.action, a.subject, a.created_at
            FROM audit a LEFT JOIN users u ON u.id=a.actor_id
            WHERE a.action='locker_recovered' ORDER BY a.id DESC LIMIT 500
        """).fetchall()
    return jsonify(entries=[dict(row) for row in rows], demo_active=False)


@app.post("/api/staff/audit/export")
def export_staff_recovery_audit():
    if session.get("role") not in {"staff", "owner"}:
        return jsonify(error="Please sign in with a staff or owner account."), 401
    if app.config["DEMO_ACTIVE"]:
        entries = app.config["DEMO_RECOVERY_AUDIT"]
        source = "demo"
    else:
        with connect_db() as con:
            entries = [dict(row) for row in con.execute("""
                SELECT u.username, a.action, a.subject, a.created_at
                FROM audit a LEFT JOIN users u ON u.id=a.actor_id
                WHERE a.action='locker_recovered' ORDER BY a.id DESC LIMIT 500
            """).fetchall()]
        source = "staff"
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(["Staff username", "Action", "Camper and locker", "Date and time (UTC)"])
    writer.writerows((row.get("username") or "Unknown", row.get("action", ""), row.get("subject", ""), row.get("created_at", "")) for row in entries)
    name = f"recovery-audit-{source}-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f") + ".csv"
    path = REPORTS / name
    path.write_text("\ufeff" + output.getvalue(), encoding="utf-8", newline="")
    return send_file(path, as_attachment=True, download_name=name, mimetype="text/csv")


def owner_period_bounds(period):
    today = datetime.now().astimezone().date()
    if period == "This week":
        first = today - timedelta(days=today.weekday())
        last = first + timedelta(days=7)
    elif period == "This month":
        first = today.replace(day=1)
        last = (first.replace(day=28) + timedelta(days=4)).replace(day=1)
    else:
        first, last = today, today + timedelta(days=1)
    start = datetime.combine(first, datetime.min.time()).astimezone().astimezone(timezone.utc).isoformat(timespec="seconds")
    end = datetime.combine(last, datetime.min.time()).astimezone().astimezone(timezone.utc).isoformat(timespec="seconds")
    return start, end


@app.get("/api/owner/sessions")
@require_role("owner")
def owner_sessions():
    cleanup_expired_sessions()
    period = request.args.get("period", "Today")
    if period not in {"Today", "This week", "This month"}:
        return jsonify(error="Choose a valid reporting period."), 400
    start, end = owner_period_bounds(period)
    rows = completed_session_rows(start, end)
    with connect_db() as con:
        energy = con.execute("SELECT COALESCE(SUM(energy_kwh),0) FROM camper_sessions WHERE status IN ('Completed','Recovered') AND ended_at >= ? AND ended_at < ?", (start, end)).fetchone()[0]
    revenue = sum(row["paid"] for row in rows)
    return jsonify(sessions=rows, revenue=revenue, count=len(rows), average=(revenue / len(rows) if rows else 0), energy_kwh=energy)


@app.get("/api/owner/staff")
@require_role("owner")
def list_staff():
    with connect_db() as con:
        rows = con.execute("SELECT id, username, active, created_at FROM users WHERE role='staff' ORDER BY username COLLATE NOCASE").fetchall()
    return jsonify(staff=[dict(row) for row in rows])


@app.post("/api/owner/staff")
@require_role("owner")
def add_staff():
    from werkzeug.security import generate_password_hash
    payload = request.get_json(silent=True) or {}
    username, password = str(payload.get("username", "")).strip(), payload.get("password", "")
    if len(username) < 3 or len(username) > 40 or not username.replace("_", "").replace("-", "").isalnum():
        return jsonify(error="Use a 3–40 character username with letters, numbers, _ or -."), 400
    if not isinstance(password, str) or len(password) < 10:
        return jsonify(error="Staff passwords must be at least 10 characters."), 400
    try:
        with connect_db() as con:
            con.execute("INSERT INTO users(username,password_hash,role,active,created_at) VALUES(?,?, 'staff',1,?)",
                        (username, generate_password_hash(password), now_iso()))
    except sqlite3.IntegrityError:
        return jsonify(error="That username is already in use."), 409
    audit("staff_added", username)
    return jsonify(ok=True), 201


@app.delete("/api/owner/staff/<int:user_id>")
@require_role("owner")
def deactivate_staff(user_id):
    with connect_db() as con:
        user = con.execute("SELECT username, active FROM users WHERE id=? AND role='staff'", (user_id,)).fetchone()
        if not user: return jsonify(error="Staff account not found."), 404
        con.execute("UPDATE users SET active=0 WHERE id=?", (user_id,))
    audit("staff_access_removed", user["username"])
    return jsonify(ok=True)


@app.get("/api/owner/reports")
@require_role("owner")
def list_reports():
    cleanup_expired_reports()
    items = []
    for path in sorted(REPORTS.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if path.is_file() and path.suffix.lower() in {".xlsx", ".csv"}:
            st = path.stat()
            items.append({"name": path.name, "bytes": st.st_size, "modified": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(timespec="minutes")})
    return jsonify(reports=items, retention_days=60)


@app.post("/api/owner/reports/export")
@require_role("owner")
def export_report():
    import csv
    from io import StringIO
    from flask import send_file
    cleanup_expired_sessions()
    output = StringIO(newline="")
    writer = csv.writer(output)
    if app.config["DEMO_ACTIVE"]:
        writer.writerow(["OWNER DEMO REPORT", "Temporary data; removed when demo mode stops"])
        writer.writerow([])
        writer.writerow(["Financial overview"])
        writer.writerow(["Period", "Demo revenue PHP", "Estimated costs PHP", "Completed session count"])
        financials = {"Today": (250, 50, 2), "This week": (1520, 380, 18), "This month": (4820, 1190, 56)}
        demo_rows = app.config["DEMO_REPORT_SESSIONS"] + [
            row for row in app.config["DEMO_SESSIONS"] if row.get("status") in {"Completed", "Recovered"}
        ]
        created_rows = [row for row in demo_rows if not row.get("demo_sample")]
        for period, (base_revenue, costs, base_count) in financials.items():
            start, end = owner_period_bounds(period)
            start_dt, end_dt = datetime.fromisoformat(start), datetime.fromisoformat(end)
            period_rows = []
            for row in created_rows:
                try:
                    when = datetime.fromisoformat(row.get("returned_at") or row.get("created_at")).astimezone(timezone.utc)
                except (TypeError, ValueError):
                    continue
                if start_dt <= when < end_dt:
                    period_rows.append(row)
            paid = sum(int(row.get("paid", 0) or 0) for row in period_rows)
            writer.writerow([period, base_revenue + paid, costs, base_count + len(period_rows)])
        writer.writerow([])
        writer.writerow(["Energy consumption"])
        writer.writerow(["Camper", "Locker", "Energy kWh", "Reading source"])
        writer.writerows([row.get("name"), row.get("locker"), row.get("energy") if row.get("energy") is not None else "Meter needed", "Sample demo" if row.get("demo_sample") else "Connected meter" if row.get("energy") is not None else "No meter reading"] for row in demo_rows)
        writer.writerow([])
        writer.writerow(["Completed camper sessions"])
        writer.writerow(["Camper", "Locker", "Paid PHP", "Time paid (minutes)", "Time used", "Energy kWh", "Returned"])
        writer.writerows([[row.get("name"), row.get("locker"), row.get("paid", 0), row.get("minutes", 0), row.get("used", "0 min"), row.get("energy") if row.get("energy") is not None else "Meter needed", row.get("returned", "—")] for row in demo_rows])
        writer.writerow([])
        writer.writerow(["Camper feedback"])
        writer.writerow(["Locker", "Date and time", "Rating (1-5)", "Feedback"])
        writer.writerows([[row.get("locker"), row.get("created_at", ""), row.get("rating"), row.get("comment", "")] for row in demo_feedback_rows()])
        writer.writerow([])
        writer.writerow(["Staff recovery audit"])
        writer.writerow(["Staff username", "Action", "Camper and locker", "Date and time"])
        writer.writerows([[row.get("username", ""), row.get("action", ""), row.get("subject", ""), row.get("created_at", "")] for row in app.config["DEMO_RECOVERY_AUDIT"]])
        name = "demo-system-report-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f") + ".csv"
    else:
        writer.writerow(["Camper", "Locker", "Paid PHP", "Time paid (minutes)", "Time used", "Energy kWh", "Returned"])
        writer.writerows([[item["name"], item["locker"], item["paid"], item["minutes"], item["used"], item["energy"] if item["energy"] is not None else "Meter needed", item["returned"]]
                          for item in completed_session_rows()])
        name = "sessions-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f") + ".csv"
    (REPORTS / name).write_text("\ufeff" + output.getvalue(), encoding="utf-8", newline="")
    audit("report_exported", name)
    return send_file(REPORTS / name, as_attachment=True, download_name=name, mimetype="text/csv")


@app.get("/api/owner/reports/file/<path:filename>")
@require_role("owner")
def download_report(filename):
    if Path(filename).name != filename or Path(filename).suffix.lower() not in {".xlsx", ".csv"}:
        abort(400)
    return send_from_directory(REPORTS, filename, as_attachment=True)


@app.delete("/api/owner/reports/<path:filename>")
@require_role("owner")
def delete_report(filename):
    if Path(filename).name != filename or Path(filename).suffix.lower() not in {".xlsx", ".csv"}:
        return jsonify(error="Invalid report name."), 400
    target = REPORTS / filename
    try:
        target.unlink()
    except FileNotFoundError:
        return jsonify(error="Report not found."), 404
    audit("report_deleted", filename)
    return jsonify(ok=True)


if __name__ == "__main__":
    # Intended for a trusted local kiosk network during development.
    app.run(host="0.0.0.0", port=5000, debug=False)
