## What does this MR do?

<!-- Briefly describe the change and why it's needed. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / cleanup
- [ ] Docs

## Checklist

- [ ] I tested this against a running Stremio instance (port 11470 reachable).
- [ ] The addon still starts and the dashboard loads at `http://127.0.0.1:11473/`.
- [ ] No hard-coded machine-specific paths were introduced (use env vars where possible).
- [ ] I did **not** commit anything under `data/`, `downloads/`, or `_probe/` (see `.gitignore`).
- [ ] If I changed the manifest, I bumped the `version` in `addon.js`.

## How to test

<!-- Steps a reviewer can follow to verify the change. -->

## Related issues

<!-- e.g. Closes #1 -->

/cc @hagay_bar
