#!/usr/bin/env bash
# Starts the Stremio Offline Downloader addon + dashboard (port 11473) on Linux/WSL2.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$(command -v node || command -v nodejs || true)"
[ -n "$NODE_BIN" ] || { echo "ERROR: node/nodejs not found in PATH"; exit 1; }

# On HTTPS web.stremio.com, only 127.0.0.1 HTTP stream URLs are exempt from the
# mixed-content block, and Windows reaches WSL via localhost forwarding anyway.
export OFFLINE_STREAM_HOST="${OFFLINE_STREAM_HOST:-127.0.0.1}"

echo "============================================================"
echo "  Stremio Offline Downloader Addon"
echo "  Manifest : http://127.0.0.1:11473/manifest.json"
echo "  Dashboard: http://127.0.0.1:11473/"
echo "  Stream host advertised to Stremio: $OFFLINE_STREAM_HOST"
echo "  Keep this window open while using offline downloads."
echo "============================================================"
exec "$NODE_BIN" "$DIR/addon.js"
