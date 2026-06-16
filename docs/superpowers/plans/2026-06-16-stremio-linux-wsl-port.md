# Stremio + Offline Downloader on Ubuntu 22.04 (WSL2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install the Stremio desktop `.deb` and the Offline Downloader addon on Ubuntu 22.04 under WSL2, run both headless inside WSL, make both UIs reachable from the Windows host browser, and port the Windows-only addon code to Linux on a new `ubuntu22` git branch.

**Architecture:** Stremio's bundled **streaming server** (`/opt/stremio/server.js`, port `11470`) runs headless in WSL — no GUI. The user drives Stremio from the Windows browser via `https://web.stremio.com`, which auto-connects to the local server through WSL2's localhost forwarding. The **Offline Downloader addon** (`addon.js`, port `11473`) also runs in WSL; its dashboard is a plain web page opened from the Windows browser at `http://localhost:11473`. The addon's Windows-specific helpers (disk-space via PowerShell, VLC path, folder picker, external-player launch) get surgical per-platform branches. The Linux launcher defaults the advertised stream host to `127.0.0.1` so HTTPS `web.stremio.com` does not block the HTTP stream URLs as mixed content.

**Tech Stack:** Node.js 20 (`/usr/bin/node` v20.20.2), Stremio 4.4.168 `.deb`, bash launcher scripts, WSL2 + WSLg, git/GitHub (`origin` = `hagaluly/streamio-offline-downloader`).

**Environment facts already verified (do not re-discover):**
- Working dir: `/REPOS/STREAMIO`. Repo: `/REPOS/STREAMIO/streamio-offline-downloader` (git, on `main`, clean, `origin` is GitHub).
- The `.deb` is at `/REPOS/STREAMIO/stremio_4.4.168-1_amd64 (1).deb` (filename has a space and parens — handle by copying to a clean name).
- `.deb` depends on: `nodejs, libmpv1, qml-module-qt-labs-platform, qml-module-qtquick-controls, qml-module-qtquick-dialogs, qml-module-qtwebchannel, qml-module-qtwebengine, qml-module-qt-labs-folderlistmodel, qml-module-qt-labs-settings, librubberband2, libuchardet0, libfdk-aac2`. (We only need `server.js` to run, which needs `nodejs` + `libmpv1`; apt will pull the rest but that is fine.)
- `.deb` payload: `/opt/stremio/server.js`, `/opt/stremio/stremio` (GUI, unused here), and symlink `/opt/stremio/node -> /usr/bin/node`.
- `/usr/bin/node` **exists** (so the symlink resolves). `xdg-open` present. `zenity` and `vlc` **absent** (addon must degrade gracefully).
- Node 20 provides `fs.statfs` (used to replace the PowerShell disk check).
- Passwordless `sudo` works. WSLg is active (`DISPLAY=:0`) but unused on this path.

**Windows-specific code in `addon.js` to port (current line numbers):**
1. `findPlayer()` lines 63–72 — hardcoded `C:\...\vlc.exe`.
2. `diskSpace()` lines 141–155 — `powershell.exe` + `[System.IO.DriveInfo]`.
3. `pickFolderNative()` lines 167–173 — `powershell.exe` folder dialog.
4. `/api/play` handler lines 892–898 — `start "" "..."` (cmd.exe).
- `STREMIO_DIR` default (line 186) is a Windows path but is **dead code** (never read after definition). Per surgical rule: leave it untouched; do not delete pre-existing dead code.

---

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `addon.js` | Modify (4 surgical per-platform branches) | Add Linux branches to `findPlayer`, `diskSpace`, `pickFolderNative`, `/api/play`. No restructuring. |
| `start-stremio-server.sh` | Create | Launch `/opt/stremio/server.js` headless (port 11470). |
| `start-offline-addon.sh` | Create | Launch `addon.js` (port 11473) with Linux-appropriate env defaults (`OFFLINE_STREAM_HOST=127.0.0.1`). |
| `README.md` | Modify (append section) | Add "Linux / WSL2 (Ubuntu 22.04)" setup + start + Windows-access instructions. Do not alter existing Windows sections. |

