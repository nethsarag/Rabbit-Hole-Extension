function updateBadge() {
  chrome.storage.sync.get({ enabled: true }, ({ enabled }) => {
    chrome.action.setBadgeText({ text: enabled ? "" : "OFF" });
    chrome.action.setBadgeBackgroundColor({ color: "#777777" });
  });
}
chrome.runtime.onInstalled.addListener(updateBadge);
chrome.runtime.onStartup.addListener(updateBadge);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.enabled) updateBadge();
});
