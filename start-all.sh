#!/usr/bin/env bash
# Starts BOTH Stremio's streaming server (port 11470) and the Offline Downloader
# addon (port 11473) in the background, surviving terminal close (nohup).
# Waits for the server before starting the addon (the addon refuses to run if
# 11470 is not reachable). Run once per WSL session. Re-running is safe — it
# skips whatever is already up. Does NOT survive a full WSL shutdown.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Private per-user log dir (mode 700) — avoids world-writable /tmp where another
# user could pre-plant a symlink at the log path and have us clobber its target.
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/stremio"
mkdir -p -m 700 "$LOG_DIR"
SERVER_LOG="$LOG_DIR/stremio-server.log"
ADDON_LOG="$LOG_DIR/offline-addon.log"

is_up() { ss -ltn 2>/dev/null | grep -q ":$1 "; }

wait_up() { # $1=port $2=seconds
  local i
  for ((i = 0; i < $2; i++)); do
    if is_up "$1"; then return 0; fi
    sleep 1
  done
  return 1
}

# 1. Streaming server (port 11470)
if is_up 11470; then
  echo "Streaming server already up on 11470."
else
  echo "Starting Stremio streaming server (11470)..."
  nohup "$DIR/start-stremio-server.sh" >"$SERVER_LOG" 2>&1 &
  disown
fi
if ! wait_up 11470 20; then
  echo "ERROR: streaming server did not come up on 11470. Last log lines:"
  tail -n 15 "$SERVER_LOG" 2>/dev/null || true
  exit 1
fi
echo "Streaming server ready on 11470."

# 2. Addon (port 11473)
if is_up 11473; then
  echo "Addon already up on 11473."
else
  echo "Starting Offline Downloader addon (11473)..."
  nohup "$DIR/start-offline-addon.sh" >"$ADDON_LOG" 2>&1 &
  disown
fi
if ! wait_up 11473 10; then
  echo "ERROR: addon did not come up on 11473. Last log lines:"
  tail -n 15 "$ADDON_LOG" 2>/dev/null || true
  exit 1
fi

echo
echo "============================================================"
echo "  Both running."
echo "  Stremio  : https://web.stremio.com   (engine on :11470)"
echo "  Dashboard: http://localhost:11473/"
echo "  Logs     : $SERVER_LOG"
echo "             $ADDON_LOG"
echo "  Stop both: ./stop-all.sh"
echo "============================================================"