System-level actions (not files in the repo, performed via Bash, documented here): install the `.deb`, verify the streaming server runs.

---

## Task 1: Install Stremio `.deb` and verify the streaming server

**Files:** none (system install).

- [ ] **Step 1: Copy the `.deb` to a space-free path**

The original filename has a space and parens which trips `apt`/`dpkg`. Work from a clean copy.

```bash
cp "/REPOS/STREAMIO/stremio_4.4.168-1_amd64 (1).deb" /tmp/stremio.deb
ls -l /tmp/stremio.deb
```
Expected: lists `/tmp/stremio.deb` (~985 KB).

- [ ] **Step 2: Install it with apt (resolves dependencies)**

```bash
sudo apt-get update
sudo apt-get install -y /tmp/stremio.deb
```
Expected: ends with `Setting up stremio (4.4.168-1) ...` and no unmet-dependency errors. (apt pulls `libmpv1`, the qml/qtwebengine modules, etc. — large but expected.)

- [ ] **Step 3: Verify install layout**

```bash
ls -l /opt/stremio/server.js /opt/stremio/node
node -v; /usr/bin/node -v
```
Expected: `server.js` exists; `/opt/stremio/node` is a symlink to `/usr/bin/node`; both `node -v` print `v20.x`. If `/usr/bin/node` is somehow missing, create it: `sudo ln -s "$(command -v nodejs)" /usr/bin/node`.

- [ ] **Step 4: Start the streaming server in the background and confirm it listens on 11470**

```bash
/usr/bin/node /opt/stremio/server.js > /tmp/stremio-server.log 2>&1 &
echo "server pid $!"
sleep 4
ss -ltn | grep -E ':11470' || echo "NOT LISTENING"
curl -s --max-time 5 http://127.0.0.1:11470/settings | head -c 200; echo
```
Expected: `ss` shows a listener on `127.0.0.1:11470`; `curl /settings` returns JSON (Stremio server config). If `curl` returns nothing, inspect `/tmp/stremio-server.log` for node errors (e.g. a missing native lib) before continuing.

- [ ] **Step 5: Stop the test server (the real launcher script will manage it later)**

```bash
pkill -f '/opt/stremio/server.js' || true
sleep 1; ss -ltn | grep -E ':11470' && echo "still up?" || echo "stopped"
```
Expected: `stopped`.

---

## Task 2: Create the Linux launcher scripts

**Files:**
- Create: `/REPOS/STREAMIO/streamio-offline-downloader/start-stremio-server.sh`
- Create: `/REPOS/STREAMIO/streamio-offline-downloader/start-offline-addon.sh`

- [ ] **Step 1: Create `start-stremio-server.sh`**

```bash
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
```

- [ ] **Step 2: Create `start-offline-addon.sh`**

`OFFLINE_STREAM_HOST` defaults to `127.0.0.1` here (not the LAN IP) because the user reaches the addon from the Windows browser over WSL2 localhost forwarding, and `web.stremio.com` (HTTPS) will block HTTP stream URLs from a non-localhost host as mixed content. Allow override via env.

```bash
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
```

- [ ] **Step 3: Make both executable**

```bash
cd /REPOS/STREAMIO/streamio-offline-downloader
chmod +x start-stremio-server.sh start-offline-addon.sh
ls -l start-stremio-server.sh start-offline-addon.sh
```
Expected: both show `-rwxr-xr-x`.

- [ ] **Step 4: Syntax-check both scripts (no execution)**

```bash
bash -n start-stremio-server.sh && bash -n start-offline-addon.sh && echo "syntax OK"
```
Expected: `syntax OK`.

---

## Task 3: Port `diskSpace()` to use `fs.statfs` on Linux

**Files:**
- Modify: `addon.js:141-155`

- [ ] **Step 1: Confirm the current (Windows-only) behavior fails on Linux**

```bash
cd /REPOS/STREAMIO/streamio-offline-downloader
node -e "const cp=require('child_process'); cp.execFile('powershell.exe',['-Command','1'],(e)=>console.log('powershell present?', !e));"
```
Expected: prints `powershell present? false` (no `powershell.exe` in WSL PATH) — confirming the current `diskSpace()` would resolve `{free:0,total:0,error:...}` and the dashboard storage panel would read zero.

