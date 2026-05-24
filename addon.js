'use strict';
/*
 * Stremio Offline Downloader addon (zero external dependencies).
 * Runs on Stremio's bundled Node runtime (stremio-runtime.exe).
 *
 * It drives Stremio's bundled torrent engine (127.0.0.1:11470) to fully
 * download the original file to disk, then serves that file over 127.0.0.1
 * for buffer-free, all-audio/subtitle-track offline playback.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const net = require('net');
const os = require('os');
const { execFile, exec } = require('child_process');

// Stremio may ignore addon-returned streams that point at 127.0.0.1, so we
// advertise stream/play URLs on the machine's LAN IP and bind all interfaces.
function lanIP() {
  const ifaces = os.networkInterfaces();
  let candidates = [];
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name]) {
      if (ni.family === 'IPv4' && !ni.internal) candidates.push(ni.address);
    }
  }
  return candidates.find(a => /^192\.168\./.test(a))
    || candidates.find(a => /^10\./.test(a))
    || candidates.find(a => /^172\.(1[6-9]|2\d|3[01])\./.test(a))
    || candidates[0] || '127.0.0.1';
}
const STREAM_HOST = process.env.OFFLINE_STREAM_HOST || lanIP();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ADDON_PORT = parseInt(process.env.OFFLINE_PORT || '11473', 10);
const STREMIO_SERVER = { host: '127.0.0.1', port: 11470 };
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
let DOWNLOADS_DIR = process.env.OFFLINE_DIR || path.join(os.homedir(), 'Downloads', 'Stremio');
const DB_FILE = path.join(DATA_DIR, 'downloads.json');
const TORRENTIO = process.env.OFFLINE_TORRENTIO || 'https://torrentio.strem.fun';
// Series/episode markers (SxxExx, season-only Sxx, "Season N"). Used to filter out
// TV-episode files that torrentio sometimes returns for a movie id (e.g. unreleased
// films matched against large multi-title packs). "Chapter N" is deliberately NOT
// matched, since legit movies use it (e.g. "John Wick: Chapter 4").
const EPISODE_RE = /\bS\d{1,2}(?:E\d{1,3})?\b|\bseason\s*\d+\b/i;
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.coppersurfer.tk:6969/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.openbittorrent.com:6969/announce'
];

fs.mkdirSync(DATA_DIR, { recursive: true });

// Preferred external player for the dashboard "Play" button (VLC if present).
function findPlayer() {
  if (process.env.OFFLINE_PLAYER && fs.existsSync(process.env.OFFLINE_PLAYER)) return process.env.OFFLINE_PLAYER;
  const cands = [
    'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
    'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe'
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return null;
}
const PLAYER = findPlayer();

// ---------------------------------------------------------------------------
// Tiny DB (JSON file) keyed by download id
// ---------------------------------------------------------------------------
let DB = { downloads: {} };
function loadDB() {
  try { DB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (_) { DB = { downloads: {} }; }
  if (!DB.downloads) DB.downloads = {};
  if (!DB.settings) DB.settings = {};
  // Apply a previously-chosen download folder (unless overridden by env var).
  if (!process.env.OFFLINE_DIR && DB.settings.downloadsDir) DOWNLOADS_DIR = DB.settings.downloadsDir;
}
function moveFileSafe(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.renameSync(src, dest); }
  catch (e) {
    if (e.code === 'EXDEV') { fs.copyFileSync(src, dest); fs.unlinkSync(src); } // cross-drive
    else throw e;
  }
}
let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2)); } catch (e) { log('saveDB error', e.message); }
  }, 250);
}
function saveDBNow() { try { fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2)); } catch (e) {} }
loadDB();
try { fs.mkdirSync(DOWNLOADS_DIR, { recursive: true }); } catch (e) { /* logged later */ }

function log(...a) { console.log(new Date().toISOString(), ...a); }
function rid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
function sanitize(s) { return String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150); }

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function serverReq(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: STREMIO_SERVER.host, port: STREMIO_SERVER.port, path: p, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
function httpsGetJSON(u, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(u, { headers: { 'user-agent': 'stremio-offline-addon' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGetJSON(res.headers.location, timeoutMs).then(resolve, reject);
      }
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 6000, () => { req.destroy(new Error('timeout')); });
  });
}

// ---------------------------------------------------------------------------
// Disk space (fs.statfs not available on node 18.12; use DriveInfo via PowerShell)
// ---------------------------------------------------------------------------
function driveRoot(p) { return path.parse(path.resolve(p)).root; }
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
async function checkSpace(sizeBytes) {
  const ds = await diskSpace(DOWNLOADS_DIR);
  const needed = Math.ceil((Number(sizeBytes) || 0) * 1.03); // 3% headroom
  const enough = ds.free > 0 ? ds.free >= needed : true; // if we can't read disk, don't block
  return {
    enough, free: ds.free, total: ds.total, needed, root: ds.root,
    message: enough ? 'OK'
      : `Not enough storage: need ${fmtBytes(needed)} but only ${fmtBytes(ds.free)} free on ${ds.root}. Free up space and try again.`
  };
}
// Show the native Windows "Browse for Folder" dialog and return the chosen path.
function pickFolderNative(initial) {
  return new Promise((resolve) => {
    const ps1 = path.join(ROOT, 'pickfolder.ps1');
    execFile('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ps1, initial || ''],
      { windowsHide: true, timeout: 180000 }, (err, stdout) => { resolve(String(stdout || '').trim()); });
  });
}
function usedByDownloads() {
  let used = 0;
  for (const d of Object.values(DB.downloads)) {
    if (d.status === 'completed' && d.sizeBytes) used += d.sizeBytes;
    else if (d.bytesDownloaded) used += d.bytesDownloaded;
  }
  return used;
}

