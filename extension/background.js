/* Persistent Firefox coordinator. Each original URL comes from a website click. */
"use strict";
const C = YDCommon;
let active = null, pending = null;
let expiredClicks = [];
const FILE_IDLE_MS = 3000;
class FileTimeout extends Error {
  constructor(message) { super(message); this.name = "FileTimeout"; }
}
function expireClick(job, item, url = "", origin = "") {
  expiredClicks = expiredClicks.filter(entry => entry.until > Date.now());
  expiredClicks.push({ tabId: job.tabId, share: job.share, name: item.name, url, origin, until: Date.now() + 60000 });
}
function expiredRequest(details) {
  expiredClicks = expiredClicks.filter(entry => entry.until > Date.now());
  return expiredClicks.some(entry => {
    if (entry.url && entry.url === details.url) return details.tabId === entry.tabId || details.tabId < 0;
    if (!C.isAttachment(details.url) || new URL(details.url).searchParams.get("filename") !== entry.name) return false;
    const origins = [details.originUrl, details.documentUrl].filter(Boolean);
    return (details.tabId === entry.tabId || (details.tabId < 0 && origins.some(value => C.publicKey(value) === entry.share)))
      && (!entry.origin || !origins.length || origins.includes(entry.origin));
  });
}
let lastStatus = { running: false, text: "Готово к работе", logs: [], counts: { originals: 0, previews: 0, skipped: 0, errors: 0 } };
const STATUS_KEY = "yd-clicker-status", COMPLETED_KEY = "yd-clicker-completed";
let openingPanel = null;

async function showDiskPanel(message) {
  let tab;
  const saved = await browser.storage.local.get("yd-clicker-last-url");
  const targetUrl = String(message.url || saved["yd-clicker-last-url"] || "").trim();
  if (targetUrl && !C.publicKey(targetUrl)) throw new Error("Введите публичную ссылку Яндекс Диска вида https://disk.yandex.ru/d/КОД.");
  if (message.example && !targetUrl) throw new Error("Введите ссылку на публичную папку Диска в поле расширения.");
  const tabs = await browser.tabs.query({});
  if (message.example) tab = tabs.find(t => C.publicKey(t.url) === C.publicKey(targetUrl));
  else {
    tab = active ? tabs.find(t => t.id === active.tabId) : null;
    tab = tab || tabs.find(t => t.id === message.tabId && C.publicKey(t.url));
    tab = tab || tabs.find(t => t.windowId === message.windowId && C.publicKey(t.url));
    tab = tab || tabs.find(t => C.publicKey(t.url));
  }
  if (!tab) {
    if (!targetUrl) throw new Error("Откройте публичную папку Диска или введите её ссылку в поле расширения.");
    tab = await browser.tabs.create({ url: targetUrl, active: false });
  }
  await browser.browserAction.setBadgeText({ text: "…" }).catch(() => {});
  const started = Date.now();
  while (Date.now() - started < 45000) {
    tab = await browser.tabs.get(tab.id);
    if (tab.status === "complete") break;
    await C.delay(250);
  }
  if (tab.status !== "complete") throw new Error("Страница Диска не загрузилась за 45 секунд. Проверьте Интернет и повторите.");
  if (!C.publicKey(tab.url)) throw new Error("Вкладка Диска открыла другую страницу. Откройте публичную ссылку и повторите.");
  let reply;
  try { reply = await browser.tabs.sendMessage(tab.id, { channel: "yd-clicker", type: "show" }); }
  catch (_) { /* Tab may have been open before the extension was loaded. */ }
  if (!reply?.ok) {
    for (const file of ["common.js", "site.js", "content.js"])
      await browser.tabs.executeScript(tab.id, { file, runAt: "document_idle" });
    reply = await browser.tabs.sendMessage(tab.id, { channel: "yd-clicker", type: "show" });
  }
  if (!reply?.ok) throw new Error("Страница не ответила. Обновите вкладку Диска и повторите.");
  await browser.tabs.update(tab.id, { active: true });
  if (tab.windowId != null) await browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await browser.storage.local.set({ "yd-clicker-panel-error": "" });
  await browser.storage.local.set({ "yd-clicker-last-url": targetUrl || tab.url });
  await browser.browserAction.setBadgeText({ text: "" }).catch(() => {});
  return { ok: true, tabId: tab.id };
}
function openPanel(message) {
  if (openingPanel) return openingPanel;
  openingPanel = showDiskPanel(message).catch(async error => {
    await browser.storage.local.set({ "yd-clicker-panel-error": error.message }).catch(() => {});
    await browser.browserAction.setBadgeText({ text: "!" }).catch(() => {});
    return { ok: false, error: error.message };
  }).finally(() => { openingPanel = null; });
  return openingPanel;
}

