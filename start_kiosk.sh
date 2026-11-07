#!/bin/sh
set -eu

cd "$(dirname "$0")"

mkdir -p data "$HOME/.local/share/campconnect-kiosk"
PYTHON="$PWD/.venv/bin/python"
URL="http://127.0.0.1:5000/login"

if [ ! -x "$PYTHON" ]; then
  echo "CampConnect environment is missing. Create .venv and install requirements.txt first." >&2
  exit 1
fi

if ! "$PYTHON" -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:5000/login", timeout=1)' >/dev/null 2>&1; then
  "$PYTHON" server.py >> data/kiosk-server.log 2>&1 &
fi

ready=0
attempt=0
while [ "$attempt" -lt 30 ]; do
  if "$PYTHON" -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:5000/login", timeout=1)' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
  attempt=$((attempt + 1))
done

if [ "$ready" -ne 1 ]; then
  echo "CampConnect did not start. Check data/kiosk-server.log." >&2
  exit 1
fi

printf '%s\n' "$$" > /tmp/campconnect-kiosk.pid
exec chromium --user-data-dir="$HOME/.local/share/campconnect-kiosk" --app="$URL" --kiosk --noerrdialogs --disable-infobars --no-first-run