// ---------------------------------------------------------------------------
// Torrent engine interaction
// ---------------------------------------------------------------------------
const STREMIO_DIR = process.env.STREMIO_DIR || 'C:\\Users\\hbar\\AppData\\Local\\Programs\\Stremio';
function portOpen(host, port, timeout) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { try { s.destroy(); } catch (_) {} resolve(v); };
    s.setTimeout(timeout || 1500);
    s.on('connect', () => done(true));
    s.on('timeout', () => done(false));
    s.on('error', () => done(false));
  });
}
async function ensureStremioServer() {
  // The Stremio app/background service already owns the torrent server on 11470.
  // We only check reachability — never spawn a competing server.js (that races
  // with Stremio's own server and can crash it).
  return portOpen(STREMIO_SERVER.host, STREMIO_SERVER.port);
}
async function createTorrent(infoHash, trackers) {
  if (!(await ensureStremioServer())) throw new Error('Stremio streaming server (port 11470) is not reachable. Open the Stremio app and try again.');
  const tr = (trackers && trackers.length) ? trackers : DEFAULT_TRACKERS;
  const body = {
    torrent: { infoHash, announce: tr },
    peerSearch: { sources: ['dht:' + infoHash, ...tr], min: 80, max: 200 },
    guessFileIdx: {}
  };
  const r = await serverReq('POST', `/${infoHash}/create`, body);
  if (r.status !== 200) throw new Error('create failed ' + r.status);
  return JSON.parse(r.body);
}
function pickVideoFile(files, preferIdx) {
  if (typeof preferIdx === 'number' && files[preferIdx]) return preferIdx;
  let idx = 0, max = -1;
  files.forEach((f, i) => { if (f.length > max) { max = f.length; idx = i; } });
  return idx;
}
const VIDEO_RE = /\.(mkv|mp4|avi|mov|webm|m4v|ts|flv|wmv|mpg|mpeg)$/i;
const SUB_RE = /\.(srt|vtt|sub|ssa|ass)$/i;
function langFromName(n) {
  const m = String(n).match(/\.([a-z]{2,3})\.(srt|vtt|sub|ssa|ass)$/i);
  return m ? m[1].toLowerCase() : 'und';
}

// ---------------------------------------------------------------------------
// Download manager
// ---------------------------------------------------------------------------
const active = {}; // dlId -> { req, ws }

async function startDownload(rec) {
  try {
    rec.status = 'downloading';
    rec.error = null;
    saveDB();
    log('start download', rec.dlId, rec.name);
    const info = await createTorrent(rec.infoHash, rec.trackers);
    const files = info.files || [];
    const vIdx = pickVideoFile(files, rec.fileIdx);
    const vfile = files[vIdx];
    rec.fileIdx = vIdx;
    rec.sizeBytes = vfile.length;
    rec.fileName = vfile.name;

    // disk space check
    const sp = await checkSpace(vfile.length);
    if (!sp.enough) {
      rec.status = 'error';
      rec.error = sp.message;
      saveDBNow();
      log('insufficient space', rec.error);
      return;
    }

    const destDir = path.join(DOWNLOADS_DIR, sanitize(rec.folder || rec.name));
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, sanitize(vfile.name));
    rec.filePath = destPath;

    // Download any sidecar subtitle files first (small)
    rec.subtitles = [];
    for (let i = 0; i < files.length; i++) {
      if (SUB_RE.test(files[i].name) && files[i].length < 5 * 1024 * 1024) {
        try {
          const subPath = path.join(destDir, sanitize(files[i].name));
          await downloadFileFromEngine(rec.infoHash, i, files[i].length, subPath, () => {}, rec.dlId);
          rec.subtitles.push({ idx: rec.subtitles.length, lang: langFromName(files[i].name), name: files[i].name, path: subPath });
        } catch (e) { log('sub dl failed', files[i].name, e.message); }
      }
    }
    saveDB();

    // Download main video file with progress tracking
    let lastBytes = 0, lastT = Date.now();
    await downloadFileFromEngine(rec.infoHash, vIdx, vfile.length, destPath, (recv) => {
      rec.bytesDownloaded = recv;
      const now = Date.now();
      if (now - lastT >= 1000) {
        rec.speed = (recv - lastBytes) / ((now - lastT) / 1000);
        lastBytes = recv; lastT = now;
        saveDB();
      }
    }, rec.dlId);

    rec.bytesDownloaded = vfile.length;
    rec.status = 'completed';
    rec.speed = 0;
    rec.completedAt = Date.now();
    saveDBNow();
    log('completed', rec.dlId, rec.name);
  } catch (e) {
    rec.status = 'error';
    rec.error = e.message;
    saveDBNow();
    log('download error', rec.dlId, e.message);
  } finally {
    delete active[rec.dlId];
  }
}

