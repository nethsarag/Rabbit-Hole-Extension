const flags = ["infiniteFeed","filterFeed","hideShorts","autoNotInterested","injectEnabled"];
const lists = { keywords:"keywords", blockedChannels:"blocked", channels:"channels", searches:"searches" };
const $ = (id) => document.getElementById(id);
const split = (t) => t.split(",").map((x) => x.trim().replace(/^@/, "")).filter(Boolean);
const splitKeep = (t) => t.split(",").map((x) => x.trim()).filter(Boolean);

function showState(on) {
  $("master").checked = on;
  $("state").textContent = on ? "ON: your topics are running" : "OFF: YouTube looks normal";
  $("state").className = "state " + (on ? "on" : "off");
  $("body").className = on ? "" : "off";
}
$("master").onchange = () => {
  const on = $("master").checked;
  showState(on);
  chrome.storage.sync.set({ enabled: on });
};

chrome.storage.sync.get(SCI_DEFAULTS, (v) => {
  showState(v.enabled);
  flags.forEach((id) => ($(id).checked = v[id]));
  $("mode").value = v.mode;
  $("sort").value = v.sort;
  $("maxCards").value = v.maxCards;
  for (const [key, id] of Object.entries(lists)) $(id).value = v[key].join(", ");
});

$("save").onclick = () => {
  const out = { mode: $("mode").value, sort: $("sort").value, maxCards: Math.max(4, Math.min(40, Number($("maxCards").value) || 12)) };
  flags.forEach((id) => (out[id] = $(id).checked));
  out.keywords = splitKeep($("keywords").value);
  out.blockedChannels = splitKeep($("blocked").value);
  out.channels = split($("channels").value);
  out.searches = splitKeep($("searches").value);
  chrome.storage.sync.set(out, () => { $("msg").textContent = "Saved ✓"; setTimeout(() => ($("msg").textContent = ""), 1500); });
};
$("refresh").onclick = () => {
  chrome.storage.local.remove("feedCache", () => chrome.storage.sync.set({ refreshNonce: Date.now() }));
  $("msg").textContent = "Refreshing…";
};