- [ ] **Step 2: Replace the `diskSpace` function body with a POSIX branch**

Replace the existing function (lines 141–155):

```js
function diskSpace(forPath) {
  return new Promise((resolve) => {
    const root = driveRoot(forPath || DOWNLOADS_DIR);
    const ps = `$d=[System.IO.DriveInfo]::new('${root.replace(/'/g, "''")}'); ` +
      `Write-Output ($d.AvailableFreeSpace.ToString()+'|'+$d.TotalSize.ToString())`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve({ free: 0, total: 0, root, error: err.message });
        const parts = String(stdout).trim().split('|');
        const free = parseInt(parts[0], 10), total = parseInt(parts[1], 10);
        if (isNaN(free) || isNaN(total)) return resolve({ free: 0, total: 0, root, error: 'parse' });
        resolve({ free, total, root });
      });
  });
}
```

with:

```js
function diskSpace(forPath) {
  return new Promise((resolve) => {
    const target = forPath || DOWNLOADS_DIR;
    const root = driveRoot(target);
    if (process.platform !== 'win32') {
      // POSIX (Linux/WSL): statfs reports block counts; bavail = blocks free to
      // unprivileged users, blocks = total. fs.statfs is available on Node >= 18.15.
      fs.statfs(target, (err, st) => {
        if (err) return resolve({ free: 0, total: 0, root, error: err.message });
        resolve({ free: st.bavail * st.bsize, total: st.blocks * st.bsize, root });
      });
      return;
    }
    const ps = `$d=[System.IO.DriveInfo]::new('${root.replace(/'/g, "''")}'); ` +
      `Write-Output ($d.AvailableFreeSpace.ToString()+'|'+$d.TotalSize.ToString())`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve({ free: 0, total: 0, root, error: err.message });
        const parts = String(stdout).trim().split('|');
        const free = parseInt(parts[0], 10), total = parseInt(parts[1], 10);
        if (isNaN(free) || isNaN(total)) return resolve({ free: 0, total: 0, root, error: 'parse' });
        resolve({ free, total, root });
      });
  });
}
```

- [ ] **Step 3: Verify the POSIX branch returns real numbers**

```bash
cd /REPOS/STREAMIO/streamio-offline-downloader
node -e "
const cp=require('child_process');
const fs=require('fs');
fs.statfs('.', (e,st)=>{
  if(e) return console.log('FAIL', e.message);
  const free=st.bavail*st.bsize, total=st.blocks*st.bsize;
  console.log('free', free, 'total', total, free>0 && total>=free ? 'OK' : 'BAD');
});
"
```
Expected: prints non-zero `free`/`total` and `OK`. (This exercises the same `fs.statfs` math the edited function now uses; full end-to-end check happens in Task 7 via `/api/storage`.)

---

## Task 4: Port `findPlayer()` to detect Linux players

**Files:**
- Modify: `addon.js:65-68`

- [ ] **Step 1: Replace the Windows-only candidate list**

Replace (lines 65–68):

```js
  const cands = [
    'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
    'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe'
  ];
```

with:

```js
  const cands = process.platform === 'win32'
    ? ['C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
       'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe']
    : ['/usr/bin/vlc', '/usr/local/bin/vlc', '/snap/bin/vlc', '/usr/bin/mpv'];
