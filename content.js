let settings = { ...SCI_DEFAULTS };
let queue = [];
let busy = false;
let currentVideos = null;
let loadingSection = false;
const HOST_ID = "sci-feed-section";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function load(cb) {
  chrome.storage.sync.get(SCI_DEFAULTS, (s) => { settings = { ...SCI_DEFAULTS, ...s }; cb && cb(); });
}
const onHome = () => location.pathname === "/";
const matches = (t) => settings.keywords.some((k) => k && t.toLowerCase().includes(k.toLowerCase()));
const isBlocked = (t) => settings.blockedChannels.some((c) => c && t.toLowerCase().includes(c.toLowerCase()));

/* ---------- Part 1: filter the existing feed ---------- */
function apply(el) {
  const text = el.innerText || "";
  if (!text.trim()) return;
  const ok = !isBlocked(text) && matches(text);
  el.dataset.sciChecked = ok ? "ok" : "no";
  el.style.display = ""; el.style.opacity = "";
  if (!ok) {
    if (settings.mode === "hide") el.style.display = "none"; else el.style.opacity = "0.25";
    if (settings.autoNotInterested && !el.dataset.sciDismissed) {
      el.dataset.sciDismissed = "1"; queue.push(el); runQueue();
    }
  }
}
function resetAll() {
  document.querySelectorAll("ytd-rich-item-renderer, ytd-rich-section-renderer").forEach((el) => {
    el.style.display = ""; el.style.opacity = ""; delete el.dataset.sciChecked;
  });
}
async function runQueue() {
  if (busy) return;
  busy = true;
  while (queue.length && settings.enabled) {
    const el = queue.shift();
    try {
      const btn = el.querySelector('button[aria-label="More actions"], ytd-menu-renderer button, button[aria-label*="ore actions"]');
      if (!btn) continue;
      el.style.display = "";
      btn.click();
      await sleep(400);
      const items = [...document.querySelectorAll("ytd-menu-service-item-renderer, yt-list-item-view-model, tp-yt-paper-item")];
      const target = items.find((i) => /not interested/i.test(i.innerText || ""));
      if (target) target.click(); else document.body.click();
      await sleep(300);
      if (settings.mode === "hide") el.style.display = "none";
    } catch (e) {}
    await sleep(4000);
  }
  busy = false;
}

/* ---------- Part 2: fetch fresh science videos ---------- */
const VID = /^[\w-]{11}$/;

function parseAgo(txt) {
  const m = /(\d+)\s+(second|minute|hour|day|week|month|year)/i.exec(txt || "");
  if (!m) return Date.now();
  const unit = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 }[m[2].toLowerCase()];
  return Date.now() - Number(m[1]) * unit;
}

async function resolveChannelId(handle) {
  const { channelIds = {} } = await chrome.storage.local.get("channelIds");
  if (channelIds[handle]) return channelIds[handle];
  const r = await fetch("https://www.youtube.com/@" + encodeURIComponent(handle), { credentials: "include" });
  const t = await r.text();
  const m = /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/.exec(t)
         || /"externalId":"(UC[\w-]{22})"/.exec(t)
         || /"channelId":"(UC[\w-]{22})"/.exec(t);
  if (!m) throw new Error("no channel id for " + handle);
  channelIds[handle] = m[1];
  await chrome.storage.local.set({ channelIds });
  return m[1];
}

async function channelVideos(handle) {
  const id = await resolveChannelId(handle);
  const r = await fetch("https://www.youtube.com/feeds/videos.xml?channel_id=" + id);
  const doc = new DOMParser().parseFromString(await r.text(), "text/xml");
  const out = [];
  doc.querySelectorAll("entry").forEach((e, i) => {
    if (i >= 4) return;
    const vid = e.getElementsByTagName("yt:videoId")[0]?.textContent;
    if (!vid || !VID.test(vid)) return;
    out.push({
      id: vid,
      title: e.querySelector("title")?.textContent || "",
      author: e.querySelector("author > name")?.textContent || handle,
      published: Date.parse(e.querySelector("published")?.textContent || "") || Date.now()
    });
  });
  return out;
}

function walk(o, fn) {
  if (!o || typeof o !== "object") return;
  fn(o);
  for (const k in o) walk(o[k], fn);
}

async function searchVideos(q) {
  const r = await fetch("https://www.youtube.com/results?search_query=" + encodeURIComponent(q) + "&sp=CAISAhAB", { credentials: "include" });
  const t = await r.text();
  const i = t.indexOf("var ytInitialData = ");
  if (i < 0) return [];
  const start = t.indexOf("{", i);
  const end = t.indexOf(";</script>", start);
  const data = JSON.parse(t.slice(start, end));
  const out = [];
  walk(data, (o) => {
    const v = o.videoRenderer;
    if (v && VID.test(v.videoId || "") && out.length < 8) {
      out.push({
        id: v.videoId,
        title: v.title?.runs?.map((x) => x.text).join("") || "",
        author: v.ownerText?.runs?.[0]?.text || "",
        published: parseAgo(v.publishedTimeText?.simpleText)
      });
    }
  });
  return out;
}

