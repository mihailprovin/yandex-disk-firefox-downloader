"use strict";
async function openPanel(example) {
  const status = document.getElementById("status");
  const show = document.getElementById("show"), sample = document.getElementById("example");
  show.disabled = sample.disabled = true;
  status.textContent = "Открываю Диск и подключаю панель…";
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    // Let the persistent background finish even if switching tabs closes this popup.
    const result = await browser.runtime.sendMessage({ channel: "yd-clicker", type: "openPanel", example,
      tabId: tab?.id, windowId: tab?.windowId, url: document.getElementById("url").value.trim() });
    if (!result?.ok) throw new Error(result?.error || "Не удалось открыть Диск.");
    window.close();
  } catch (e) { status.textContent = e.message; show.disabled = sample.disabled = false; }
}
document.getElementById("show").onclick = () => openPanel(false);
document.getElementById("example").onclick = () => openPanel(true);
browser.storage.local.get("yd-clicker-panel-error").then(value => {
  if (value["yd-clicker-panel-error"]) document.getElementById("status").textContent = value["yd-clicker-panel-error"];
}).catch(() => {});
browser.storage.local.get("yd-clicker-last-url").then(value => {
  if (value["yd-clicker-last-url"]) document.getElementById("url").value = value["yd-clicker-last-url"];
}).catch(() => {});
