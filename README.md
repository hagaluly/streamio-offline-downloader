# Stremio Offline Downloader

A self-contained [Stremio](https://www.stremio.com/) addon that **fully downloads movies and TV episodes to disk** for buffer-free, fully offline playback — keeping every audio and subtitle track. It also ships a web dashboard for browsing titles, picking sources, watching download progress, and managing storage.

It has **zero external dependencies** and runs on the Node runtime that already ships with Stremio (`stremio-runtime.exe`), so there is nothing to `npm install`.

> **This is a self-hosted addon — you run it on your own machine.** There is no shared server to install from. You clone this repo, start the addon, and install it in Stremio from your own local URL (`http://127.0.0.1:11473/manifest.json`). It works only on the computer where it's running, because it drives *that* machine's Stremio torrent engine and saves files to *that* machine's disk. See [Setup](#setup) below.

> **Platform:** Windows. The launcher scripts, folder picker, and disk-space checks use Windows-specific tooling (PowerShell, `DriveInfo`, VBScript). The core `addon.js` is portable Node, but paths and helpers assume a Windows Stremio install.

**Maintainer:** Hagay Bar · <hagay_bar@outlook.com> · [LinkedIn](https://www.linkedin.com/in/hagay-bar-3741ba6b/)

---

## Quick start (self-hosted)

> Windows + the Stremio desktop app, running. No `npm install`, no account, no hosting.

```bat
git clone https://github.com/hagaluly/streamio-offline-downloader.git
cd streamio-offline-downloader
:: edit the stremio-runtime.exe path + addon folder in Start-Offline-Addon.bat if yours differ
Start-Offline-Addon.bat
```

Then, in Stremio, paste this into **Add-ons → Add-on Repository URL** and click Install:

```
http://127.0.0.1:11473/manifest.json
```

That's it — open any movie/episode and pick **"Offline Downloader → Save offline + play"**, or use the dashboard at <http://127.0.0.1:11473/>. Full details in [Setup](#setup) below.

---

## Linux / WSL2 (Ubuntu 22.04)

> Verified on Ubuntu 22.04 under WSL2 with Node.js 20. You run **two** processes inside
> WSL — Stremio's streaming server and this addon — and use both UIs from your Windows
> browser. No desktop GUI is required.

### 1. Install Stremio (provides the streaming server on port 11470)

```bash
sudo apt-get update
sudo apt-get install -y /path/to/stremio_4.4.168-1_amd64.deb
# zenity powers the dashboard's "Change…" downloads-folder picker (a GTK dialog
# shown on the Windows desktop via WSLg). Recommended.
sudo apt-get install -y zenity
```

This installs `/opt/stremio/server.js`. It needs `node` on `PATH` (the package depends on
`nodejs`); if `/usr/bin/node` is missing, run `sudo ln -s "$(command -v nodejs)" /usr/bin/node`.

### 2. Start the streaming server

```bash
./start-stremio-server.sh
```

Leave it running. It listens on `127.0.0.1:11470` — the engine this addon drives.

### 3. Start the addon (in a second terminal)

```bash
./start-offline-addon.sh
```

This serves the dashboard on `http://127.0.0.1:11473/`. It exports
`OFFLINE_STREAM_HOST=127.0.0.1` by default so that the HTTPS Stremio web UI does not block
the addon's HTTP stream URLs as mixed content.

**Shortcut — start both at once:** instead of steps 2 and 3, run `./start-all.sh`. It
launches the streaming server, waits for port 11470, then starts the addon — both in the
background (survives closing the terminal, but not a full WSL shutdown). Re-running is safe;
it skips whatever is already up. Downloads fail with *"streaming server (port 11470) is not
reachable"* whenever the server isn't running, so keep both alive.

**Stop both:** `./stop-all.sh`. Check what's running: `ss -ltn | grep -E ':1147(0|3)'`.

### 4. Use both UIs from your Windows browser

WSL2 forwards `localhost` to the WSL VM, so from a browser **on Windows**:

- **Stremio:** open <https://web.stremio.com>. It auto-connects to your local streaming
  server at `http://127.0.0.1:11470`. (If it does not, open Settings → it should show the
  server as connected.)
- **Addon dashboard:** open <http://localhost:11473/>.
- **Install the addon into Stremio:** in the web UI, go to **Add-ons → Add-on Repository
  URL**, paste `http://127.0.0.1:11473/manifest.json`, and click Install.

If `localhost` from Windows does not reach WSL, find the WSL IP with `ip addr show eth0`
and use that IP instead, or ensure `localhostForwarding=true` in your `%UserProfile%\.wslconfig`.
Windows Defender Firewall may prompt the first time — allow it.

### Notes for Linux

- Disk-space checks use `fs.statfs` (no PowerShell).
- The dashboard's external "Play" button uses an installed player (`vlc`/`mpv`) if present,
  otherwise `xdg-open`. In WSL this opens on the Linux side; normal playback is through the
  Stremio web UI.
- The dashboard's "Change…" downloads-folder button uses `zenity` (installed in step 1).
  Without it the button does nothing — there is no manual text-entry fallback. To change the
  folder without zenity, set `OFFLINE_DIR=/your/path` before `./start-offline-addon.sh`.
  The chooser browses the Linux filesystem; Windows drives are under `/mnt/c`, `/mnt/d` (a
  Linux path downloads faster).
- Launcher scripts: `start-stremio-server.sh`, `start-offline-addon.sh` (the `.bat`/`.ps1`/
  `.vbs` files are Windows-only).

---

## Screenshots

**Browse & search** — find any movie or series and queue a download:

![Dashboard: browse and search](docs/screenshots/dashboard.png)

**Pick a source & track downloads** — choose quality/source, see available subtitle tracks, and manage your offline library:

![Dashboard: sources and downloads](docs/screenshots/sources-and-downloads.png)

---

## How it works

Stremio bundles a local streaming/torrent server on `127.0.0.1:11470`. This addon **drives that existing engine** rather than running its own:

1. For a given title, it queries [Torrentio](https://torrentio.strem.fun) for torrent sources (sorted best-quality-first, then by seeders).
2. It asks Stremio's engine to create the torrent, then pulls the chosen video file (plus any sidecar subtitle files) over HTTP to a local folder.
3. Once on disk, the file is served back to Stremio over the LAN IP with full HTTP range support — so playback is instant, never buffers, and includes all tracks.
4. A "Save offline + play" stream lets you **start watching immediately while the file saves in the background**.

The addon never spawns its own copy of Stremio's `server.js` — doing so would race with Stremio's own server and can crash it. It only checks that port `11470` is reachable.

### Components

| File | Role |
|------|------|
| `addon.js` | The whole addon: HTTP server, Stremio addon protocol, torrent/download manager, file serving, and the dashboard API. Listens on port **11473**. |
| `dashboard.html` | The web UI (search, sources, downloads, storage). Inlined and served at `/`. |
| `Start-Offline-Addon.bat` | Manual launcher — starts the addon on Stremio's runtime and opens the dashboard. |
| `watch-addon.ps1` | Watchdog that ties the addon's lifecycle to Stremio: starts `addon.js` when port 11470 comes up, stops it when Stremio exits. |
| `run-watcher-hidden.vbs` | Launches the watcher with no console window (used by a login scheduled task). |
| `pickfolder.ps1` | Shows the native Windows "Browse for Folder" dialog for choosing the downloads directory. |

---

## Requirements

- **Stremio desktop app** installed (provides `stremio-runtime.exe` and the streaming server on port 11470). The Stremio app must be running for downloads to work.
- **Windows 10/11.**
- *(Optional)* **VLC** — used as the external player for the dashboard's ▶ Play button if found at the default install path; otherwise the system default player is used.

---

## Setup

### 1. Configure paths

The scripts contain hard-coded paths that you must point at your own machine. Update these to match your install:

- In `Start-Offline-Addon.bat`, `watch-addon.ps1`, and `run-watcher-hidden.vbs`:
  - `stremio-runtime.exe` location (default: `C:\Users\<you>\AppData\Local\Programs\Stremio\stremio-runtime.exe`)
  - the addon directory path
- These can also be overridden at runtime via environment variables (see [Configuration](#configuration)).

### 2. Run the addon

Double-click **`Start-Offline-Addon.bat`**. It will:
- start `addon.js` on Stremio's bundled runtime, and
- open the dashboard at <http://127.0.0.1:11473/>.

Keep that window open while you use offline downloads.

### 3. Install the addon in Stremio

In Stremio, add the addon by URL:

```
http://127.0.0.1:11473/manifest.json
```

or click the install link the launcher prints:

```
stremio://127.0.0.1:11473/manifest.json
```

You'll now see an **"Offline Downloader"** entry under streams (to save + play) and an **"Offline Downloads"** catalog (your downloaded library).

### 4. (Optional) Auto-start with Stremio

To have the addon start and stop automatically alongside Stremio:

1. Point the paths in `watch-addon.ps1` and `run-watcher-hidden.vbs` at your addon directory.
2. Register a **Task Scheduler** task that runs `run-watcher-hidden.vbs` at login. The watcher polls port 11470 every 5 seconds and manages the addon process for you (with a 2-poll grace period before shutdown).

---

## Using it

### From Stremio
- Open any movie or episode. Under streams you'll see **"Offline Downloader → Save offline + play"** options. Selecting one starts the download **and** begins playback immediately.
- Completed items appear as an **"Offline"** play option (instant, buffer-free) and in the **"Offline Downloads"** catalog.

### From the dashboard (<http://127.0.0.1:11473/>)
- **Search** movies or series by title (powered by Cinemeta), or browse Popular / New.
- **Pick a source** per title/episode and start a download.
- **Track progress** — live percentage, speed, and size for active downloads.
- **Play** completed files in VLC / your default player, copy a Stremio play link, **retry** failed downloads, or **delete** them (removes the file and sidecar subtitles).
- **Manage storage** — see free/total disk space and space used by your downloads, and **change the downloads folder** (existing downloads are moved to the new location).
- **Add manually** — paste a magnet link or infohash to queue a download directly.

---

## Configuration

`addon.js` reads these environment variables (all optional):

| Variable | Default | Purpose |
|----------|---------|---------|
| `OFFLINE_PORT` | `11473` | Port the addon/dashboard listens on. |
| `OFFLINE_DIR` | `<home>\Downloads\Stremio` | Downloads directory. Overrides the folder saved in `data/downloads.json`. |
| `OFFLINE_STREAM_HOST` | auto-detected LAN IP | Host advertised in play/stream URLs (Stremio may ignore `127.0.0.1` streams). |
| `OFFLINE_TORRENTIO` | `https://torrentio.strem.fun` | Torrentio base URL for source lookups. |
| `OFFLINE_PLAYER` | VLC if installed | Path to the external player for the dashboard Play button. |
| `STREMIO_DIR` | `...\Programs\Stremio` | Stremio install directory. |

### Runtime data

The addon writes runtime state under `data/` (created automatically):
- `downloads.json` — the download database and saved settings (downloads folder).
- `*.log` / `*.err` / `*.pid` — process logs and bookkeeping.

These, along with the `downloads/` output folder and local tooling, are excluded from git via `.gitignore`.

---

## Notes & limitations

- **Stremio must be running** — the addon depends on Stremio's streaming server (port 11470). If it isn't reachable, downloads fail with a clear message.
- For **movies**, TV-episode files that Torrentio sometimes mixes in from multi-title packs are filtered out automatically.
- Downloads **resume on startup** if they were interrupted while in progress.
- A **3% disk headroom** check runs before each download; it won't block if disk space can't be read.
- This tool only orchestrates Stremio's own torrent engine and public addons. You are responsible for ensuring your use complies with the law in your jurisdiction.

---

## Author

**Hagay Bar**
- Email: <hagay_bar@outlook.com>
- LinkedIn: <https://www.linkedin.com/in/hagay-bar-3741ba6b/>
