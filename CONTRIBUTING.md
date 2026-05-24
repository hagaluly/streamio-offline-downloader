# Contributing

Thanks for your interest in improving the Stremio Offline Downloader. This project uses a **Merge Request (MR) review process** — the `main` branch is protected and changes are reviewed before they land.

## Branch protection

- `main` is protected. The general public **cannot push** to it.
- Direct pushes are limited to project **Maintainers**; everyone else contributes via a fork and an MR.
- Force-pushes to `main` are disabled.
- MRs require **all discussions to be resolved** before they can be merged.

## How to contribute (external contributors)

1. **Fork** the project on GitLab.
2. Create a feature branch from `main`:
   ```bash
   git checkout -b my-change
   ```
3. Make your change. Keep it focused — one logical change per MR.
4. Test it against a running Stremio instance (the streaming server on port `11470` must be reachable). Confirm the addon starts and the dashboard loads at `http://127.0.0.1:11473/`.
5. Push your branch and **open a Merge Request** targeting `main`.
6. Fill in the MR template, then address review feedback. Resolve all discussion threads.
7. A maintainer merges once the review is complete.

## Guidelines

- **Don't commit runtime artifacts.** Anything under `data/`, `downloads/`, or `_probe/` is git-ignored — keep it that way.
- **Avoid hard-coded machine-specific paths.** Prefer the environment variables documented in the README (`OFFLINE_PORT`, `OFFLINE_DIR`, `STREMIO_DIR`, etc.).
- **Bump the version.** If you change the addon manifest, update `version` in `addon.js`.
- **Match the existing style.** The addon is intentionally dependency-free, hand-rolled Node — no build step, no `npm install`.

## Reporting issues

Open an issue describing the problem, your OS/Stremio version, and steps to reproduce.

## Maintainer

**Hagay Bar** — <hagay_bar@outlook.com> · [LinkedIn](https://www.linkedin.com/in/hagay-bar-3741ba6b/)
