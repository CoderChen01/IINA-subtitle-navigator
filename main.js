const { core, standaloneWindow, event, mpv, file, utils, console: log, menu } = iina;

let uiReady = false;

let allSubTracks = [];
let trackId = null;

let cues = [];
let rows = [];

let lastStateKey = "";
let timeTicker = null;
let loop = { enabled: false, start: 0, end: 0 };

let windowLoaded = false;

function ensureWindowLoaded() {
  if (windowLoaded) return;
  standaloneWindow.setProperty({ title: "Subtitle Navigator", resizable: true });
  standaloneWindow.loadFile("ui/window.html");
  standaloneWindow.setFrame(900, 720);
  windowLoaded = true;
}

function openWindow() {
  ensureWindowLoaded();
  try { standaloneWindow.open(); } catch (e) { log.error(e?.stack || e); }
}

// Plugin menu item: reopen window after user closes it.
try {
  menu.addItem(menu.item("Show Subtitle Navigator", () => openWindow(), { keyBinding: "cmd+shift+s" }));
} catch (e) { /* menu may be unavailable in some contexts */ }

// Open once on plugin load.
openWindow();
function fmtErr(e) {
  try { return (e && (e.stack || e.message)) ? (e.stack || e.message) : String(e); }
  catch { return String(e); }
}

