#!/usr/bin/env bash
# Stops the Stremio streaming server (port 11470) and the Offline Downloader
# addon (port 11473). Safe to run when nothing is up.
pkill -f '/opt/stremio/server.js'            && echo "stopped streaming server" || echo "streaming server was not running"
pkill -f 'streamio-offline-downloader/addon.js' && echo "stopped addon"          || echo "addon was not running"
