// Background service worker: toolbar button, popup-window fallback, message relay.

chrome.runtime.onInstalled.addListener(async () => {
  const { installId } = await chrome.storage.local.get("installId");
  if (!installId) await chrome.storage.local.set({ installId: crypto.randomUUID() });
});

// Clicking the toolbar icon turns try-on on for this page and opens / closes the widget.
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.sendMessage(tab.id, { type: "TOGGLE" }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  // Some shops block cameras inside the page; open the widget as its own small window instead.
  if (msg?.type === "OPEN_WINDOW") {
    const hash = new URLSearchParams({ id: msg.widgetId, tab: sender.tab?.id ?? "" });
    if (msg.garment) hash.set("garment", JSON.stringify(msg.garment));
    chrome.windows.create({
      url: chrome.runtime.getURL(`widget.html#${hash}`),
      type: "popup",
      width: 520,
      height: 760,
    });
  }
  // Popup window → shop tab (e.g. "Add to cart")
  if (msg?.type === "TO_TAB" && msg.tabId) {
    chrome.tabs.sendMessage(msg.tabId, msg.msg).catch(() => {});
  }
});