const sig = () => JSON.stringify([settings.channels, settings.searches, settings.maxCards, settings.blockedChannels]);

async function getVideos() {
  const { feedCache } = await chrome.storage.local.get("feedCache");
  if (feedCache && Date.now() - feedCache.t < 3 * 36e5 && feedCache.sig === sig()) return feedCache.videos;
  const jobs = [
    ...settings.channels.slice(0, 25).map((h) => channelVideos(h)),
    ...settings.searches.slice(0, 8).map((q) => searchVideos(q))
  ];
  const results = (await Promise.allSettled(jobs)).flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const seen = new Set(), perAuthor = {}, videos = [];
  results.sort((a, b) => b.published - a.published);
  for (const v of results) {
    if (seen.has(v.id) || isBlocked(v.title + " " + v.author)) continue;
    perAuthor[v.author] = (perAuthor[v.author] || 0) + 1;
    if (perAuthor[v.author] > 2) continue; // keep it varied
    seen.add(v.id); videos.push(v);
    if (videos.length >= settings.maxCards) break;
  }
  await chrome.storage.local.set({ feedCache: { t: Date.now(), sig: sig(), videos } });
  return videos;
}

/* ---------- Part 3: render the section above the feed ---------- */
function render(videos) {
  const grid = document.querySelector("ytd-rich-grid-renderer");
  if (!grid || !grid.parentElement) return false;
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = HOST_ID;
    grid.parentElement.insertBefore(host, grid);
  }
  host.textContent = "";
  const style = document.createElement("style");
  style.textContent = `
    #${HOST_ID}{padding:16px 24px 8px;font-family:Roboto,Arial,sans-serif;color:var(--yt-spec-text-primary,#0f0f0f)}
    #${HOST_ID} .sci-head{display:flex;align-items:center;gap:10px;font-size:18px;font-weight:600;margin-bottom:12px}
    #${HOST_ID} .sci-head button{background:none;border:1px solid var(--yt-spec-10-percent-layer,#ccc);color:inherit;border-radius:16px;padding:2px 10px;cursor:pointer}
    #${HOST_ID} .sci-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px}
    #${HOST_ID} a{color:inherit;text-decoration:none}
    #${HOST_ID} img{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:12px;background:#222}
    #${HOST_ID} .t{font-size:14px;font-weight:500;margin-top:8px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    #${HOST_ID} .a{font-size:12px;color:var(--yt-spec-text-secondary,#606060);margin-top:2px}`;
  host.appendChild(style);
  const head = document.createElement("div");
  head.className = "sci-head";
  head.append("🔭 Fresh science & space");
  const rb = document.createElement("button");
  rb.textContent = "↻ Refresh";
  rb.onclick = async () => { await chrome.storage.local.remove("feedCache"); currentVideos = null; host.remove(); ensureSection(); };
  head.appendChild(rb);
  host.appendChild(head);
  const g = document.createElement("div");
  g.className = "sci-grid";
  videos.forEach((v) => {
    const a = document.createElement("a");
    a.href = "https://www.youtube.com/watch?v=" + v.id;
    const img = document.createElement("img");
    img.src = "https://i.ytimg.com/vi/" + v.id + "/mqdefault.jpg";
    img.loading = "lazy";
    const t = document.createElement("div"); t.className = "t"; t.textContent = v.title;
    const au = document.createElement("div"); au.className = "a"; au.textContent = v.author;
    a.append(img, t, au);
    g.appendChild(a);
  });
  host.appendChild(g);
  return true;
}

async function ensureSection() {
  const host = document.getElementById(HOST_ID);
  if (!settings.enabled || !onHome() || !settings.injectEnabled) { host && host.remove(); return; }
  if (host || loadingSection) return;
  if (!document.querySelector("ytd-rich-grid-renderer")) return;
  loadingSection = true;
  try {
    if (!currentVideos) currentVideos = await getVideos();
    if (onHome() && currentVideos.length) render(currentVideos);
  } catch (e) { console.warn("Science feed:", e); }
  loadingSection = false;
}

/* ---------- wiring ---------- */
function cleanup() {
  queue.length = 0;
  resetAll();
  document.getElementById(HOST_ID)?.remove();
}

function scan() {
  if (!settings.enabled) { cleanup(); return; }
  ensureSection();
  if (!onHome() || !settings.filterFeed) return;
  document.querySelectorAll("ytd-rich-item-renderer").forEach((el) => { if (!el.dataset.sciChecked) apply(el); });
  if (settings.hideShorts) document.querySelectorAll("ytd-rich-section-renderer").forEach((el) => { el.style.display = "none"; });
}

let timer;
const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(scan, 300); });
load(() => { scan(); observer.observe(document.body, { childList: true, subtree: true }); });
window.addEventListener("yt-navigate-finish", () => setTimeout(scan, 500));
chrome.storage.onChanged.addListener((_c, area) => {
  if (area !== "sync") return;
  load(() => { cleanup(); currentVideos = null; scan(); });
});
