const $ = (id) => document.getElementById(id);
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
  $("injectEnabled").checked = v.injectEnabled;
  $("sort").value = v.sort;
  $("searches").value = v.searches.join(", ");
  $("blocked").value = v.blockedChannels.join(", ");
});

$("save").onclick = () => {
  const out = {
    injectEnabled: $("injectEnabled").checked,
    infiniteFeed: true,
    sort: $("sort").value,
    searches: splitKeep($("searches").value),
    blockedChannels: splitKeep($("blocked").value)
  };
  chrome.storage.sync.set(out, () => { $("msg").textContent = "Saved ✓"; setTimeout(() => ($("msg").textContent = ""), 1500); });
};
$("refresh").onclick = () => {
  chrome.storage.local.remove("feedCache", () => chrome.storage.sync.set({ refreshNonce: Date.now() }));
  $("msg").textContent = "Refreshing…";
};