```

- [ ] **Step 2: Verify it returns `null` (no player installed) without throwing**

```bash
cd /REPOS/STREAMIO/streamio-offline-downloader
node -e "
const fs=require('fs');
const cands=['/usr/bin/vlc','/usr/local/bin/vlc','/snap/bin/vlc','/usr/bin/mpv'];
let found=null; for(const c of cands){ try{ if(fs.existsSync(c)){found=c;break;} }catch(_){}}
console.log('player:', found);
"
```
Expected: `player: null` (vlc/mpv not installed). The dashboard Play button will then fall back to `xdg-open` (Task 5). No crash.

---

## Task 5: Port the `/api/play` external-player launch to `xdg-open` on Linux

**Files:**
- Modify: `addon.js:892-898`

- [ ] **Step 1: Add a Linux branch to the play launcher**

Replace (lines 892–898):

```js
      if (PLAYER) {
        execFile(PLAYER, [rec.filePath], {}, (e) => { if (e) log('player launch error', e.message); });
      } else {
        const safe = rec.filePath.replace(/"/g, '');
        exec(`start "" "${safe}"`, { windowsHide: true }, (e) => { if (e) log('play launch error', e.message); });
      }
```

with:

```js
      if (PLAYER) {
        execFile(PLAYER, [rec.filePath], {}, (e) => { if (e) log('player launch error', e.message); });
      } else if (process.platform === 'win32') {
        const safe = rec.filePath.replace(/"/g, '');
        exec(`start "" "${safe}"`, { windowsHide: true }, (e) => { if (e) log('play launch error', e.message); });
      } else {
        execFile('xdg-open', [rec.filePath], {}, (e) => { if (e) log('play launch error', e.message); });
      }
```

- [ ] **Step 2: Confirm `xdg-open` exists (the launch target on Linux)**

```bash
command -v xdg-open && echo "xdg-open OK"
```
Expected: prints a path and `xdg-open OK`. (Note: in WSL, the dashboard "Play" button is a best-effort host-side open; primary playback is through Stremio's web UI. This branch just keeps it from issuing a `start` cmd that fails on Linux.)

---

## Task 6: Port `pickFolderNative()` to `zenity` on Linux (graceful fallback)

**Files:**
- Modify: `addon.js:167-173`

- [ ] **Step 1: Add a Linux branch using zenity, falling back to empty string**

Replace (lines 167–173):

```js
function pickFolderNative(initial) {
  return new Promise((resolve) => {
    const ps1 = path.join(ROOT, 'pickfolder.ps1');
    execFile('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ps1, initial || ''],
      { windowsHide: true, timeout: 180000 }, (err, stdout) => { resolve(String(stdout || '').trim()); });
  });
}
```

with:

```js
function pickFolderNative(initial) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      // Linux/WSL: use zenity's directory chooser if available. If zenity is not
      // installed (or errors), resolve empty so the dashboard falls back to the
      // manual path-entry box (POST /api/setdir).
      const args = ['--file-selection', '--directory', '--title=Choose the Stremio downloads folder'];
      if (initial) args.push('--filename=' + initial.replace(/\/?$/, '/'));
      execFile('zenity', args, { timeout: 180000 }, (err, stdout) => resolve(String(stdout || '').trim()));
      return;
    }
    const ps1 = path.join(ROOT, 'pickfolder.ps1');
    execFile('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ps1, initial || ''],
      { windowsHide: true, timeout: 180000 }, (err, stdout) => { resolve(String(stdout || '').trim()); });
  });
}
```

- [ ] **Step 2: Verify the fallback resolves to a string when zenity is absent**

```bash
cd /REPOS/STREAMIO/streamio-offline-downloader
PATH="" node -e "
const cp=require('child_process');
new Promise((resolve)=>{
  cp.execFile('zenity',['--file-selection','--directory'],{timeout:2000},(err,stdout)=>resolve(String(stdout||'').trim()));
}).then(r=>console.log('result type:', typeof r, JSON.stringify(r)));
"
```
Expected: `result type: string ""` — confirming an absent/failing zenity yields an empty string, not a crash. (Optional: `sudo apt-get install -y zenity` to get the native dialog; the manual entry box works regardless.)

---

## Task 7: Integration smoke test — run server + addon, exercise endpoints

**Files:** none (runtime verification of Tasks 1–6 together).

- [ ] **Step 1: Start the streaming server (background)**

```bash
cd /REPOS/STREAMIO/streamio-offline-downloader
./start-stremio-server.sh > /tmp/stremio-server.log 2>&1 &
sleep 4
ss -ltn | grep ':11470' && echo "server up" || { cat /tmp/stremio-server.log; echo "SERVER FAILED"; }
```
Expected: `server up`.

- [ ] **Step 2: Start the addon (background)**

```bash
cd /REPOS/STREAMIO/streamio-offline-downloader
./start-offline-addon.sh > /tmp/offline-addon.log 2>&1 &
sleep 3
ss -ltn | grep ':11473' && echo "addon up" || { cat /tmp/offline-addon.log; echo "ADDON FAILED"; }
```
Expected: `addon up`; log shows `Stream host advertised to Stremio: 127.0.0.1` and `Offline Downloader addon on http://127.0.0.1:11473`.

