let settings = { ...SCI_DEFAULTS };
let queue = [];
let busy = false;
let currentVideos = null;
let loadingSection = false;
let feed = null;   // infinite topic feed state
let api = null;    // { key, version } scraped from a YouTube page
const ui = { g: null, status: null, sentinel: null, io: null };
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
const splitTopics = (t) => t.split(",").map((x) => x.trim()).filter(Boolean);

function showNative(show) {
  const grid = document.querySelector("ytd-rich-grid-renderer");
  if (grid) grid.style.display = show ? "" : "none";
}

function card(v) {
  const a = document.createElement("a");
  a.href = "https://www.youtube.com/watch?v=" + v.id;
  const img = document.createElement("img");
  img.src = "https://i.ytimg.com/vi/" + v.id + "/mqdefault.jpg";
  img.loading = "lazy";
  const t = document.createElement("div"); t.className = "t"; t.textContent = v.title;
  const au = document.createElement("div"); au.className = "a";
  au.textContent = v.author + (v.meta ? " · " + v.meta : "");
  a.append(img, t, au);
  return a;
}

function mountHost() {
  const grid = document.querySelector("ytd-rich-grid-renderer");
  if (!grid || !grid.parentElement) return null;
  ui.io && ui.io.disconnect();
  document.getElementById(HOST_ID)?.remove();
  const host = document.createElement("div");
  host.id = HOST_ID;
  grid.parentElement.insertBefore(host, grid);
  const style = document.createElement("style");
  style.textContent = `
    #${HOST_ID}{padding:16px 24px 8px;font-family:Roboto,Arial,sans-serif;color:var(--yt-spec-text-primary,#0f0f0f)}
    #${HOST_ID} .sci-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-size:18px;font-weight:600;margin-bottom:12px}
    #${HOST_ID} .sci-title{max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #${HOST_ID} .sci-head button{background:none;border:1px solid var(--yt-spec-10-percent-layer,#ccc);color:inherit;border-radius:16px;padding:2px 10px;cursor:pointer;font-size:13px}
    #${HOST_ID} .sci-head input{flex:1;min-width:160px;max-width:360px;background:var(--yt-spec-base-background,#fff);color:inherit;border:1px solid var(--yt-spec-10-percent-layer,#ccc);border-radius:16px;padding:4px 12px;font-size:13px}
    #${HOST_ID} .sci-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px}
    #${HOST_ID} .sci-status{text-align:center;padding:24px 0;font-size:13px;color:var(--yt-spec-text-secondary,#606060)}
    #${HOST_ID} a{color:inherit;text-decoration:none}
    #${HOST_ID} img{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:12px;background:#222}
    #${HOST_ID} .t{font-size:14px;font-weight:500;margin-top:8px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    #${HOST_ID} .a{font-size:12px;color:var(--yt-spec-text-secondary,#606060);margin-top:2px}`;
  host.appendChild(style);

  const head = document.createElement("div");
  head.className = "sci-head";
  const title = document.createElement("span");
  title.className = "sci-title";
  title.textContent = "🐇 " + (settings.searches.join(" · ") || "Rabbit Hole");
  head.appendChild(title);

  // Type any topic here -> becomes the new topic for the whole feed
  const input = document.createElement("input");
  input.placeholder = "Go down a rabbit hole… any topic";
  const go = () => {
    const q = splitTopics(input.value);
    if (q.length) chrome.storage.sync.set({ searches: q });
  };
  input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") go(); });
  input.addEventListener("keyup", (e) => e.stopPropagation());
  input.addEventListener("keypress", (e) => e.stopPropagation());
  const goBtn = document.createElement("button");
  goBtn.textContent = "Go";
  goBtn.onclick = go;
  const rb = document.createElement("button");
  rb.textContent = "↻ Refresh";
  rb.onclick = async () => {
    await chrome.storage.local.remove("feedCache");
    currentVideos = null; feed = null; host.remove(); ensureSection();
  };
  head.append(input, goBtn, rb);
  host.appendChild(head);

  const g = document.createElement("div");
  g.className = "sci-grid";
  host.appendChild(g);
  const status = document.createElement("div");
  status.className = "sci-status";
  host.appendChild(status);
  const sentinel = document.createElement("div");
  sentinel.style.height = "1px";
  host.appendChild(sentinel);
  Object.assign(ui, { g, status, sentinel });
  return host;
}

