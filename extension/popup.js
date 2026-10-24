// This "popup" is never shown — it immediately redirects to the full app.html page
// in a new tab and closes itself, so the extension works as a full page rather than
// a persistent popup window.
(async () => {
  const url = chrome.runtime.getURL('app.html');
  const existing = await chrome.tabs.query({ url });
  if (existing.length) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
  window.close();
})();