function downloadFileFromEngine(infoHash, fileIdx, expected, destPath, onProgress, dlId) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(destPath);
    let recv = 0;
    const clear = () => { if (dlId && active[dlId]) delete active[dlId]; };
    const fail = (e) => { try { ws.destroy(); } catch (_) {} clear(); reject(e); };
    const req = http.get({ host: STREMIO_SERVER.host, port: STREMIO_SERVER.port, path: `/${infoHash}/${fileIdx}` }, (res) => {
      if (res.statusCode !== 200 && res.statusCode !== 206) return fail(new Error('engine status ' + res.statusCode));
      res.on('data', (c) => { recv += c.length; onProgress(recv); });
      res.pipe(ws);
      res.on('error', fail);
      ws.on('finish', () => {
        clear();
        if (expected && recv < expected) return reject(new Error(`incomplete ${recv}/${expected}`));
        resolve(recv);
      });
      ws.on('error', fail);
    });
    req.on('error', fail);
    if (dlId) active[dlId] = { req, ws };
  });
}

function fmtBytes(b) {
  b = Number(b) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return b.toFixed(i ? 1 : 0) + ' ' + u[i];
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function deleteDownload(dlId) {
  const rec = DB.downloads[dlId];
  if (!rec) return { ok: false, error: 'not found' };
  // Abort any in-progress download first so the OS releases the file handle.
  const a = active[dlId];
  if (a) {
    try { a.req && a.req.destroy(); } catch (_) {}
    try { a.ws && a.ws.destroy(); } catch (_) {}
    delete active[dlId];
    await wait(200);
  }
  // Delete the main video file, retrying briefly in case the handle is still releasing.
  let lockErr = null;
  if (rec.filePath && fs.existsSync(rec.filePath)) {
    let gone = false;
    for (let i = 0; i < 6 && !gone; i++) {
      try { fs.unlinkSync(rec.filePath); gone = true; }
      catch (e) { lockErr = e.code || e.message; await wait(200); }
    }
    if (!gone && fs.existsSync(rec.filePath)) {
      log('delete file err', rec.filePath, lockErr);
      // Keep the record so the user can retry after closing whatever holds the file.
      return { ok: false, fileRemoved: false, error: 'Could not delete the file — it may be open in your video player or still in use. Close it and try again.' };
    }
  }
  // File is gone (or never existed): clean up sidecar subtitles + the (now empty) folder.
  if (rec.subtitles) rec.subtitles.forEach(s => { try { s.path && fs.existsSync(s.path) && fs.unlinkSync(s.path); } catch (_) {} });
  const dir = rec.filePath && path.dirname(rec.filePath);
  if (dir && fs.existsSync(dir)) { try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch (_) {} }
  delete DB.downloads[dlId];
  saveDBNow();
  return { ok: true, fileRemoved: true };
}

// resume any interrupted downloads on startup
function resumeInterrupted() {
  for (const rec of Object.values(DB.downloads)) {
    if (rec.status === 'downloading' || rec.status === 'queued') {
      log('resuming', rec.dlId);
      startDownload(rec);
    }
  }
}

// ---------------------------------------------------------------------------
// Provider: torrent options for a title (Torrentio)
// ---------------------------------------------------------------------------
function qualityRank(text) {
  const t = String(text).toLowerCase();
  if (/2160p|\buhd\b|\b4k\b/.test(t)) return 5;
  if (/1440p|\b2k\b/.test(t)) return 4;
  if (/1080p|fullhd|\bfhd\b/.test(t)) return 3;
  if (/720p|\bhd\b/.test(t)) return 2;
  if (/480p|360p|\bsd\b|\bcam\b|\bts\b|telesync|dvdscr|hdcam/.test(t)) return 1;
  return 0; // unknown quality -> bottom
}
function seedersOf(text) {
  const m = String(text).match(/👤\s*(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}
async function getTorrentOptions(type, id) {
  try {
    const data = await httpsGetJSON(`${TORRENTIO}/stream/${type}/${encodeURIComponent(id)}.json`);
    const out = [];
    for (const s of (data.streams || [])) {
      if (!s.infoHash) continue;
      const title = (s.title || s.name || '').replace(/\n/g, ' ');
      const label = (s.name || 'Torrent').replace(/\n/g, ' ');
      out.push({
        infoHash: s.infoHash,
        fileIdx: typeof s.fileIdx === 'number' ? s.fileIdx : undefined,
        label, title,
        quality: qualityRank(label + ' ' + title),
        seeders: seedersOf(title),
        trackers: (s.sources || []).filter(x => /^tracker:/.test(x)).map(x => x.replace(/^tracker:/, ''))
      });
    }
    // For movies, drop TV-episode files torrentio sometimes mixes in (from multi-title packs).
    const filtered = type === 'movie' ? out.filter(o => !EPISODE_RE.test(o.label + ' ' + o.title)) : out;
    // Best quality first, then most seeders within the same quality tier.
    filtered.sort((a, b) => (b.quality - a.quality) || (b.seeders - a.seeders));
    return filtered;
  } catch (e) { log('torrentio err', e.message); return []; }
}

// ---------------------------------------------------------------------------
// Addon protocol
// ---------------------------------------------------------------------------
const MANIFEST = {
  id: 'org.local.offline.downloader',
  version: '1.0.0',
  name: 'Offline Downloader',
  description: 'Download movies & episodes to disk for buffer-free offline playback (all audio/subtitle tracks). Manage downloads, progress, and storage at http://127.0.0.1:' + ADDON_PORT,
  logo: 'https://icongr.am/material/download.svg?color=6c5ce7',
  resources: ['catalog', 'meta', 'stream', 'subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'offline'],
  catalogs: [
    { type: 'movie', id: 'offline-movies', name: 'Offline Downloads' },
    { type: 'series', id: 'offline-series', name: 'Offline Downloads' }
  ],
  behaviorHints: { configurable: true, configurationRequired: false, p2p: false }
};

function recordsFor(streamId) {
  return Object.values(DB.downloads).filter(r => r.streamId === streamId);
}

function streamForRecord(rec) {
  const ext = path.extname(rec.fileName || rec.filePath || '').toLowerCase();
  const notWebReady = ext !== '.mp4' && ext !== '.webm' && ext !== '.m4v';
  return {
    name: 'Offline',
    title: '▶ Play downloaded\n' + (rec.fileName || rec.name) + '\n' + fmtBytes(rec.sizeBytes),
    url: `http://${STREAM_HOST}:${ADDON_PORT}/play/${rec.dlId}`,
    behaviorHints: { bingeGroup: 'offline-' + rec.dlId, notWebReady, filename: rec.fileName, videoSize: rec.sizeBytes }
  };
}

async function handleStream(type, id) {
  const streams = [];
  // completed offline copies for this id -> play local file (instant, buffer-free)
  const seenHash = new Set();
  for (const rec of recordsFor(id)) {
    if (rec.status === 'completed') { streams.push(streamForRecord(rec)); seenHash.add(rec.infoHash); }
    else if (rec.status === 'downloading') {
      seenHash.add(rec.infoHash);
      streams.push({
        name: 'Offline\nDownloader', title: `Downloading ${pct(rec)}% - play now (saves while you watch)`,
        url: dlUrl({ type, id, ih: rec.infoHash, fi: rec.fileIdx, name: rec.name }),
        behaviorHints: { notWebReady: true, bingeGroup: 'offline-dl-' + rec.infoHash }
      });
    }
  }
  // download options from provider -> url stream that saves to disk AND plays immediately
  const opts = await getTorrentOptions(type, id);
  for (const o of opts.slice(0, 15)) {
    if (seenHash.has(o.infoHash)) continue;
    streams.push({
      name: 'Offline\nDownloader',
      title: 'Save offline + play: ' + (o.title || o.label),
      url: dlUrl({ type, id, ih: o.infoHash, fi: o.fileIdx, name: o.title || o.label, tr: (o.trackers || []).join(',') }),
      behaviorHints: { notWebReady: true, bingeGroup: 'offline-save-' + o.infoHash }
    });
  }
  return { streams };
}

function dlUrl(o) {
  const q = new URLSearchParams({ type: o.type, id: o.id, ih: o.ih, name: o.name || o.id });
  if (typeof o.fi === 'number') q.set('fi', String(o.fi));
  if (o.tr) q.set('tr', o.tr);
  return `http://${STREAM_HOST}:${ADDON_PORT}/dl?${q.toString()}`;
}

function pct(rec) {
  if (!rec.sizeBytes) return '0';
  return Math.min(100, Math.floor((rec.bytesDownloaded || 0) / rec.sizeBytes * 100));
}

async function handleCatalog(type) {
  const wantSeries = type === 'series';
  const metas = [];
  for (const rec of Object.values(DB.downloads)) {
    const isSeries = rec.type === 'series';
    if (isSeries !== wantSeries) continue;
    const status = rec.status === 'completed' ? '✅' : rec.status === 'downloading' ? `⏳ ${pct(rec)}%` : rec.status === 'error' ? '⚠' : '…';
    metas.push({
      id: 'offline:' + rec.dlId,
      type: rec.type,
      name: `${status} ${rec.name}`,
      poster: rec.poster || `https://icongr.am/material/movie.svg?size=300&color=6c5ce7`,
      posterShape: 'poster',
      description: rec.status === 'completed'
        ? `Downloaded • ${fmtBytes(rec.sizeBytes)} • plays offline with all tracks`
        : rec.status === 'downloading' ? `Downloading ${pct(rec)}% • ${fmtBytes(rec.bytesDownloaded)} / ${fmtBytes(rec.sizeBytes)}`
        : rec.error || rec.status
    });
  }
  return { metas };
}

async function handleMeta(type, id) {
  if (!id.startsWith('offline:')) return { meta: null };
  const dlId = id.slice('offline:'.length);
  const rec = DB.downloads[dlId];
  if (!rec) return { meta: null };
  const meta = {
    id, type: rec.type, name: rec.name,
    poster: rec.poster || `https://icongr.am/material/movie.svg?size=300&color=6c5ce7`,
    background: rec.background || rec.poster,
    description: rec.status === 'completed'
      ? `Offline copy • ${fmtBytes(rec.sizeBytes)} • ${rec.fileName}`
      : `Status: ${rec.status} ${rec.status === 'downloading' ? pct(rec) + '%' : ''} ${rec.error || ''}`,
  };
  if (rec.type === 'movie') {
    meta.videos = [{ id, title: rec.name, released: new Date(rec.createdAt || Date.now()).toISOString() }];
  }
  return { meta };
}

async function handleSubtitles(type, id) {
  const subs = [];
  for (const rec of recordsFor(id)) {
    if (rec.status === 'completed' && rec.subtitles) {
      rec.subtitles.forEach((s, i) => subs.push({
        id: 'offline-sub-' + rec.dlId + '-' + i,
        url: `http://${STREAM_HOST}:${ADDON_PORT}/sub/${rec.dlId}/${i}`,
        lang: s.lang || 'und'
      }));
    }
  }
  // also match offline: meta id
  if (id.startsWith('offline:')) {
    const rec = DB.downloads[id.slice('offline:'.length)];
    if (rec && rec.subtitles) rec.subtitles.forEach((s, i) => subs.push({
      id: 'offline-sub-' + rec.dlId + '-' + i, url: `http://${STREAM_HOST}:${ADDON_PORT}/sub/${rec.dlId}/${i}`, lang: s.lang || 'und'
    }));
  }
  return { subtitles: subs };
}

// ---------------------------------------------------------------------------
// Trigger a download (called from Stremio stream click via externalUrl)
// ---------------------------------------------------------------------------
async function triggerDownload(q) {
  const type = q.get('type'), id = q.get('id'), ih = (q.get('ih') || '').toLowerCase();
  if (!ih || !id) return { ok: false, error: 'missing infoHash/id' };
  // dedupe: same streamId + infoHash already present
  const existing = Object.values(DB.downloads).find(r => r.streamId === id && r.infoHash === ih);
  if (existing) return { ok: true, dlId: existing.dlId, dup: true };
  const fi = q.get('fi'); const tr = q.get('tr');
  const dlId = rid();
  const namePart = q.get('name') || id;
  const rec = {
    dlId, streamId: id, type: type || (id.includes(':') ? 'series' : 'movie'),
    name: humanName(id, namePart), folder: humanName(id, namePart),
    infoHash: ih, fileIdx: fi !== null && fi !== '' ? parseInt(fi, 10) : undefined,
    trackers: tr ? tr.split(',').filter(Boolean) : null,
    sizeBytes: 0, bytesDownloaded: 0, status: 'queued', speed: 0,
    createdAt: Date.now()
  };
  // try to enrich poster/name from cinemeta
  enrichMeta(rec).catch(() => {});
  DB.downloads[dlId] = rec;
  saveDB();
  startDownload(rec);
  return { ok: true, dlId };
}

function humanName(id, fallback) {
  const m = id.match(/^(tt\d+)(?::(\d+):(\d+))?$/);
  if (m && m[2]) return `${fallback || m[1]} S${m[2]}E${m[3]}`;
  return fallback || id;
}

async function enrichMeta(rec) {
  const base = (rec.streamId.match(/^(tt\d+)/) || [])[1];
  if (!base) return;
  const t = rec.type === 'series' ? 'series' : 'movie';
  try {
    const j = await httpsGetJSON(`https://v3-cinemeta.strem.io/meta/${t}/${base}.json`);
    if (j && j.meta) {
      rec.poster = j.meta.poster; rec.background = j.meta.background;
      const sm = rec.streamId.match(/^tt\d+:(\d+):(\d+)$/);
      rec.name = sm ? `${j.meta.name} S${sm[1]}E${sm[2]}` : (j.meta.name || rec.name);
      rec.folder = j.meta.name || rec.folder;
      saveDB();
    }
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// File serving with HTTP range support
// ---------------------------------------------------------------------------
const MIME = { '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.m4v': 'video/x-m4v', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.ts': 'video/mp2t', '.srt': 'application/x-subrip', '.vtt': 'text/vtt' };
function serveFile(req, res, filePath) {
  let st;
  try { st = fs.statSync(filePath); } catch (_) { res.writeHead(404); return res.end('not found'); }
  const total = st.size;
  const ext = path.extname(filePath).toLowerCase();
  const ctype = MIME[ext] || 'application/octet-stream';
  const range = req.headers.range;
  const baseHeaders = { 'Content-Type': ctype, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : total - 1;
    if (isNaN(start)) start = 0;
    if (isNaN(end) || end >= total) end = total - 1;
    if (start > end || start >= total) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); return res.end(); }
    res.writeHead(206, Object.assign({}, baseHeaders, { 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 }));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, Object.assign({}, baseHeaders, { 'Content-Length': total }));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  }
}

// Proxy a byte-range stream from the Stremio torrent engine to the player.
function proxyEngineStream(req, res, infoHash, fileIdx) {
  const headers = {};
  if (req.headers.range) headers.range = req.headers.range;
  const preq = http.request({ host: STREMIO_SERVER.host, port: STREMIO_SERVER.port, path: `/${infoHash}/${fileIdx}`, method: req.method || 'GET', headers }, (pres) => {
    const h = Object.assign({}, pres.headers, { 'Access-Control-Allow-Origin': '*' });
    res.writeHead(pres.statusCode, h);
    pres.pipe(res);
  });
  preq.on('error', (e) => { if (!res.headersSent) res.writeHead(502); res.end('engine proxy error: ' + e.message); });
  req.on('close', () => { try { preq.destroy(); } catch (_) {} });
  preq.end();
}

// ---------------------------------------------------------------------------
// JSON / CORS helpers
// ---------------------------------------------------------------------------
function sendJSON(res, obj, status) {
  const body = JSON.stringify(obj);
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-cache'
  });
  res.end(body);
}
function sendHTML(res, html, status) {
  res.writeHead(status || 200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
  res.end(html);
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const parsed = url.parse(req.url, true);
    let p = decodeURIComponent(parsed.pathname);
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); return res.end(); }

    // ---- Addon protocol ----
    if (/^\/(stream|catalog|meta|subtitles)\//.test(p)) log('REQ', req.method, p);
    if (p === '/manifest.json') return sendJSON(res, MANIFEST);

    let m;
    if ((m = p.match(/^\/catalog\/([^/]+)\/([^/]+?)(?:\/.*)?\.json$/))) {
      return sendJSON(res, await handleCatalog(m[1]));
    }
    if ((m = p.match(/^\/meta\/([^/]+)\/(.+)\.json$/))) {
      return sendJSON(res, await handleMeta(m[1], m[2]));
    }
    if ((m = p.match(/^\/stream\/([^/]+)\/(.+)\.json$/))) {
      // offline: ids map back to their streamId
      let id = m[2];
      if (id.startsWith('offline:')) {
        const rec = DB.downloads[id.slice('offline:'.length)];
        if (rec) { const out = rec.status === 'completed' ? { streams: [streamForRecord(rec)] } : await handleStream(rec.type, rec.streamId); return sendJSON(res, out); }
      }
      return sendJSON(res, await handleStream(m[1], id));
    }
    if ((m = p.match(/^\/subtitles\/([^/]+)\/(.+)\.json$/))) {
      return sendJSON(res, await handleSubtitles(m[1], m[2]));
    }

    // ---- Playback / files ----
    if ((m = p.match(/^\/play\/([^/]+)$/))) {
      const rec = DB.downloads[m[1]];
      if (!rec || !rec.filePath) { res.writeHead(404); return res.end('not found'); }
      return serveFile(req, res, rec.filePath);
    }
    if ((m = p.match(/^\/sub\/([^/]+)\/(\d+)$/))) {
      const rec = DB.downloads[m[1]];
      const s = rec && rec.subtitles && rec.subtitles[parseInt(m[2], 10)];
      if (!s) { res.writeHead(404); return res.end('not found'); }
      return serveFile(req, res, s.path);
    }

    // ---- Trigger download (legacy: opens dashboard via browser) ----
    if (p === '/trigger') {
      const out = await triggerDownload(new URLSearchParams(parsed.query));
      return sendHTML(res, triggerPage(out));
    }

    // ---- Download & Play: save to disk for offline AND stream immediately ----
    if (p === '/dl') {
      const q = new URLSearchParams(parsed.query);
      const ih = (q.get('ih') || '').toLowerCase();
      if (!ih) { res.writeHead(400); return res.end('missing ih'); }
      // If we already have a completed copy, serve the local file (instant, buffer-free).
      const done = Object.values(DB.downloads).find(r => r.infoHash === ih && r.status === 'completed' && r.filePath);
      if (done) return serveFile(req, res, done.filePath);
      // Ensure torrent engine is ready and resolve the video file index.
      if (!(await ensureStremioServer())) { res.writeHead(503); return res.end('Stremio server (11470) not running'); }
      let fileIdx = q.get('fi');
      let rec = Object.values(DB.downloads).find(r => r.streamId === q.get('id') && r.infoHash === ih);
      if (!rec) {
        const out = await triggerDownload(q); // creates record + starts background save to disk
        rec = DB.downloads[out.dlId];
      }
      if (fileIdx == null || fileIdx === '') {
        try { const info = await createTorrent(ih, rec && rec.trackers); fileIdx = pickVideoFile(info.files); }
        catch (e) { fileIdx = 0; }
      }
      // Stream the file from the torrent engine to the player now (with range support).
      return proxyEngineStream(req, res, ih, parseInt(fileIdx, 10) || 0);
    }

    // ---- Dashboard API ----
    if (p === '/api/downloads') return sendJSON(res, { downloads: Object.values(DB.downloads).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) });
    if (p === '/api/storage') {
      const ds = await diskSpace(DOWNLOADS_DIR);
      return sendJSON(res, { free: ds.free, total: ds.total, used: ds.total - ds.free, usedByDownloads: usedByDownloads(), root: ds.root, dir: DOWNLOADS_DIR });
    }
    if (p === '/api/pickfolder') {
      const dir = await pickFolderNative(DOWNLOADS_DIR);
      return sendJSON(res, { dir });
    }
    if (p === '/api/setdir' && req.method === 'POST') {
      const body = await readBody(req);
      const dir = (body.dir || '').trim();
      if (!dir) return sendJSON(res, { ok: false, error: 'No folder given.' });
      if (path.resolve(dir) === path.resolve(DOWNLOADS_DIR)) return sendJSON(res, { ok: true, dir: DOWNLOADS_DIR, moved: 0 });
      if (Object.values(DB.downloads).some(r => r.status === 'downloading' || r.status === 'queued'))
        return sendJSON(res, { ok: false, error: 'Wait for active downloads to finish before changing the folder.' });
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return sendJSON(res, { ok: false, error: 'Cannot create folder: ' + e.message }); }
      const old = DOWNLOADS_DIR;
      let moved = 0;
      try {
        for (const rec of Object.values(DB.downloads)) {
          if (!rec.filePath || !fs.existsSync(rec.filePath)) continue;
          const rel = path.relative(old, rec.filePath);
          const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
          const newPath = inside ? path.join(dir, rel) : path.join(dir, sanitize(rec.folder || rec.name), path.basename(rec.filePath));
          moveFileSafe(rec.filePath, newPath);
          rec.filePath = newPath;
          moved++;
          if (rec.subtitles) rec.subtitles.forEach(s => {
            if (s.path && fs.existsSync(s.path)) {
              const np = path.join(path.dirname(newPath), path.basename(s.path));
              try { moveFileSafe(s.path, np); s.path = np; } catch (_) {}
            }
          });
        }
      } catch (e) { return sendJSON(res, { ok: false, error: 'Move failed: ' + e.message }); }
      DOWNLOADS_DIR = dir;
      DB.settings.downloadsDir = dir;
      saveDBNow();
      try { for (const d of fs.readdirSync(old)) { const p2 = path.join(old, d); if (fs.statSync(p2).isDirectory() && fs.readdirSync(p2).length === 0) fs.rmdirSync(p2); } } catch (_) {}
      return sendJSON(res, { ok: true, dir, moved });
    }
    if (p === '/api/diskcheck') {
      const size = parseInt(parsed.query.size || '0', 10);
      return sendJSON(res, await checkSpace(size));
    }
    if (p === '/api/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await deleteDownload(body.dlId);
      return sendJSON(res, out);
    }
    if (p === '/api/add' && req.method === 'POST') {
      const body = await readBody(req);
      const q = new URLSearchParams();
      q.set('type', body.type || (String(body.id).includes(':') ? 'series' : 'movie'));
      q.set('id', body.id || ('manual-' + rid()));
      q.set('ih', extractInfoHash(body.magnet || body.infoHash || ''));
      if (body.name) q.set('name', body.name);
      const tr = extractTrackers(body.magnet || '');
      if (tr.length) q.set('tr', tr.join(','));
      if (body.fileIdx != null && body.fileIdx !== '') q.set('fi', String(body.fileIdx));
      const out = await triggerDownload(q);
      return sendJSON(res, out);
    }
    if (p === '/api/search') {
      const q = (parsed.query.q || '').trim();
      const type = parsed.query.type === 'series' ? 'series' : 'movie';
      const sort = parsed.query.sort === 'new' ? 'new' : 'popular';
      const newMode = !q && sort === 'new';
      try {
        const genre = (parsed.query.genre || '').trim();
        const skip = parseInt(parsed.query.skip || '0', 10) || 0;
        const year = parseInt(parsed.query.year || '0', 10) || new Date().getFullYear();
        // Cinemeta's "New" catalog (id "year") takes a year as its genre value, so
        // walking years downward yields newest-release-first; "top" stays popular.
        const catalogId = newMode ? 'year' : 'top';
        const extras = [];
        if (q) extras.push('search=' + encodeURIComponent(q));
        else if (newMode) extras.push('genre=' + year);
        else if (genre) extras.push('genre=' + encodeURIComponent(genre));
        if (skip) extras.push('skip=' + skip);
        const extra = extras.length ? '/' + extras.join('&') : '';
        const url = `https://v3-cinemeta.strem.io/catalog/${type}/${catalogId}${extra}.json`;
        const j = await httpsGetJSON(url, 8000);
        const results = (j.metas || []).slice(0, 100).map(m => ({ id: m.id, type, name: m.name, poster: m.poster, year: m.releaseInfo || m.year || '' }));
        return sendJSON(res, { results, popular: !q && !newMode, newest: newMode, year: newMode ? year : undefined });
      } catch (e) { return sendJSON(res, { results: [], error: e.message }); }
    }
    if (p === '/api/meta') {
      const type = parsed.query.type === 'series' ? 'series' : 'movie';
      const id = parsed.query.id;
      if (!id) return sendJSON(res, { videos: [] });
      try {
        const j = await httpsGetJSON(`https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(id)}.json`, 8000);
        const m = j.meta || {};
        const videos = (m.videos || []).map(v => ({ season: v.season, episode: v.episode, name: v.name || v.title || ('Episode ' + v.episode), released: v.released }));
        return sendJSON(res, { name: m.name, poster: m.poster, videos });
      } catch (e) { return sendJSON(res, { videos: [], error: e.message }); }
    }
    if (p === '/api/subs') {
      const type = parsed.query.type === 'series' ? 'series' : 'movie';
      const id = parsed.query.id;
      if (!id) return sendJSON(res, { count: 0 });
      try {
        const j = await httpsGetJSON(`https://opensubtitles-v3.strem.io/subtitles/${type}/${encodeURIComponent(id)}.json`, 8000);
        const subs = j.subtitles || [];
        const langs = [...new Set(subs.map(s => s.lang))].length;
        return sendJSON(res, { count: subs.length, langs });
      } catch (e) { return sendJSON(res, { count: 0, error: e.message }); }
    }
    if (p === '/api/subcount') {
      const ih = (parsed.query.ih || '').toLowerCase();
      if (!ih) return sendJSON(res, { ok: false, error: 'no infohash' });
      const tr = parsed.query.tr ? String(parsed.query.tr).split(',').filter(Boolean) : null;
      try {
        if (!(await ensureStremioServer())) return sendJSON(res, { ok: false, error: 'Stremio server not running' });
        const info = await Promise.race([
          createTorrent(ih, tr),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000))
        ]);
        const files = info.files || [];
        const subs = files.filter(f => SUB_RE.test(f.name)).length;
        return sendJSON(res, { ok: true, subs });
      } catch (e) { return sendJSON(res, { ok: false, error: e.message }); }
    }
    if (p === '/api/sources') {
      const type = parsed.query.type === 'series' ? 'series' : 'movie';
      const id = parsed.query.id;
      if (!id) return sendJSON(res, { sources: [] });
      const opts = await getTorrentOptions(type, id);
      return sendJSON(res, { sources: opts.map(o => ({ infoHash: o.infoHash, fileIdx: o.fileIdx, title: o.title || o.label, trackers: o.trackers || [] })) });
    }
    if (p === '/api/start' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.infoHash || !body.id) return sendJSON(res, { ok: false, error: 'missing infoHash/id' });
      const sp = body.size ? await checkSpace(body.size) : { enough: true };
      if (!sp.enough) return sendJSON(res, { ok: false, error: sp.message });
      const q = new URLSearchParams({ type: body.type || (String(body.id).includes(':') ? 'series' : 'movie'), id: body.id, ih: String(body.infoHash).toLowerCase(), name: body.name || body.id });
      if (body.fileIdx != null && body.fileIdx !== '') q.set('fi', String(body.fileIdx));
      if (body.trackers && body.trackers.length) q.set('tr', body.trackers.join(','));
      const out = await triggerDownload(q);
      if (out.dlId && body.poster) { const r = DB.downloads[out.dlId]; if (r && !r.poster) { r.poster = body.poster; saveDB(); } }
      return sendJSON(res, out);
    }
    if (p === '/api/play' && req.method === 'POST') {
      const body = await readBody(req);
      const rec = DB.downloads[body.dlId];
      if (!rec || rec.status !== 'completed' || !rec.filePath || !fs.existsSync(rec.filePath)) return sendJSON(res, { ok: false, error: 'file not ready' });
      if (PLAYER) {
        execFile(PLAYER, [rec.filePath], {}, (e) => { if (e) log('player launch error', e.message); });
      } else {
        const safe = rec.filePath.replace(/"/g, '');
        exec(`start "" "${safe}"`, { windowsHide: true }, (e) => { if (e) log('play launch error', e.message); });
      }
      return sendJSON(res, { ok: true, player: PLAYER ? 'vlc' : 'default' });
    }
    if (p === '/api/retry' && req.method === 'POST') {
      const body = await readBody(req);
      const rec = DB.downloads[body.dlId];
      if (rec) { startDownload(rec); return sendJSON(res, { ok: true }); }
      return sendJSON(res, { ok: false });
    }

    // ---- Stremio "Configure" button lands here -> bounce straight to the dashboard ----
    if (p === '/configure' || p === '/configure/') {
      res.writeHead(302, { Location: '/', 'Access-Control-Allow-Origin': '*' });
      return res.end();
    }
    // ---- Dashboard ----
    if (p === '/' || p === '/index.html') return sendHTML(res, DASHBOARD_HTML);
    if (p === '/health') return sendJSON(res, { ok: true, downloads: Object.keys(DB.downloads).length });

    res.writeHead(404); res.end('not found');
  } catch (e) {
    log('request error', e.stack || e.message);
    try { sendJSON(res, { error: e.message }, 500); } catch (_) {}
  }
});