// classic mode: one fixed batch of videos above YouTube's own feed
function render(videos) {
  const host = mountHost();
  if (!host) return false;
  videos.forEach((v) => ui.g.appendChild(card(v)));
  return true;
}

/* ---------- Part 4: infinite topic feed ---------- */
// Pages through YouTube search results (via continuation tokens) for ANY topic.
const SP = { relevance: "EgIQAQ%3D%3D", date: "CAISAhAB" }; // videos only; relevance / newest

const topicSig = () => JSON.stringify([settings.searches, settings.sort, settings.blockedChannels]);

function newFeed() {
  return {
    sig: topicSig(),
    topics: settings.searches.filter(Boolean).slice(0, 8).map((q) => ({ q, token: null, started: false, done: false, fails: 0 })),
    items: [], seen: new Set(), loading: false, ended: false
  };
}

function parseResults(data) {
  const videos = [];
  let token = null;
  walk(data, (o) => {
    // older layout
    const v = o.videoRenderer;
    if (v && VID.test(v.videoId || "")) {
      videos.push({
        id: v.videoId,
        title: v.title?.runs?.map((x) => x.text).join("") || "",
        author: v.ownerText?.runs?.[0]?.text || "",
        meta: [v.viewCountText?.simpleText, v.publishedTimeText?.simpleText].filter(Boolean).join(" · ")
      });
    }
    // newer layout (lockupViewModel)
    const l = o.lockupViewModel;
    if (l && VID.test(l.contentId || "") && (!l.contentType || /VIDEO/.test(l.contentType)) && !/PLAYLIST|MIX|CHANNEL/.test(l.contentType || "")) {
      const md = l.metadata?.lockupMetadataViewModel;
      const parts = (md?.metadata?.contentMetadataViewModel?.metadataRows || [])
        .flatMap((r) => (r.metadataParts || []).map((p) => p.text?.content).filter(Boolean));
      const title = md?.title?.content || "";
      if (title) {
        videos.push({ id: l.contentId, title, author: parts[0] || "", meta: parts.slice(1).join(" · ") });
      }
    }
    const t = o.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    if (t) token = t;
  });
  return { videos, token };
}

function readApi(html) {
  const key = /"INNERTUBE_API_KEY":"([\w-]+)"/.exec(html)?.[1];
  const version = /"INNERTUBE_CONTEXT_CLIENT_VERSION":"([\d.]+)"/.exec(html)?.[1]
               || /"clientVersion":"([\d.]+)"/.exec(html)?.[1]
               || "2.20250101.00.00";
  return key ? { key, version } : null;
}

// Finds the InnerTube API key/version: first in the page's own scripts, then in a fetched page, then a known public default.
async function getApi() {
  if (api) return api;
  for (const sc of document.scripts) {
    const txt = sc.textContent || "";
    if (txt.includes("INNERTUBE_API_KEY")) { api = readApi(txt); if (api) return api; }
  }
  try {
    const html = await (await fetch("https://www.youtube.com/", { credentials: "include" })).text();
    api = readApi(html);
  } catch (e) {}
  return api || (api = { key: "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8", version: "2.20250101.00.00" });
}

