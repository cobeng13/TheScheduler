#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

BACKEND_LOG="$ROOT_DIR/backend_server.log"
FRONTEND_LOG="$ROOT_DIR/frontend_server.log"

cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
  if [[ -n "${FRONTEND_PID:-}" ]] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

require_command() {
  local command_name="$1"
  local install_hint="$2"

  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name"
    echo "$install_hint"
    exit 1
  fi
}

echo "Starting TheScheduler..."
echo

require_command python3 "Install Python 3 from https://www.python.org/downloads/macos/"
require_command npm "Install Node.js LTS from https://nodejs.org/"

echo "[1/5] Preparing backend..."
cd "$BACKEND_DIR"

if [[ ! -d ".venv" ]]; then
  python3 -m venv .venv
fi

source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m pip install python-multipart
python -m alembic upgrade head

echo "[2/5] Starting backend on http://localhost:8000 ..."
PYTHONPATH="$BACKEND_DIR" python -m uvicorn app.main:app --reload --port 8000 >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

echo "[3/5] Preparing frontend..."
cd "$FRONTEND_DIR"
npm install

echo "[4/5] Starting frontend on http://localhost:5173 ..."
npm run dev -- --host 127.0.0.1 >"$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!

echo "[5/5] Opening app..."
sleep 5
open "http://localhost:5173" >/dev/null 2>&1 || true

echo
echo "TheScheduler is running."
echo "Frontend: http://localhost:5173"
echo "Backend:  http://localhost:8000"
echo
echo "Backend log:  $BACKEND_LOG"
echo "Frontend log: $FRONTEND_LOG"
echo
echo "Keep this window open while using the app."
echo "Press Control-C to stop both servers."

wait
