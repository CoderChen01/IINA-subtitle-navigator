let tracks = [];
let trackId = null;

let rows = [];
let filtered = [];
let selected = new Set();
let lastClicked = null;

let currentTime = 0;
let currentIdx = -1;

let liveStart = null;

function fmt(t) {
  const s = Math.max(0, Math.floor(t));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${ss}`;
}

function populateSelect() {
  const sel = document.getElementById("track");
  sel.innerHTML = "";
  tracks.forEach(t => {
    const op = document.createElement("option");
    op.value = String(t.id);
    op.textContent = [t.id, t.lang, t.title].filter(Boolean).join(" ").trim();
    sel.appendChild(op);
  });
  if (trackId != null) sel.value = String(trackId);
}

function applyFilter() {
  const q = document.getElementById("q").value.trim().toLowerCase();
  selected.clear();
  lastClicked = null;
  filtered = q ? rows.filter(r => (r.text || "").toLowerCase().includes(q)) : rows.slice();
  render();
}

function findCurrentIndex() {
  let lo = 0, hi = filtered.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = filtered[mid];
    if (currentTime < r.start) hi = mid - 1;
    else if (currentTime > r.end) { best = mid; lo = mid + 1; }
    else return mid;
  }
  return best;
}

function render() {
  const list = document.getElementById("list");
  list.innerHTML = "";
  currentIdx = findCurrentIndex();

  filtered.forEach((r, i) => {
    const item = document.createElement("div");
    const isSel = selected.has(i);
    const isCur = (i === currentIdx);

    item.className = "item" + (isSel ? " selected" : "") + (isCur ? " current" : "");
    item.dataset.index = String(i);
    item.innerHTML = `
      <div class="time">${fmt(r.start)}</div>
      <div class="line"></div>
    `;
    item.querySelector(".line").innerText = r.text || "";

    item.addEventListener("click", (e) => {
      const idx = i;
      const isRange = e.shiftKey && lastClicked != null;
      const isToggle = e.metaKey || e.ctrlKey;

      if (isRange) {
        const a = Math.min(lastClicked, idx);
        const b = Math.max(lastClicked, idx);
        selected.clear();
        for (let k = a; k <= b; k++) selected.add(k);
      } else if (isToggle) {
        if (selected.has(idx)) selected.delete(idx); else selected.add(idx);
        lastClicked = idx;
      } else {
        selected.clear();
        selected.add(idx);
        lastClicked = idx;
        iina.postMessage("seekTo", { time: r.start });
      }

      const loopOn = document.getElementById("loopToggle").checked;
      if (loopOn) iina.postMessage("loopLine", { enabled: true, start: r.start, end: r.end });
      render();
    });

    list.appendChild(item);
  });
}

async function copyText(text) {
  if (!text) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch (_) { }
  iina.postMessage("copyFallback", { text });
}

function selectedRows() {
  const out = [];
  for (const idx of selected) {
    const r = filtered[idx];
    if (r) out.push(r);
  }
  return out.sort((a, b) => a.start - b.start);
}

function scrollToIndex(idx) {
  const el = document.querySelector(`.item[data-index="${idx}"]`);
  if (el) el.scrollIntoView({ block: "center", behavior: "smooth" }); // 增加了 smooth 滚动效果
}

/** Toolbar actions */
document.getElementById("q").addEventListener("input", applyFilter);
document.getElementById("reload").addEventListener("click", () => iina.postMessage("reload", {}));

document.getElementById("track").addEventListener("change", () => {
  trackId = Number(document.getElementById("track").value);
  iina.postMessage("setSelection", { trackId });
});

document.getElementById("clearSel").addEventListener("click", () => {
  selected.clear();
  lastClicked = null;
  render();
});

document.getElementById("copySel").addEventListener("click", async () => {
  const parts = selectedRows().map(r => r.text || "").filter(Boolean);
  await copyText(parts.join("\n\n"));
});

document.getElementById("loopToggle").addEventListener("change", () => {
  const on = document.getElementById("loopToggle").checked;
  if (!on) iina.postMessage("loopLine", { enabled: false });
  else if (currentIdx >= 0) {
    const r = filtered[currentIdx];
    if (r) iina.postMessage("loopLine", { enabled: true, start: r.start, end: r.end });
  }
});

document.getElementById("autoScrollToggle").addEventListener("change", () => {
  const on = document.getElementById("autoScrollToggle").checked;
  if (on && currentIdx >= 0) {
    scrollToIndex(currentIdx);
  }
});

document.getElementById("jumpCurrent").addEventListener("click", () => iina.postMessage("seekCurrentLine", {}));
document.getElementById("scrollCurrent").addEventListener("click", () => iina.postMessage("scrollToCurrent", {}));

document.getElementById("jumpTime").addEventListener("click", () => {
  const hh = Number(document.getElementById("hh")?.value || "0");
  const mm = Number(document.getElementById("mm")?.value || "0");
  const ss = Number(document.getElementById("ss")?.value || "0");
  if (![hh, mm, ss].every(n => Number.isFinite(n) && n >= 0)) return;
  const t = Math.max(0, hh * 3600 + (mm % 60) * 60 + (ss % 60));
  iina.postMessage("seekNearest", { time: t });
});

document.getElementById("live").addEventListener("click", () => {
  if (typeof liveStart === "number") iina.postMessage("seekTo", { time: liveStart });
});

/** Messages */
iina.onMessage("setTracks", (data) => {
  tracks = Array.isArray(data?.tracks) ? data.tracks : [];
  trackId = data?.trackId ?? null;
  populateSelect();
});

iina.onMessage("setRows", ({ rows: r, meta }) => {
  rows = Array.isArray(r) ? r : [];
  filtered = rows.slice();
  selected.clear();
  lastClicked = null;

  const el = document.getElementById("meta");
  if (meta?.error) el.innerText = `Error: ${meta.error}`;
  else el.innerText = `Rows: ${meta?.count ?? rows.length}`;

  render();
});

iina.onMessage("time", ({ t }) => {
  if (typeof t === "number" && isFinite(t)) {
    currentTime = t;
    const idx = findCurrentIndex();

    // 修改：检测到行变化时，检查是否开启了自动滚动
    if (idx !== currentIdx) {
      render();
      const autoScroll = document.getElementById("autoScrollToggle")?.checked;
      if (autoScroll && idx !== -1) {
        scrollToIndex(idx);
      }
    }
  }
});

iina.onMessage("scrollToIndex", ({ idx }) => {
  if (typeof idx === "number") scrollToIndex(idx);
});

iina.onMessage("liveSubtitle", (data) => {
  document.getElementById("liveText").innerText = data?.text || "";
  liveStart = (typeof data?.start === "number") ? data.start : null;
});

iina.postMessage("uiReady", {});

window.addEventListener('beforeunload', () => {
  try { iina.postMessage('windowClosed', {}); } catch (_) { }
});