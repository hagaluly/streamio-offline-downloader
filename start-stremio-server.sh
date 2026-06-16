#!/usr/bin/env bash
# Starts Stremio's bundled streaming server (port 11470) headless on Linux/WSL2.
# This is the engine the Offline Downloader addon drives. Keep this running while
# you use Stremio (via https://web.stremio.com) and the addon.
set -euo pipefail

SERVER_JS="${STREMIO_SERVER_JS:-/opt/stremio/server.js}"
NODE_BIN="$(command -v node || command -v nodejs || true)"

[ -n "$NODE_BIN" ] || { echo "ERROR: node/nodejs not found in PATH"; exit 1; }
[ -f "$SERVER_JS" ] || { echo "ERROR: $SERVER_JS not found — install the Stremio .deb first"; exit 1; }

echo "Starting Stremio streaming server on 127.0.0.1:11470 (node: $NODE_BIN)"
echo "Leave this window open. Connect from Windows at https://web.stremio.com"
exec "$NODE_BIN" "$SERVER_JS"
