// Tento "popup" sa nikdy nezobrazí — okamžite presmeruje na plnú stránku
// app.html v novom tabe a sám seba zatvorí, aby rozšírenie fungovalo
// ako celá stránka, nie ako trvalé popup okno.
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