async function fetchTopicPage(t) {
  if (t.started && !t.token) { t.done = true; return []; }
  const a = await getApi();
  const body = { context: { client: { clientName: "WEB", clientVersion: a.version, hl: "en", gl: "US" } } };
  if (!t.started) {
    body.query = t.q;
    body.params = decodeURIComponent(SP[settings.sort] || SP.relevance);
  } else {
    body.continuation = t.token;
  }
  const r = await fetch("https://www.youtube.com/youtubei/v1/search?prettyPrint=false&key=" + a.key, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-YouTube-Client-Name": "1", "X-YouTube-Client-Version": a.version },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error("search API " + r.status);
  const { videos, token } = parseResults(await r.json());
  t.started = true;
  t.token = token;
  if (!token) t.done = true;
  return videos;
}

let lastError = "";
const setStatus = (txt) => { if (ui.status) ui.status.textContent = txt; };

function maybeMore() {
  if (!feed || !ui.sentinel || !ui.sentinel.isConnected) return;
  if (ui.sentinel.getBoundingClientRect().top < window.innerHeight + 1200) loadMore();
}

async function loadMore() {
  const f = feed;
  if (!f || f.loading || f.ended) return;
  f.loading = true;
  setStatus("Loading more…");
  try {
    for (let tries = 0; tries < 3 && !f.ended; tries++) {
      const active = f.topics.filter((t) => !t.done);
      if (!active.length) { f.ended = true; break; }
      const res = await Promise.allSettled(active.map(fetchTopicPage));
      if (f !== feed) return;
      const lists = res.map((r, i) => {
        if (r.status === "fulfilled") return r.value;
        active[i].fails++;
        lastError = String(r.reason && r.reason.message || r.reason);
        console.warn("Rabbit Hole: failed to load", active[i].q, r.reason);
        if (active[i].fails >= 2) active[i].done = true;
        return [];
      });
      // interleave topics so several topics get mixed together
      const fresh = [];
      const max = Math.max(0, ...lists.map((l) => l.length));
      for (let k = 0; k < max; k++) {
        for (const l of lists) {
          const v = l[k];
          if (!v || f.seen.has(v.id) || isBlocked(v.title + " " + v.author)) continue;
          f.seen.add(v.id); fresh.push(v);
        }
      }
      console.log("Rabbit Hole: loaded", fresh.length, "new videos for", active.map((t) => t.q).join(" | "));
      if (fresh.length) {
        f.items.push(...fresh);
        fresh.forEach((v) => ui.g && ui.g.appendChild(card(v)));
        break;
      }
    }
    if (f.topics.every((t) => t.done)) f.ended = true;
  } catch (e) {
    console.warn("Rabbit Hole:", e);
  } finally {
    f.loading = false;
  }
  if (f !== feed) return;
  setStatus(f.ended ? (f.items.length ? "That's everything for these topics." : "No videos found for these topics." + (lastError ? " (" + lastError + " – see console)" : " (see console for details)")) : "");
  if (!f.ended) setTimeout(maybeMore, 400);
}

function ensureInfinite(host) {
  if (!document.querySelector("ytd-rich-grid-renderer")) return;
  showNative(false);
  if (host) return;
  if (!feed) feed = newFeed();
  if (!mountHost()) return;
  feed.items.forEach((v) => ui.g.appendChild(card(v)));
  ui.io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) loadMore(); }, { rootMargin: "1200px 0px" });
  ui.io.observe(ui.sentinel);
  if (!feed.topics.length) { setStatus("Type a topic above to start your rabbit hole."); return; }
  if (feed.ended) { setStatus("That's everything for these topics."); return; }
  maybeMore();
}

async function ensureSection() {
  const host = document.getElementById(HOST_ID);
  if (!settings.enabled || !onHome() || !settings.injectEnabled) { host && host.remove(); showNative(true); return; }
  if (settings.infiniteFeed) { ensureInfinite(host); return; }
  showNative(true);
  if (host || loadingSection) return;
  if (!document.querySelector("ytd-rich-grid-renderer")) return;
  loadingSection = true;
  try {
    if (!currentVideos) currentVideos = await getVideos();
    if (onHome() && currentVideos.length) render(currentVideos);
  } catch (e) { console.warn("Rabbit Hole:", e); }
  loadingSection = false;
}

/* ---------- wiring ---------- */
function cleanup() {
  queue.length = 0;
  resetAll();
  ui.io && ui.io.disconnect();
  document.getElementById(HOST_ID)?.remove();
  showNative(true);
}

function scan() {
  if (!settings.enabled) { cleanup(); return; }
  ensureSection();
  if (!onHome() || !settings.filterFeed || settings.infiniteFeed) return; // infinite mode replaces the native feed
  document.querySelectorAll("ytd-rich-item-renderer").forEach((el) => { if (!el.dataset.sciChecked) apply(el); });
  if (settings.hideShorts) document.querySelectorAll("ytd-rich-section-renderer").forEach((el) => { el.style.display = "none"; });
}

let timer;
const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(scan, 300); });
load(() => { scan(); observer.observe(document.body, { childList: true, subtree: true }); });
window.addEventListener("yt-navigate-finish", () => setTimeout(scan, 500));
chrome.storage.onChanged.addListener((_c, area) => {
  if (area !== "sync") return;
  load(() => { cleanup(); currentVideos = null; feed = null; scan(); });
});