function shQuote(path) {
  return `'${String(path).replace(/'/g, `'\\''`)}'`;
}

function post(name, data) {
  if (uiReady) standaloneWindow.postMessage(name, data);
}

function stripCurly(text) {
  return String(text || "").replace(/\{[^}]*\}/g, "").trim();
}

async function execStdout(cmd, args) {
  const res = await utils.exec(cmd, args);
  if (typeof res === "string") return res;
  if (res && typeof res.stdout === "string") return res.stdout;
  if (res && typeof res.output === "string") return res.output;
  return "";
}

function hasSuffix(path) {
  return typeof path === "string" && /\.[A-Za-z0-9]+$/.test(path);
}

function getTrackListRaw() {
  const tracks = mpv.getNative("track-list") || [];
  return tracks
    .filter(t => t.type === "sub")
    .map(t => ({
      id: t.id,
      title: t.title || "",
      lang: t.lang || "",
      externalFilename: t["external-filename"] || "",
      selected: (t.selected === true || t.selected === "yes")
    }));
}

async function buildTrackListSuffixOnly() {
  const raw = getTrackListRaw();
  const out = [];
  for (const t of raw) {
    const p = t.externalFilename;
    if (p && hasSuffix(p)) out.push({ ...t, path: p });
  }
  return out;
}

async function readSubtitleTextById(id, fallbackPath) {
  // Prefer IINA's pseudo folder reader to avoid utils.exec stdout truncation.
  // @sub/:id points to the subtitle file of the current playing media.
  try {
    const txt = file.read(`@sub/${id}`);
    if (txt && typeof txt === "string") return String(txt).replace(/^\uFEFF/, "");
  } catch (_) {}
  // Fallback: read via shell (may truncate on some builds)
  if (fallbackPath) return await readTextFromPath(fallbackPath);
  throw new Error("Failed to read subtitle");
}

async function readTextFromPath(path) {

  const out = await execStdout("/bin/bash", ["-lc", `cat ${shQuote(path)}`]);
  if (!out) throw new Error(`Failed to read subtitle: ${path}`);
  return String(out).replace(/^\uFEFF/, "");
}

function parseTimeToSeconds(ts) {
  const s = String(ts).trim();
  const m = s.match(/^(\d+):(\d{1,2}):(\d{1,2})([.,](\d{1,3}))?$/);
  if (!m) return NaN;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const se = Number(m[3]);
  const ms = m[5] ? Number(m[5].padEnd(3, "0")) : 0;
  if (![h, mi, se, ms].every(Number.isFinite)) return NaN;
  return h * 3600 + mi * 60 + se + ms / 1000;
}

function parseSRT(content) {
  const lines = String(content).replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0;
  function isIndexLine(x) { return /^\s*\d+\s*$/.test(x); }

  while (i < lines.length) {
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i >= lines.length) break;

    if (isIndexLine(lines[i])) i++;

    while (i < lines.length && lines[i].trim() === "") i++;
    if (i >= lines.length) break;

    const timeLine = lines[i];
    const tm = timeLine.match(/^\s*([0-9]+:\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)\s*-->\s*([0-9]+:\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)/);
    if (!tm) { i++; continue; }

    const start = parseTimeToSeconds(tm[1]);
    const end = parseTimeToSeconds(tm[2]);
    i++;

    const textLines = [];
    while (i < lines.length && lines[i].trim() !== "") {
      textLines.push(lines[i]);
      i++;
    }
    const text = stripCurly(textLines.join("\n"));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && text) {
      out.push({ start, end, text });
    }
  }

  out.sort((a,b)=>a.start-b.start);
  return out;
}

function getSubDelay() {
  try {
    const d = mpv.getNumber("sub-delay");
    return Number.isFinite(d) ? d : 0;
  } catch (_) { return 0; }
}

function closestRowIndexByTime(t) {
  const subDelay = getSubDelay();
  const tAdj = t - subDelay;

  if (!rows.length) return -1;
  let lo = 0, hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].start < tAdj) lo = mid + 1;
    else hi = mid - 1;
  }
  if (lo <= 0) return 0;
  if (lo >= rows.length) return rows.length - 1;
  return (Math.abs(rows[lo].start - tAdj) < Math.abs(rows[lo-1].start - tAdj)) ? lo : (lo-1);
}

async function refresh(force=false) {
  allSubTracks = await buildTrackListSuffixOnly();

  if (trackId === null) {
    const selected = allSubTracks.find(t => t.selected);
    trackId = selected ? selected.id : (allSubTracks[0]?.id ?? null);
  }
  if (trackId !== null && !allSubTracks.find(t => t.id === trackId)) {
    trackId = allSubTracks[0]?.id ?? null;
  }

  post("setTracks", { tracks: allSubTracks, trackId });

  if (!trackId) {
    rows = [];
    post("setRows", { rows: [], meta: { error: "No external subtitle tracks with filename suffix found. Please load external subtitles in IINA." } });
    return;
  }

  const path = allSubTracks.find(t => t.id === trackId)?.path || "";
  const stateKey = `${trackId}|${path}`;
  if (!force && stateKey === lastStateKey && rows.length) {
    post("setRows", { rows, meta: { count: rows.length } });
    return;
  }
  lastStateKey = stateKey;

  try {
    if (!path.toLowerCase().endsWith(".srt")) throw new Error(`Selected subtitle is not .srt: ${path}`);
    const text = await readSubtitleTextById(trackId, path);
    cues = parseSRT(text);
    rows = cues.map(c => ({ start: c.start, end: c.end, text: c.text }));
    post("setRows", { rows, meta: { count: rows.length } });
  } catch (e) {
    rows = [];
    post("setRows", { rows: [], meta: { error: fmtErr(e) } });
  }
}

function startTicker() {
  if (timeTicker) return;
  timeTicker = setInterval(() => {
    try {
      const t = mpv.getNumber("time-pos");
      if (Number.isFinite(t)) {
        post("time", { t });
        if (loop.enabled && t > loop.end + 0.02) core.seekTo(loop.start);
      }
    } catch (_) {}
  }, 250);
}

let lastLiveKey = "";
setInterval(() => {
  try {
    const t = mpv.getNumber("time-pos");
    if (!Number.isFinite(t)) return;
    const idx = closestRowIndexByTime(t);
    if (idx < 0) return;
    const r = rows[idx];
    const key = `${idx}|${r.start}|${r.end}`;
    if (key === lastLiveKey) return;
    lastLiveKey = key;
    post("liveSubtitle", { text: r.text, start: r.start, idx });
  } catch (_) {}
}, 200);

standaloneWindow.onMessage("windowClosed", () => { uiReady = false; windowLoaded = false; });

standaloneWindow.onMessage("uiReady", () => {
  uiReady = true;
  startTicker();
  refresh(true);
});

standaloneWindow.onMessage("setSelection", (data) => {
  const id = Number(data?.trackId);
  if (Number.isFinite(id)) trackId = id;
  lastStateKey = "";
  refresh(true);
});

standaloneWindow.onMessage("seekTo", (data) => {
  const t = Number(data?.time);
  if (Number.isFinite(t)) core.seekTo(t + getSubDelay());
});

standaloneWindow.onMessage("seekNearest", (data) => {
  const t = Number(data?.time);
  if (!Number.isFinite(t)) return;
  const idx = closestRowIndexByTime(t);
  if (idx >= 0) core.seekTo(rows[idx].start + getSubDelay());
});

standaloneWindow.onMessage("seekCurrentLine", () => {
  const t = mpv.getNumber("time-pos");
  if (!Number.isFinite(t)) return;
  const idx = closestRowIndexByTime(t);
  if (idx >= 0) core.seekTo(rows[idx].start + getSubDelay());
});

standaloneWindow.onMessage("scrollToCurrent", () => {
  const t = mpv.getNumber("time-pos");
  if (!Number.isFinite(t)) return;
  const idx = closestRowIndexByTime(t);
  post("scrollToIndex", { idx });
});

standaloneWindow.onMessage("loopLine", (data) => {
  const enabled = Boolean(data?.enabled);
  const start = Number(data?.start);
  const end = Number(data?.end);
  if (enabled && Number.isFinite(start) && Number.isFinite(end) && end > start) {
    const d = getSubDelay();
    loop = { enabled: true, start: start + d, end: end + d };
    core.osd("Loop: ON");
  } else {
    loop = { enabled: false, start: 0, end: 0 };
    core.osd("Loop: OFF");
  }
});

standaloneWindow.onMessage("reload", () => {
  lastStateKey = "";
  refresh(true);
});

standaloneWindow.onMessage("copyFallback", async (data) => {
  const text = String(data?.text ?? "");
  if (!text) return;
  try {
    const tmp = "@tmp/subtitle-navigator-clipboard.txt";
    file.write(tmp, text);
    const real = utils.resolvePath(tmp);
    await utils.exec("/bin/bash", ["-lc", `/usr/bin/pbcopy < "${real.replace(/"/g, '\\"')}"`]);
    core.osd("Copied");
  } catch (e) {
    core.osd("Copy failed");
    log.error(fmtErr(e));
  }
});

event.on("mpv.file-loaded", () => { lastStateKey = ""; refresh(true); });
event.on("mpv.track-list.changed", () => { lastStateKey = ""; refresh(true); });
event.on("mpv.sid.changed", () => { lastStateKey = ""; refresh(true); });
event.on("mpv.sub-file.changed", () => { lastStateKey = ""; refresh(true); });
