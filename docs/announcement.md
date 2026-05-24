# Announcement copy

Reusable text for announcing / releasing the addon.

---

## r/StremioAddons post

**Title:**

```
[Self-hosted] Offline Downloader — download movies/episodes to disk for buffer-free, fully offline playback (Windows)
```

**Body:**

I built a small self-hosted Stremio addon that fully downloads a title to disk and then serves it back to Stremio locally — so playback is instant, never buffers, and keeps **every audio and subtitle track**. Handy for flights, spotty connections, or just archiving stuff you can already stream.

**How it works:** it drives Stremio's *own* bundled torrent engine (the one already running on `127.0.0.1:11470`) to pull the original file to your disk, then serves it back with full HTTP range support. It doesn't run its own torrent client or bundle any content — it just orchestrates the engine and public addons (Torrentio/Cinemeta/OpenSubtitles) you're already using.

**Extras:**
- Web dashboard to search titles, pick a source by quality/seeders, watch download progress, and manage storage
- "Save offline + play" — start watching immediately while it saves in the background
- Auto-resumes interrupted downloads; disk-space check before each download

**Notes:** It's **self-hosted** — you run it on your own machine and install from your own `http://127.0.0.1:11473/manifest.json`. No account, no hosting, **zero dependencies** (runs on the Node runtime Stremio already ships). **Windows only** for now (the launchers/folder-picker use PowerShell/VBScript).

Repo + quick-start: https://github.com/hagaluly/streamio-offline-downloader

Feedback welcome — especially on making it cross-platform.

---

## GitHub Release notes (v1.0.0)

**Title:** `v1.0.0 — Offline Downloader`

**Body:**

First public release. A self-hosted Stremio addon (Windows) that downloads movies and TV episodes to disk for buffer-free, fully offline playback — keeping every audio and subtitle track.

### Features
- Drives Stremio's bundled torrent engine to download the original file to disk, then serves it back locally with HTTP range support (instant, never buffers).
- "Save offline + play" — start watching immediately while the file saves in the background.
- Web dashboard: search/browse titles, pick a source by quality + seeders, track progress/speed, manage storage, change download folder.
- Keeps all audio + subtitle tracks; downloads sidecar subtitle files too.
- Auto-resumes interrupted downloads; disk-space check (3% headroom) before each download.
- Zero external dependencies — runs on the Node runtime that ships with Stremio.

### Requirements
- Windows 10/11, Stremio desktop app installed and running.
- (Optional) VLC for the dashboard's external-player button.

### Install
Self-hosted — see the [Quick start](https://github.com/hagaluly/streamio-offline-downloader#quick-start-self-hosted) in the README.