function readBody(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', c => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (_) { resolve({}); } });
  });
}
function extractInfoHash(s) {
  s = String(s).trim();
  let m = s.match(/xt=urn:btih:([a-zA-Z0-9]+)/);
  if (m) return m[1].toLowerCase();
  if (/^[a-fA-F0-9]{40}$/.test(s) || /^[a-zA-Z2-7]{32}$/.test(s)) return s.toLowerCase();
  return '';
}
function extractTrackers(magnet) {
  const out = []; const re = /tr=([^&]+)/g; let m;
  while ((m = re.exec(magnet))) out.push(decodeURIComponent(m[1]));
  return out;
}

function triggerPage(out) {
  const dash = `http://127.0.0.1:${ADDON_PORT}/`;
  if (out.ok) {
    return `<!doctype html><html><head><meta charset=utf-8><title>Download started</title>
<meta http-equiv="refresh" content="2;url=${dash}${out.dlId ? '?focus=' + out.dlId : ''}">
<style>body{background:#14101f;color:#eee;font-family:Segoe UI,Arial;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.c{text-align:center}</style></head>
<body><div class=c><h1>📥 ${out.dup ? 'Already in your downloads' : 'Download started'}</h1>
<p>Opening the Downloads Manager…</p><p><a style="color:#a29bfe" href="${dash}">Open now</a></p></div></body></html>`;
  }
  return `<!doctype html><html><head><meta charset=utf-8><style>body{background:#14101f;color:#eee;font-family:Segoe UI,Arial;text-align:center;padding-top:80px}</style></head>
<body><h1>⚠ Could not start</h1><p>${out.error || 'unknown error'}</p><p><a style="color:#a29bfe" href="${dash}">Open Downloads Manager</a></p></body></html>`;
}

// ---------------------------------------------------------------------------
// Dashboard HTML (inlined)
// ---------------------------------------------------------------------------
const DASHBOARD_HTML = require('fs').existsSync(path.join(ROOT, 'dashboard.html'))
  ? fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8')
  : '<h1>dashboard.html missing</h1>';

// ---------------------------------------------------------------------------
server.listen(ADDON_PORT, '0.0.0.0', () => {
  log(`Offline Downloader addon on http://127.0.0.1:${ADDON_PORT}`);
  log(`Manifest:  http://127.0.0.1:${ADDON_PORT}/manifest.json`);
  log(`Install:   stremio://127.0.0.1:${ADDON_PORT}/manifest.json`);
  log(`Dashboard: http://127.0.0.1:${ADDON_PORT}/`);
  log(`Downloads: ${DOWNLOADS_DIR}`);
  resumeInterrupted();
});