function status(job) {
  return { running: !!active, tabId: job?.tabId, text: job?.text || lastStatus.text,
    counts: job?.counts || lastStatus.counts, logs: (job?.logs || lastStatus.logs).slice(-150), rootUrl: job?.rootUrl };
}
function log(job, text) {
  job.text = text; job.logs.push(`[${new Date().toLocaleTimeString("ru-RU")}] ${text}`);
  if (job.logs.length > 500) job.logs.splice(0, job.logs.length - 500);
  lastStatus = status(job);
  browser.tabs.sendMessage(job.tabId, { channel: "yd-clicker", type: "status", value: lastStatus }).catch(() => {});
}
async function command(job, name, extra = {}) {
  C.check(job.controller.signal);
  let reply;
  try { reply = await browser.tabs.sendMessage(job.tabId, { channel: "yd-clicker", type: "command", name, ...extra }); }
  catch (e) { throw new Error("Нет связи со страницей: " + e.message); }
  C.check(job.controller.signal);
  if (!reply?.ok) {
    if (reply?.fatal) throw new C.FatalError(reply.error);
    throw new Error(reply?.error || "Обновите вкладку Диска после установки расширения.");
  }
  if (reply.value?.challenge) throw new C.FatalError("Проверка «Я не робот»: остановлено. Пройдите её вручную.");
  if (reply.value?.url && name !== "picture" && C.publicKey(reply.value.url) !== job.share) throw new C.FatalError("Вкладка ушла с выбранной публичной ссылки. Остановка.");
  return reply.value;
}
async function observeUntil(job, predicate, timeout = 30000) {
  const started = Date.now(); let lastError;
  while (Date.now() - started < timeout) {
    C.check(job.controller.signal);
    try {
      const view = await command(job, "snapshot");
      if (!view.busy && predicate(view)) return view;
    } catch (e) { if (e.name === "AbortError" || e.name === "FatalError") throw e; lastError = e; }
    await C.delay(250, job.controller.signal);
  }
  throw new C.FatalError("Не удалось подтвердить переход страницы. " + (lastError?.message || "Возможно, сайт изменил кнопки или структуру."));
}
async function opened(job, item) {
  const action = await command(job, "open", { item });
  if (action.already) return command(job, "snapshot");
  const before = action.before;
  await observeUntil(job, view => view.viewer !== before.viewer || view.fingerprint !== before.fingerprint || view.crumbs !== before.crumbs);
  return command(job, "settled");
}
async function returnTo(job, frame, fromFile) {
  if (fromFile) {
    await command(job, "closeViewer");
    const until = Date.now() + 2500;
    while (Date.now() < until) {
      try {
        const current = await command(job, "snapshot");
        if (!current.viewer && current.url === frame.url) { await command(job, "settled"); return; }
      } catch (e) { if (e.name === "AbortError" || e.name === "FatalError") throw e; }
      await C.delay(200, job.controller.signal);
    }
  }
  await browser.tabs.goBack(job.tabId);
  await observeUntil(job, view => !view.viewer && view.url === frame.url);
  await command(job, "settled");
}
async function restoreAfterAttachment(job, url) {
  const tab = await browser.tabs.get(job.tabId);
  if (C.publicKey(tab.url) === job.share) return;
  // Canceling a main-frame attachment can show Firefox's blocked-request page.
  // Recover only this known navigation, never an unrelated page opened by the user.
  if (tab.url !== url && !(tab.url.startsWith("about:neterror") && tab.url.includes(encodeURIComponent(url))))
    throw new C.FatalError("Вкладка перешла на другую страницу. Вернитесь в начальную папку и запустите очередь снова.");
  await browser.tabs.goBack(job.tabId);
  await observeUntil(job, view => C.publicKey(view.url) === job.share);
  await command(job, "settled");
}
function ownedRequest(job, details) {
  if (details.tabId >= 0) return details.tabId === job.tabId;
  return [details.originUrl, details.documentUrl].some(url => C.publicKey(url) === job.share);
}
function armCapture(job, item, origin = "") {
  if (pending) throw new C.FatalError("Другая загрузка ещё ожидает ответа.");
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); promise.catch(() => {});
  const entry = { job, item, promise, taken: false, done: false };
  const cleanup = () => { clearTimeout(entry.timer); job.controller.signal.removeEventListener("abort", abort); if (pending === entry) pending = null; };
  entry.resolve = value => { if (entry.done) return; entry.done = true; cleanup(); resolve(value); };
  entry.reject = error => { if (entry.done) return; entry.done = true; cleanup(); reject(error); };
  const abort = () => entry.reject(C.abortError());
  job.controller.signal.addEventListener("abort", abort, { once: true });
  entry.timer = setTimeout(() => {
    expireClick(job, item, "", origin);
    entry.reject(new FileTimeout("Скачивание оригинала не началось за 3 секунды."));
  }, FILE_IDLE_MS);
  pending = entry; return entry;
}
browser.webRequest.onBeforeRequest.addListener(details => {
  if (expiredRequest(details)) return { cancel: true };
  const p = pending;
  if (!p || p.taken || p.done || p.job.controller.signal.aborted || !C.isAttachment(details.url)
    || !C.sameFile(details.url, p.item.name) || !ownedRequest(p.job, details)) return {};
  p.taken = true;
  // The canceled navigation is reissued through Firefox's download manager, so
  // filenames can include subfolders. No public API is called by this extension.
  p.resolve({ url: details.url }); return { cancel: true };
}, { urls: ["https://*.yandex.ru/*", "https://*.yandex.net/*", "https://*.yandex.com/*", "https://*.yandex.kz/*", "https://*.yandex.by/*", "https://*.yandex.com.tr/*"] }, ["blocking"]);
browser.downloads.onCreated.addListener(item => {
  const expired = expiredClicks.find(entry => entry.until > Date.now() && ((entry.url && entry.url === item.url
      && (item.byExtensionId === browser.runtime.id || (!item.byExtensionId && C.publicKey(item.referrer) === entry.share)))
    || (!item.byExtensionId && C.publicKey(item.referrer) === entry.share && (!entry.origin || item.referrer === entry.origin)
      && (() => { try { return new URL(item.url).searchParams.get("filename") === entry.name; } catch (_) { return false; } })())));
  if (expired) { browser.downloads.cancel(item.id).catch(() => {}); return; }
  const p = pending;
  if (!p || p.taken || p.done || item.byExtensionId || p.job.controller.signal.aborted) return;
  const name = item.filename?.replace(/\\/g, "/").split("/").pop();
  if (C.publicKey(item.referrer) !== p.job.share || !C.sameFile(item.url, p.item.name)
    || (name && name !== p.item.name) || !C.allowedAsset(item.url)) return;
  p.taken = true;
  (async () => {
    p.job.siteDownload = item.id;
    if (item.state === "complete") { p.job.siteDownload = null; p.resolve({ complete: item }); return; }
    await browser.downloads.cancel(item.id).catch(() => {});
    const [current] = await browser.downloads.search({ id: item.id });
    if (current?.state === "complete") p.resolve({ complete: current });
    else if (current?.state === "interrupted") p.resolve({ url: item.url });
    else p.reject(new C.FatalError("Не удалось остановить исходную загрузку сайта. Очередь остановлена."));
    p.job.siteDownload = null;
  })().catch(e => p.reject(new C.FatalError(e.message)));
});
async function download(job, url, filename) {
  C.check(job.controller.signal);
  if (!(C.allowedAsset(url) || url.startsWith("blob:moz-extension:") || url.startsWith("blob:null/"))) throw new Error("Недопустимая ссылка на файл.");
  const creation = browser.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
  let creationTimer;
  let rejectCreationAbort;
  const creationAbort = new Promise((resolve, reject) => { rejectCreationAbort = reject; });
  const abortCreation = () => rejectCreationAbort(C.abortError());
  job.controller.signal.addEventListener("abort", abortCreation, { once: true });
  const creationTimeout = new Promise((resolve, reject) => { creationTimer = setTimeout(() => {
    expireClick(job, { name: filename.split("/").pop() }, url);
    reject(new FileTimeout("Firefox не запустил сохранение за 3 секунды."));
  }, FILE_IDLE_MS); });
  let id;
  try { C.check(job.controller.signal); id = await Promise.race([creation, creationTimeout, creationAbort]); }
  catch (error) {
    if (error.name === "FileTimeout" || error.name === "AbortError") creation.then(lateId => browser.downloads.cancel(lateId).catch(() => {})).catch(() => {});
    throw error;
  } finally { clearTimeout(creationTimer); job.controller.signal.removeEventListener("abort", abortCreation); }
  job.downloadId = id;
  let lastBytes = 0, lastProgress = Date.now();
  try {
    while (true) {
      C.check(job.controller.signal);
      const [item] = await browser.downloads.search({ id });
      if (!item) throw new C.FatalError("Загрузка исчезла из списка Firefox. Очередь остановлена.");
      if (item.state === "complete") return item;
      if (item.state === "interrupted") throw new Error("Firefox прервал скачивание: " + (item.error || "причина не указана"));
      if (item.bytesReceived > lastBytes) { lastBytes = item.bytesReceived; lastProgress = Date.now(); }
      if (Date.now() - lastProgress >= FILE_IDLE_MS) {
        await browser.downloads.cancel(id);
        const [ended] = await browser.downloads.search({ id });
        if (ended?.state === "complete") return ended;
        if (ended?.state !== "interrupted") throw new C.FatalError("Не удалось подтвердить остановку зависшей загрузки.");
        expireClick(job, { name: filename.split("/").pop() }, url);
        throw new FileTimeout("Нет прогресса скачивания 3 секунды. Загрузка отменена.");
      }
      await C.delay(250, job.controller.signal);
    }
  } catch (e) {
    if (e.name === "AbortError") await browser.downloads.cancel(id).catch(() => {});
    throw e;
  } finally { job.downloadId = null; }
}
async function blobToPNG(blob) {
  if (blob.size > 64 * 1024 * 1024) throw new Error("Превью превышает 64 МБ.");
  const image = await createImageBitmap(blob);
  try {
    if (image.width * image.height > 80000000) throw new Error("Изображение слишком большое для PNG-превью.");
    const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
    canvas.getContext("2d").drawImage(image, 0, 0);
    return await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Не удалось получить PNG.")), "image/png"));
  } finally { image.close(); }
}
async function savePicture(job, filename) {
  const source = await command(job, "picture");
  let blob;
  if (source.data?.startsWith("data:image/png;base64,")) blob = await (await fetch(source.data)).blob();
  else {
    if (!C.allowedAsset(source.url)) throw new Error("Адрес показанного изображения недоступен расширению или принадлежит другому сайту.");
    const controller = new AbortController();
    const abort = () => controller.abort(); job.controller.signal.addEventListener("abort", abort, { once: true });
    let timer = setTimeout(abort, FILE_IDLE_MS);
    let reader;
    try {
      const response = await fetch(source.url, { credentials: "include", signal: controller.signal });
      if (!response.ok) throw new Error("Не удалось скачать показанную картинку: HTTP " + response.status);
      if (response.body) {
        reader = response.body.getReader();
        const chunks = []; let received = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          if (part.value.byteLength) {
            clearTimeout(timer); timer = setTimeout(abort, FILE_IDLE_MS);
            received += part.value.byteLength;
            if (received > 64 * 1024 * 1024) throw new Error("Превью превышает 64 МБ.");
            chunks.push(part.value);
          }
        }
        blob = new Blob(chunks, { type: response.headers.get("content-type") || "" });
      } else blob = await response.blob();
      if (!blob.type.startsWith("image/")) throw new Error("Вместо картинки сервер вернул " + blob.type);
    } catch (e) { C.check(job.controller.signal); if (e.name === "AbortError") throw new FileTimeout("Нет прогресса загрузки превью 3 секунды. Файл пропущен."); throw e; }
    finally { clearTimeout(timer); if (reader) reader.cancel().catch(() => {}); job.controller.signal.removeEventListener("abort", abort); }
  }
  C.check(job.controller.signal);
  const png = await blobToPNG(blob), url = URL.createObjectURL(png);
  try { return await download(job, url, filename); } finally { URL.revokeObjectURL(url); }
}
async function remember(job, key, item, preview) {
  job.completed[key] = { downloadId: item.id, preview, filename: item.filename };
  try { await browser.storage.local.set({ [COMPLETED_KEY]: job.completed }); }
  catch (e) { throw new C.FatalError("Файл сохранён, но не удалось запомнить результат: " + e.message); }
}
async function previouslySaved(job, key) {
  const record = job.completed[key]; if (!record) return false;
  const [item] = await browser.downloads.search({ id: record.downloadId });
  return item?.state === "complete" && item.exists !== false;
}
async function processFile(job, frame, item) {
  const key = JSON.stringify([job.rootUrl, job.prefix, frame.path, item.name]);
  if (await previouslySaved(job, key)) { job.counts.skipped++; log(job, "Уже сохранён: " + [...frame.path, item.name].join("/")); return; }
  if (job.attempted) await C.delay(1000, job.controller.signal);
  job.attempted = true;
  log(job, "Открываю: " + [...frame.path, item.name].join("/"));
  const view = item.single ? await command(job, "snapshot") : await opened(job, item);
  if (!item.single && !view.viewer) {
    const child = await command(job, "scan");
    if (!child.single) return { asFolder: child };
  }
  let originalError = null, saved = null, isPreview = false;
  try {
    const capture = armCapture(job, item, view.url);
    let click;
    try { click = await command(job, "clickDownload"); }
    catch (e) { capture.reject(e); throw new C.FatalError("Не удалось подтвердить нажатие кнопки: " + e.message); }
    if (click.unavailable) { capture.reject(new Error("Кнопка Скачать недоступна")); originalError = new Error("Кнопка «Скачать» отсутствует или отключена."); }
    else {
      let actual;
      try {
        actual = await capture.promise;
        log(job, "Скачивание: " + item.name);
        saved = actual.complete || await download(job, actual.url, C.filePath(job.prefix, frame.path, item.name));
      }
      catch (e) { if (e.name === "FatalError" || e.name === "AbortError") throw e; originalError = e; }
      if (actual?.url) await restoreAfterAttachment(job, actual.url);
    }
    if (!saved && job.fallback && item.image) {
      log(job, "Оригинал недоступен: " + originalError.message + " Пробую картинку из просмотра.");
      await C.delay(1000, job.controller.signal);
      saved = await savePicture(job, C.filePath(job.prefix, frame.path, item.name, true)); isPreview = true;
    }
    if (!saved) throw originalError || new Error("Не удалось скачать файл.");
    await remember(job, key, saved, isPreview);
    if (isPreview) job.counts.previews++; else job.counts.originals++;
    log(job, (isPreview ? "Превью PNG: " : "Сохранено: ") + item.name);
  } catch (e) {
    if (e.name === "AbortError" || e.name === "FatalError") throw e;
    job.counts.errors++; log(job, (e.name === "FileTimeout" ? "ПРОПУСК: " : "ОШИБКА: ") + item.name + " — " + e.message);
  }
  if (!item.single) await returnTo(job, frame, true);
  return null;
}
async function walk(job, first) {
  const stack = [{ ...first, path: [], index: 0 }];
  while (stack.length) {
    C.check(job.controller.signal);
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.entries.length) { stack.pop(); if (stack.length) await returnTo(job, stack[stack.length - 1], false); continue; }
    const item = frame.entries[frame.index++];
    if (item.type === "folder") {
      log(job, "Вхожу в папку: " + [...frame.path, item.name].join("/"));
      await opened(job, item);
      const child = await command(job, "scan");
      if (child.single) throw new C.FatalError("Карточка папки открыла файл. Сайт изменился; остановлено.");
      if (stack.length >= 100) throw new C.FatalError("Слишком много уровней папок.");
      stack.push({ ...child, path: [...frame.path, item.name], index: 0 });
    } else {
      const result = await processFile(job, frame, item);
      if (result?.asFolder) { if (stack.length >= 100) throw new C.FatalError("Слишком много уровней папок."); stack.push({ ...result.asFolder, path: [...frame.path, item.name], index: 0 }); }
    }
  }
}
async function run(job) {
  try {
    const stored = await browser.storage.local.get(COMPLETED_KEY); job.completed = stored[COMPLETED_KEY] || {};
    await command(job, "resume"); const first = await command(job, "scan");
    log(job, "В текущей папке: " + first.entries.length + " карточек. Начинаю обход.");
    await walk(job, first);
    log(job, `Готово: ${job.counts.originals} оригиналов, ${job.counts.previews} превью, ${job.counts.skipped} уже сохранено, ${job.counts.errors} ошибок.`);
  } catch (e) { log(job, e.name === "AbortError" ? "Остановлено. Вернитесь в начальную папку и нажмите «Скачать» для продолжения." : "Остановка: " + e.message); }
  finally {
    if (pending?.job === job) pending.reject(C.abortError());
    if (job.downloadId != null) await browser.downloads.cancel(job.downloadId).catch(() => {});
    if (job.siteDownload != null) await browser.downloads.cancel(job.siteDownload).catch(() => {});
    await browser.tabs.sendMessage(job.tabId, { channel: "yd-clicker", type: "command", name: "stop" }).catch(() => {});
    active = null; lastStatus = { ...status(job), running: false };
    await browser.storage.local.set({ [STATUS_KEY]: lastStatus }).catch(() => {});
    browser.tabs.sendMessage(job.tabId, { channel: "yd-clicker", type: "status", value: lastStatus }).catch(() => {});
  }
}
browser.tabs.onRemoved.addListener(tabId => { if (active?.tabId === tabId) active.controller.abort(); });
browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.channel !== "yd-clicker") return undefined;
  if (message.type === "openPanel") return openPanel(message);
  if (message.type === "getStatus") return Promise.resolve({ ...(active ? status(active) : lastStatus), viewerTabId: sender.tab?.id });
  if (message.type === "start") {
    if (active) return Promise.resolve({ ok: false, error: "Уже идёт загрузка. Сначала остановите её." });
    const tab = sender.tab, share = C.publicKey(tab?.url);
    if (!tab || !share) return Promise.resolve({ ok: false, error: "Откройте публичную папку Яндекс Диска." });
    let prefix; try { prefix = C.relativeRoot(message.prefix); } catch (e) { return Promise.resolve({ ok: false, error: e.message }); }
    const job = { tabId: tab.id, rootUrl: tab.url, share, prefix, fallback: message.fallback !== false,
      controller: new AbortController(), completed: {}, attempted: false, logs: [], counts: { originals: 0, previews: 0, skipped: 0, errors: 0 }, text: "Подготовка…", downloadId: null, siteDownload: null };
    expiredClicks = expiredClicks.filter(entry => entry.tabId !== tab.id || entry.share !== share);
    active = job; run(job); return Promise.resolve({ ok: true });
  }
  if (message.type === "stop") {
    if (active && (!sender.tab || sender.tab.id === active.tabId)) {
      active.controller.abort(); browser.tabs.sendMessage(active.tabId, { channel: "yd-clicker", type: "command", name: "stop" }).catch(() => {});
    }
    return Promise.resolve({ ok: true });
  }
  return undefined;
});
browser.storage.local.get(STATUS_KEY).then(stored => { if (!active && stored[STATUS_KEY]) lastStatus = { ...stored[STATUS_KEY], running: false }; }).catch(() => {});
