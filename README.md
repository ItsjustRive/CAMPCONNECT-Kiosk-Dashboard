# CAMPCONNECT-Kiosk-Dashboard

# Balakbak system how to install!

1. Install Python 3.10 or later.
2. In the VS Code terminal, run `py -m venv .venv` and then `.venv\\Scripts\\Activate.ps1`.
Reason: 
Because the env prevent you to store real data. I always did the env so i can test it always change things in there easily.
3. Run `py -m pip install -r requirements.txt`.
4. Run `py setup_owner.py`. Keep the suggested owner username `Administrator` (to easily distiquish), then enter the owner password you chose at the hidden password prompt (if you don't see anything when you type it is okay just remember what you type and type it again for comfirmation.). It is hashed before storage so your password  is not saved in project files as char. You can only choose one owner so better remember the password and if you use env it wouldn't save as final 'owner' it's like you're main is a fake main, env so all this will start anew again after you remove the env. 
Also the password is 10 char long. It will not acceot any shorter password.
5. Run `py server.py` and open `http://127.0.0.1:5000/login`.
6. Sign in as owner, then create staff accounts from the **Staff accounts** panel. Staff passwords must be at least 10 characters.

The sign-in page includes an on-screen keyboard with letters, digits, symbols, shift, space, backspace, and clear. because it did supports the staff and owner login form, and password input stays masked.

## What this system is currently implemented in the feature

- Flask serves the sign-in, staff, and owner pages and checks roles server-side. Unauthenticated owner/staff page and API requests return to sign-in.
- The initial owner is created by the setup command; account passwords are stored as Werkzeug password hashes. The session uses an HTTP-only, same-site cookie.
- Owners can add staff accounts and remove an old staff account's access. Removal disables login and keeps the account row so audit history can still refer to it.
- Owners can view and individually delete `.csv` and `.xlsx` files from `data/reports`. Exports created by the report button are written there. Report files older than 60 days (the two-month policy) are automatically removed when the service starts or the owner opens the report list.
- Owner and staff page routes require the matching signed-in role. The staff dashboard contains no revenue/profit figures.
- Database, generated reports, and Flask secret are kept under `data/`, which should be excluded from source control and backed up separately.

## Prototype limits before deployment

1. The camper flow waits for payment after name entry. It accepts exact totals of ₱10 for 30 minutes or ₱20 for 60 minutes; partial totals such as ₱5 or ₱15 remain insufficient. With no coin detected, it returns to name entry after 15 seconds. The owner can start and stop a temporary system-wide demo from the owner dashboard. Demo payment buttons, sample staff readings, and sample financial rows are available only while that owner-controlled mode is active. Demo activity is not saved; stopping it returns camper, staff, and owner views to normal mode.
2. The coin acceptor, locker relay/door sensor, power sensors, LoRa radio, completed-session storage, and real financial totals are not connected yet. In normal mode the payment screen shows ₱0 and 0 minutes, and the coin-slot status says not connected. Staff health readings show unavailable/offline until sensors and radio are integrated. The owner report currently contains its column headings only. The future coin-slot driver can call `window.acceptKioskCoin(5)`, `window.acceptKioskCoin(10)`, or `window.acceptKioskCoin(20)` when it detects a coin pulse. Connect the GPIO coin-slot driver, locker controller, sensors, LoRa radio, and session database before using the system for real campsite operations.
3. The server binds to all network interfaces on port 5000 for local development. Restrict network access to the trusted kiosk/management network before connecting it to Wi-Fi, and do not expose this development server to the public internet. Keep the `data` folder private because it will contain camper records and report exports. The owner can permanently delete report exports from the dashboard; deletion cannot be undone.

## Emergency responder tracking

- The phone dashboard polls SOS alerts and kiosk connectivity every five seconds. It shows the SOS creation time, actual send time when the LoRa bridge acknowledges delivery, the responder name and staff/owner role when supplied, and the time the response reached the kiosk. Marking an alert handled in the phone app records the signed-in account and resolution time.
- Owner, staff, and phone dashboards have an **Enable SOS sound** control. Tap it once on each device/browser session; a new unanswered SOS loops `phone campconnect/IOS_Emergency_Alert_Notification_-_Sound_Effect_HD.wav` until someone responds, and, when browser permissions and a secure origin allow it, can show a system notification while the page is in the background. The current local phone address uses plain HTTP, so browser notifications and reliable alerts while the phone is asleep or the app is closed require HTTPS and a push-notification service (or a native app push integration).
- On the phone, the alarm repeats every 4.5 seconds while any SOS is open and unanswered. **Respond to SOS** records the signed-in staff/owner and response time without resolving the alert; the sound stops on all dashboards once they refresh the acknowledged response. The kiosk hardware bridge can poll local-only `GET /api/hardware/sos-buzzer`; its `buzzer_active` value stays true while any SOS awaits a response and turns false after an acknowledgment or resolution. The repo has no buzzer/GPIO driver, so a hardware adapter must read this endpoint and switch the buzzer itself.
- Owner phone accounts keep both **Respond** and **Mark handled**; staff phone accounts only get **Respond**. Respond opens a 100-character message composer prefilled with “SOS Received. Help is on the way.” The kiosk shows that responder message in a 10-second popup and lets Point A send one 100-character reply with its on-screen keyboard. Point B sees that reply in a 10-second phone popup, with no reply action. Messages use `POST /api/mobile/alerts/<id>/respond` from Point B and `POST /api/camper/alerts/<id>/reply` from Point A.
- Current SOS alerts stay in the live response cards. Resolved alerts appear in a year-filtered history table; it defaults to the current calendar year and switches to the new year automatically while preserving prior years for lookup. The CSV export downloads the selected year's status, timestamps, responder, and time to response to the phone's local Downloads/files.
- The yearly archive and its CSV export show elapsed time from SOS send to first response in place of the Point A, Point B, and distance columns. Legacy alerts without a response timestamp use their resolution time as the duration endpoint.
- Point A uses the GPS coordinates captured with the SOS, with the kiosk's latest GPS fix as a fallback. The hardware bridge can report Point B through `POST /api/hardware/telemetry` using `responder_alert_id`, `responder_latitude`, `responder_longitude`, optional `responder_accuracy_m`, optional `responder_username` plus `responder_role` (`staff` or `owner`), and optional `responder_message` (up to 280 characters). The server associates these updates with the alert. The kiosk's camper screen displays the live responder status, GPS fix and distance while the SOS is active; the phone's current SOS card shows the same GPS tracking. The yearly resolved archive and CSV export show elapsed time from SOS send to first response (using resolve time for legacy records without a response timestamp).
- This project does not include the LoRa gateway or GPS-module driver. Actual Point A/Point B readings and delivery timestamps appear only after those devices send valid telemetry and delivery acknowledgements. The displayed distance is a straight-line GPS estimate; sensor accuracy and terrain affect how close it is to the travel distance.

## Point B Bluetooth connection TODO

- In `phone campconnect/app.js`, search for `TODO(BLE_POINT_B_SETUP)`. The phone can request a Bluetooth LE connection and remember/reconnect to a previously approved device. Until the ESP32 Point B firmware is available, the status intentionally says **setup pending** and dashboard/SOS data continues over the kiosk's local network.
- When the ESP32 firmware is ready, fill in `POINT_B_DEVICE_NAME_PREFIX`, `POINT_B_SERVICE_UUID`, `POINT_B_TX_CHARACTERISTIC_UUID`, and `POINT_B_RX_CHARACTERISTIC_UUID` there, then implement the documented message framing for read/write/notifications. Only report LoRa as connected after the BLE service confirms the Point B LoRa link, not just after GATT connects.
- Web Bluetooth requires a user tap to pair, a supported browser, and a secure page (HTTPS on a phone; localhost is treated specially for development). The current plain-HTTP local-network address will use the kiosk Wi-Fi/Ethernet fallback. For a native Android APK, implement the same transport with Android Bluetooth permissions and BLE APIs.

  
## Page files and what they are and if ever you have to change something there's comment for each of their function.

- `camper.html`, `camper.css`, `camper.js` — camper locker, PIN, charging, and SOS screens.
- `staff.html`, `staff.css`, `staff.js` — staff recovery interface and maintenance health display.
- `owner.html`, `owner.css`, `owner.js` — owner financial summary, staff account controls, and report file management.
- `auth.html`, `auth.css`, `auth.js` — shared staff/owner login and on-screen keyboard.
- `server.py`, `setup_owner.py` — local Flask service and initial owner setup.
