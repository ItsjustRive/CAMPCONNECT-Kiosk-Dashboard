"""USB-serial bridge between the Raspberry Pi kiosk and Point A ESP32.

The ESP32 firmware should exchange one UTF-8 JSON object per line (newline
terminated). See HARDWARE_INTEGRATION.md for the message contract.
"""
import json
import os
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


# Set KIOSK_ESP32_PORT to the Pi's /dev/serial/by-id/... path or a Windows COM
# port (for example COM5). Leaving it blank keeps the bridge safely disabled.
SERIAL_PORT = os.environ.get("KIOSK_ESP32_PORT", "").strip()
BAUD_RATE = int(os.environ.get("KIOSK_ESP32_BAUD", "115200"))
KIOSK_API = os.environ.get("KIOSK_API", "http://127.0.0.1:5000").rstrip("/")
SERIAL_READ_TIMEOUT = 0.25
OUTBOX_POLL_SECONDS = 1.0
SOS_RETRY_SECONDS = 10.0
HEARTBEAT_TIMEOUT_SECONDS = 15.0
MAX_LINE_BYTES = 8192


def api_request(path, payload=None):
    data = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = Request(
        f"{KIOSK_API}{path}",
        data=data,
        headers={"Content-Type": "application/json"} if data is not None else {},
        method="POST" if data is not None else "GET",
    )
    try:
        with urlopen(request, timeout=3) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        detail = error.read(512).decode("utf-8", errors="replace")
        raise RuntimeError(f"Kiosk API returned HTTP {error.code}: {detail}") from error
    except URLError as error:
        raise RuntimeError(f"Kiosk API is not reachable: {error.reason}") from error


def write_message(port, message):
    line = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
    if len(line) > MAX_LINE_BYTES:
        raise ValueError("Message is too large for the configured serial frame limit.")
    port.write(line)
    port.flush()


def poll_outbox(port, last_sent, now):
    try:
        alerts = api_request("/api/hardware/emergency-outbox").get("alerts", [])
    except (RuntimeError, ValueError) as error:
        print(f"Outbox check skipped: {error}")
        return

    for alert in alerts:
        alert_id = str(alert.get("id", ""))
        if not alert_id or now - last_sent.get(alert_id, 0) < SOS_RETRY_SECONDS:
            continue
        message = {
            "v": 1,
            "type": "sos",
            "id": alert_id,
            "alert_type": alert.get("alert_type", ""),
            "details": alert.get("details", ""),
            "created_at": alert.get("created_at", ""),
            "latitude": alert.get("latitude"),
            "longitude": alert.get("longitude"),
            "gps_accuracy_m": alert.get("gps_accuracy_m"),
            "demo": bool(alert.get("is_demo")),
        }
        write_message(port, message)
        last_sent[alert_id] = now
        print(f"Queued SOS {alert_id} sent to Point A for LoRa delivery.")


def poll_camper_reply_outbox(port, last_sent, now):
    try:
        messages = api_request("/api/hardware/camper-reply-outbox").get("messages", [])
    except (RuntimeError, ValueError) as error:
        print(f"Camper reply queue check skipped: {error}")
        return

    for message in messages:
        alert_id = str(message.get("id", ""))
        retry_key = f"camper-reply:{alert_id}"
        if not alert_id or now - last_sent.get(retry_key, 0) < SOS_RETRY_SECONDS:
            continue
        write_message(port, {
            "v": 1,
            "type": "camper_reply",
            "id": alert_id,
            "message": message.get("message", ""),
            "created_at": message.get("created_at", ""),
            "demo": bool(message.get("is_demo")),
        })
        last_sent[retry_key] = now


def post_telemetry(message):
    allowed = {
        "lora_connected", "battery_detected", "battery_percent",
        "energy_meter_detected", "energy_kwh", "gps_fix", "latitude",
        "longitude", "gps_accuracy_m", "responder_alert_id",
        "responder_username", "responder_role", "responder_latitude",
        "responder_longitude", "responder_accuracy_m", "responder_message",
    }
    payload = {key: value for key, value in message.items() if key in allowed and value is not None}
    if payload:
        api_request("/api/hardware/telemetry", payload)