- [ ] **Step 3: Health + manifest**

```bash
curl -s http://127.0.0.1:11473/health; echo
curl -s http://127.0.0.1:11473/manifest.json | head -c 200; echo
```
Expected: `{"ok":true,"downloads":0}`; manifest JSON containing `"id":"org.local.offline.downloader"`.

- [ ] **Step 4: Storage endpoint proves the `fs.statfs` port works end-to-end**

```bash
curl -s http://127.0.0.1:11473/api/storage; echo
```
Expected: JSON with non-zero `"free"` and `"total"` (e.g. `{"free":123456789,"total":...,"used":...,"root":"/","dir":"/home/hbar/Downloads/Stremio"}`). If `free` is `0`, the `diskSpace` port (Task 3) is wrong — fix before continuing.

- [ ] **Step 5: Search endpoint proves outbound HTTPS works (Cinemeta)**

```bash
curl -s "http://127.0.0.1:11473/api/search?type=movie&q=matrix" | head -c 200; echo
```
Expected: JSON `{"results":[...]}` with at least one entry. (Confirms the addon's HTTPS path is intact on Linux.)

- [ ] **Step 6: Stop both background processes**

```bash
pkill -f '/opt/stremio/server.js' || true
pkill -f "$(pwd)/addon.js" || true
sleep 1; ss -ltn | grep -E ':1147(0|3)' && echo "still up?" || echo "both stopped"
```
Expected: `both stopped`.

---

## Task 8: Document Linux / WSL2 setup in README

**Files:**
- Modify: `README.md` (append a new section near the existing "Quick start"; do not edit the Windows sections).

- [ ] **Step 1: Append the Linux/WSL2 section**

Insert the following block immediately **after** the existing `## Quick start (self-hosted)` section (i.e. before `## Screenshots`):

````markdown
## Linux / WSL2 (Ubuntu 22.04)

> Verified on Ubuntu 22.04 under WSL2 with Node.js 20. You run **two** processes inside
> WSL — Stremio's streaming server and this addon — and use both UIs from your Windows
> browser. No desktop GUI is required.

### 1. Install Stremio (provides the streaming server on port 11470)

```bash
sudo apt-get update
sudo apt-get install -y /path/to/stremio_4.4.168-1_amd64.deb
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
- The native "Browse for folder" button uses `zenity` if installed
  (`sudo apt-get install -y zenity`); otherwise type the path into the folder box and Save.
- Launcher scripts: `start-stremio-server.sh`, `start-offline-addon.sh` (the `.bat`/`.ps1`/
  `.vbs` files are Windows-only).
````

- [ ] **Step 2: Verify the markdown renders the section and links**

```bash
cd /REPOS/STREAMIO/streamio-offline-downloader
grep -n "Linux / WSL2 (Ubuntu 22.04)" README.md
grep -c "start-stremio-server.sh" README.md
```
Expected: the heading line is found; count `>= 1`.

---

## Task 9: Create the `ubuntu22` branch, commit, and push

**Files:** none (git operations). The user authorized running all git commands on this branch and pushing it.

- [ ] **Step 1: Create the branch**

```bash
cd /REPOS/STREAMIO/streamio-offline-downloader
git checkout -b ubuntu22
git status
```
Expected: `Switched to a new branch 'ubuntu22'`; status lists modified `addon.js`, `README.md`, and untracked `start-stremio-server.sh`, `start-offline-addon.sh`, and the plan file under `docs/superpowers/plans/`.

- [ ] **Step 2: Review the diff before committing**

```bash
git --no-pager diff -- addon.js README.md
git status --short
```
Expected: `addon.js` shows only the four per-platform branches; `README.md` shows only the appended section. Confirm no unintended changes.

- [ ] **Step 3: Stage and commit**

```bash
git add addon.js README.md start-stremio-server.sh start-offline-addon.sh docs/superpowers/plans/2026-06-16-stremio-linux-wsl-port.md
git commit -m "$(cat <<'EOF'
Add Linux/WSL2 support for Ubuntu 22.04

Port the Windows-specific helpers in addon.js to run on Linux with surgical
per-platform branches, and add bash launcher scripts plus README instructions
for running the streaming server and addon headless in WSL2 with both UIs
reachable from the Windows host browser.

- diskSpace(): use fs.statfs on POSIX instead of PowerShell DriveInfo
- findPlayer(): detect vlc/mpv on Linux
- /api/play: launch via xdg-open on Linux
- pickFolderNative(): use zenity on Linux, fall back to manual entry
- add start-stremio-server.sh and start-offline-addon.sh
  (defaults OFFLINE_STREAM_HOST=127.0.0.1 to avoid HTTPS mixed-content blocks)
- README: add "Linux / WSL2 (Ubuntu 22.04)" setup + start instructions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
git --no-pager log --oneline -1
```
Expected: commit created; `git log` shows the new commit on top.

- [ ] **Step 4: Push the branch to origin**

```bash
cd /REPOS/STREAMIO/streamio-offline-downloader
git push -u origin ubuntu22
```
Expected: branch published; output prints a `Create a pull request for 'ubuntu22'` URL. If push is rejected for auth, report the exact error to the user (their GitHub credentials/token govern this) rather than retrying blindly.

---

## Task 10: Final manual verification checklist (user-driven, from Windows)

**Files:** none. These steps require the user's Windows browser and confirm the end-to-end goal. Provide them to the user; the agent cannot click in the Windows browser.

- [ ] **Step 1: Both processes running in WSL**

In two WSL terminals: `./start-stremio-server.sh` and `./start-offline-addon.sh`. Confirm `ss -ltn | grep -E ':1147(0|3)'` shows both listeners.

- [ ] **Step 2: Addon dashboard from Windows** — open `http://localhost:11473/` in the Windows browser. Expected: the dashboard loads; the Storage panel shows real free/total space (not zero).

- [ ] **Step 3: Stremio web UI from Windows** — open `https://web.stremio.com`. Expected: it connects to the local streaming server (no "streaming server not available" banner).

- [ ] **Step 4: Install the addon** — in the web UI: Add-ons → Add-on Repository URL → `http://127.0.0.1:11473/manifest.json` → Install. Expected: "Offline Downloader" appears under installed add-ons, and an "Offline Downloads" catalog appears.

- [ ] **Step 5: End-to-end download** — open any movie, pick "Offline Downloader → Save offline + play". Expected: playback starts and the dashboard shows the item downloading with live progress; on completion it appears as an "Offline" instant-play stream. (If streams don't appear, double-check `OFFLINE_STREAM_HOST=127.0.0.1` and that port 11470 is reachable.)

---

## Self-Review

**Spec coverage:**
- Install `.deb` → Task 1. ✅
- Install the plugin / run it → Tasks 2, 7 (launchers + smoke run). ✅
- Run both on Linux → Tasks 1 (server), 2/7 (addon). ✅
- Access both UIs from Windows → Task 8 (instructions) + Task 10 (verification). ✅
- Start instructions for both → `start-stremio-server.sh`, `start-offline-addon.sh` (Task 2) + README (Task 8). ✅
- Check/needed Linux modifications → Tasks 3–6 (the four Windows-specific functions identified and ported). ✅
- Dedicated ubuntu-22 branch for changes → Task 9 (`ubuntu22`), commit + push. ✅

**Placeholder scan:** No TBD/TODO; every edit shows full before/after code; every verify step has an exact command and expected output.

**Type/name consistency:** Function names (`diskSpace`, `findPlayer`, `pickFolderNative`), ports (`11470`, `11473`), env var (`OFFLINE_STREAM_HOST`), script names (`start-stremio-server.sh`, `start-offline-addon.sh`), and branch name (`ubuntu22`) are used consistently across all tasks.

**Known non-changes (surgical rule):** `STREMIO_DIR` Windows default (addon.js:186) is pre-existing dead code — left untouched, noted only. The Windows launcher files (`.bat`/`.ps1`/`.vbs`) and `pickfolder.ps1` are left intact.
