# Catalog submission cheat-sheet

Ready-to-paste fields for listing **Stremio Offline Downloader** on
[stremio-addons.net](https://stremio-addons.net/submit-addon) (or wherever
self-hosted Stremio addons are shared, e.g. r/StremioAddons).

> **Important — this is a self-hosted addon.** There is no public manifest URL.
> Each user runs their own copy and installs from their own
> `http://127.0.0.1:11473/manifest.json`. Submission forms that *require* a
> reachable manifest URL will not validate a localhost address — for those,
> link the repository and describe it as self-hosted / install-it-yourself.

---

## Name
Stremio Offline Downloader

## Short description (one line)
Fully download movies & TV episodes to disk for buffer-free offline playback, keeping every audio and subtitle track.

## Long description
A self-hosted Stremio addon that drives Stremio's own bundled torrent engine to
download the original file to disk, then serves it back locally with full HTTP
range support — so playback is instant, never buffers, and includes all audio
and subtitle tracks. Ships a web dashboard for browsing/searching titles,
picking sources by quality and seeders, tracking download progress, and managing
storage. Zero external dependencies; runs on the Node runtime that already ships
with Stremio. Windows only.

## Type / tags
self-hosted, Windows, downloader, offline, catalog, movies, series

## Manifest URL (per user, after running locally)
http://127.0.0.1:11473/manifest.json

## Source / repository
https://gitlab.com/hagay_bar/streamio-offline-downloader
<!-- add the GitHub mirror URL here once created -->

## Logo
https://gitlab.com/hagay_bar/streamio-offline-downloader/-/raw/main/docs/logo.svg

## Maintainer
Hagay Bar · hagay_bar@outlook.com

## Notes for reviewers
- No preconfigured API keys or tokens in any URL.
- Does not bundle or scrape any content itself; it only orchestrates Stremio's
  existing local torrent engine and public addons (Torrentio, Cinemeta,
  OpenSubtitles) that the user already chooses to use.
- Requires the Stremio desktop app to be running (streaming server on port 11470).