def handle_esp32_message(port, message, last_sent):
    if not isinstance(message, dict) or message.get("v") != 1:
        print("Ignored unsupported serial message; expected a version 1 JSON object.")
        return None

    kind = message.get("type")
    if kind == "heartbeat":
        post_telemetry({"lora_connected": message.get("lora_connected") is True})
        return time.monotonic()
    if kind == "telemetry":
        post_telemetry(message)
        return None
    if kind == "sos_ack":
        alert_id, sent = message.get("id"), message.get("sent")
        if isinstance(alert_id, str) and isinstance(sent, bool):
            api_request(f"/api/hardware/emergency-outbox/{quote(alert_id, safe='')}/ack", {"sent": sent})
            last_sent.pop(alert_id, None)
            print(f"SOS {alert_id} delivery acknowledged: {sent}.")
        return None
    if kind == "responder_update":
        post_telemetry({**message, "lora_connected": True})
        return time.monotonic()
    if kind == "resolved":
        alert_id = message.get("id")
        username = message.get("username", "")
        role = message.get("role")
        if isinstance(alert_id, str) and isinstance(username, str) and role in {"owner", "staff"}:
            api_request(f"/api/hardware/alerts/{quote(alert_id, safe='')}/resolve", {"username": username, "role": role})
            print(f"SOS {alert_id} resolution received from Point B over LoRa.")
        return None
    if kind == "camper_reply_ack":
        alert_id, sent = message.get("id"), message.get("sent")
        if isinstance(alert_id, str) and isinstance(sent, bool):
            api_request(f"/api/hardware/camper-reply-outbox/{quote(alert_id, safe='')}/ack", {"sent": sent})
            print(f"Camper reply {alert_id} delivery acknowledged: {sent}.")
        return None
    if kind == "log":
        print(f"Point A: {str(message.get('message', ''))[:240]}")
        return None

    print(f"Ignored unknown ESP32 message type: {kind!r}")
    return None


def main():
    if not SERIAL_PORT:
        print("USB bridge is idle. Set KIOSK_ESP32_PORT to the Point A USB serial port, then restart this program.")
        print("Example: /dev/serial/by-id/usb-Espressif_Point_A-if00 on Raspberry Pi OS, or COM5 on Windows.")
        return

    try:
        import serial
    except ImportError:
        raise SystemExit("pyserial is missing. Install project dependencies with: python3 -m pip install -r requirements.txt")

    print(f"Opening Point A serial link {SERIAL_PORT} at {BAUD_RATE} baud.")
    while True:
        try:
            with serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=SERIAL_READ_TIMEOUT, write_timeout=2) as port:
                print("Point A serial link opened.")
                last_sent = {}
                last_heartbeat = 0.0
                next_outbox_poll = 0.0
                while True:
                    raw = port.readline()
                    now = time.monotonic()
                    if raw:
                        if len(raw) > MAX_LINE_BYTES:
                            print("Ignored oversized serial line.")
                        else:
                            try:
                                message = json.loads(raw.decode("utf-8").strip())
                                heartbeat = handle_esp32_message(port, message, last_sent)
                                if heartbeat is not None:
                                    last_heartbeat = heartbeat
                            except (UnicodeDecodeError, json.JSONDecodeError, RuntimeError, ValueError) as error:
                                print(f"Could not process Point A serial message: {error}")

                    if now >= next_outbox_poll:
                        try:
                            poll_outbox(port, last_sent, now)
                            poll_camper_reply_outbox(port, last_sent, now)
                        except (OSError, RuntimeError, ValueError) as error:
                            print(f"Could not send to Point A: {error}")
                        next_outbox_poll = now + OUTBOX_POLL_SECONDS

                    if last_heartbeat and now - last_heartbeat > HEARTBEAT_TIMEOUT_SECONDS:
                        try:
                            post_telemetry({"lora_connected": False})
                        except RuntimeError as error:
                            print(f"Could not mark LoRa link unavailable: {error}")
                        last_heartbeat = 0.0
        except (OSError, RuntimeError) as error:
            try:
                post_telemetry({"lora_connected": False})
            except RuntimeError:
                pass
            print(f"Point A serial link unavailable: {error}. Retrying in 3 seconds.")
            time.sleep(3)


if __name__ == "__main__":
    main()
