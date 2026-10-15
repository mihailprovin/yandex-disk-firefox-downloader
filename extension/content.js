"use strict";
(function () {
  if (globalThis.YDClickerPanel) return;
  document.getElementById("yd-clicker-host")?.remove();
  const Site = YDSite, host = document.createElement("div"); host.id = "yd-clicker-host";
  host.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;display:none";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host{all:initial}*{box-sizing:border-box}.panel{font:14px/1.45 system-ui,sans-serif;color:#202938;background:#fff;border:1px solid #c8d3e1;border-radius:14px;box-shadow:0 6px 34px #182a4050;width:420px;max-width:calc(100vw - 36px);max-height:calc(100vh - 36px);overflow:auto;padding:17px}
      header{display:flex;justify-content:space-between;align-items:center;gap:10px}h2{font-size:17px;margin:0}button,input{font:inherit}button{cursor:pointer;border:1px solid #c8d3e1;background:#f3f6fa;border-radius:7px;padding:7px 10px}button:disabled{opacity:.5;cursor:default}#start{background:#e2eeff;color:#174777}#hide{border:0;background:none;font-size:20px;padding:0 5px}label{display:block;margin:12px 0 5px}input[type=text]{width:100%;padding:7px;border:1px solid #c8d3e1;border-radius:6px}.check{display:flex;align-items:flex-start;gap:7px}.check input{margin:4px 0}.muted{color:#647184;font-size:12px;margin:7px 0}.buttons{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0}#status{overflow-wrap:anywhere;font-weight:600;margin:10px 0 4px}#counts{font-size:12px;color:#647184}pre{white-space:pre-wrap;overflow:auto;max-height:160px;font:11px/1.5 ui-monospace,monospace;background:#f5f7fa;border-radius:7px;padding:9px;margin:10px 0 0}footer{display:flex;gap:7px;margin-top:10px}footer button{font-size:12px}.warn{color:#9b4918}
    </style>
    <style>textarea{font:12px/1.4 ui-monospace,monospace;width:100%;min-height:70px;resize:vertical;border:1px solid #c8d3e1;border-radius:6px;padding:7px}input[type=number]{width:100px;padding:6px;border:1px solid #c8d3e1;border-radius:6px}#resume{background:#e6f5eb}#queue-info,#log-info{font-size:12px;color:#647184}</style>
    <section class="panel">
      <header><h2>Диск: скачать по одному</h2><button id="hide" title="Скрыть панель" aria-label="Скрыть панель">×</button></header>
      <p class="muted">Нет старта или прогресса 3 секунды — отмена оригинала и сохранение картинки из просмотра.</p>
      <label for="urls">Ссылки на папки/фотографии — по одной в строке</label><textarea id="urls" placeholder="Пусто — скачать текущую папку"></textarea>
      <label for="prefix">Подпапка внутри «Загрузок»</label><input id="prefix" type="text" value="Яндекс-Диск" maxlength="150">
      <label for="pause">Пауза между файлами, секунд (0–3600)</label><input id="pause" type="number" min="0" max="3600" step="0.1" value="1">
      <label class="check"><input id="fallback" type="checkbox" checked><span>Если оригинал картинки недоступен — сохранить изображение из просмотра как PNG</span></label>
      <label class="check"><input id="recovery" type="checkbox" checked><span>При сбое открытия: стрелки просмотра или обновление папки и одна повторная попытка</span></label>
      <p class="muted">Превью может иметь меньшее разрешение. Начните с нужной папки и оставьте эту вкладку открытой.</p>
      <div class="buttons"><button id="check">Проверить страницу</button><button id="start">Скачать очередь</button><button id="resume" disabled>Продолжить очередь</button><button id="stop" disabled>Остановить</button></div>
      <div id="status" role="status">Готово к работе</div><div id="queue-info"></div><div id="counts"></div><div id="log-info"></div><pre id="log" hidden></pre>
      <footer><button id="save-log">Сохранить полный журнал</button><button id="diagnostics">Диагностика</button></footer>
      <p class="muted warn">Во время работы не нажимайте кнопки Диска и не переключайте папки в этой вкладке.</p>
    </section>`;
  (document.body || document.documentElement).appendChild(host);
  const $ = id => shadow.getElementById(id), send = data => browser.runtime.sendMessage({ channel: "yd-clicker", ...data });
  let logs = [], polling = null, localCheck = false, submitting = false;
  function update(value) {
    if (!value || (localCheck && !value.running)) return;
    if (value.running) localCheck = false;
    const elsewhere = value.running && ((value.viewerTabId != null && value.tabId !== value.viewerTabId)
      || (value.rootUrl && YDCommon.publicKey(value.rootUrl) !== YDCommon.publicKey(location.href)));
    $("status").textContent = elsewhere ? "Загрузка идёт в другой вкладке Диска." : value.text;
    const n = value.counts || {};
    $("counts").textContent = `Оригиналы: ${n.originals || 0} · PNG: ${n.previews || 0} · Уже сохранено: ${n.skipped || 0} · Ошибки: ${n.errors || 0}`;
    for (const id of ["start", "check", "prefix", "fallback", "urls", "pause", "recovery"]) $(id).disabled = !!value.running || submitting;
    $("resume").disabled = !!value.running || submitting || !value.canResume;
    $("stop").disabled = !value.running || elsewhere;
    $("queue-info").textContent = value.queueTotal ? `Ссылка ${Math.min((value.queueIndex || 0) + 1, value.queueTotal)} из ${value.queueTotal}` : "";
    $("log-info").textContent = value.logCount ? `Полный журнал: ${value.logCount} записей. Ниже — последние 150; в файл сохраняются все записи.` : "";
    logs = value.logs || []; $("log").hidden = !logs.length; $("log").textContent = logs.join("\n"); $("log").scrollTop = $("log").scrollHeight;
  }
  function show() {
    host.style.display = "block";
    send({ type: "getStatus" }).then(update).catch(e => { $("status").textContent = e.message; });
    if (!polling) polling = setInterval(() => send({ type: "getStatus" }).then(update).catch(() => {}), 1500);
  }
  function hide() { host.style.display = "none"; clearInterval(polling); polling = null; }
  $("hide").onclick = hide;
  async function start(resume = false) {
    if (submitting) return;
    submitting = true; localCheck = false; $("start").disabled = $("resume").disabled = true;
    try {
      const config = { prefix: $("prefix").value, fallback: $("fallback").checked, urls: $("urls").value,
        pauseSeconds: $("pause").value, recovery: $("recovery").checked };
      if (!resume) { YDCommon.links(config.urls); YDCommon.pause(config.pauseSeconds); await browser.storage.local.set({ "yd-clicker-prefs": config }); }
      const reply = await send({ type: resume ? "resumeQueue" : "start", ...config });
      if (!reply.ok) throw new Error(reply.error);
      submitting = false;
      update(await send({ type: "getStatus" }));
    } catch (e) { localCheck = true; $("status").textContent = e.message; $("start").disabled = false; $("resume").disabled = false; }
    finally { submitting = false; }
  }
  $("start").onclick = () => start(); $("resume").onclick = () => start(true);
  $("stop").onclick = () => { $("stop").disabled = true; $("status").textContent = "Остановка…"; Site.stop(); send({ type: "stop" }).catch(() => {}); };
  $("check").onclick = async () => {
    localCheck = true; $("check").disabled = $("start").disabled = true; $("status").textContent = "Читаю карточки текущей папки…";
    try {
      const result = await Site.scan(), folders = result.entries.filter(x => x.type === "folder").length;
      $("status").textContent = `Текущая папка: ${result.entries.length - folders} файлов, ${folders} папок`;
      logs = result.entries.map(x => `${x.type === "folder" ? "Папка" : "Файл"}: ${x.name}`);
      $("log").hidden = false; $("log").textContent = logs.join("\n") || "Папка пуста";
    } catch (e) { $("status").textContent = e.message; }
    finally { $("check").disabled = $("start").disabled = false; }
  };
  function saveText(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  $("save-log").onclick = async () => {
    $("save-log").disabled = true;
    try { const result = await send({ type: "exportLog" }); if (!result?.ok) throw new Error(result?.error || "Не удалось сохранить журнал."); }
    catch (error) { $("status").textContent = error.message; }
    finally { $("save-log").disabled = false; }
  };
  $("diagnostics").onclick = () => saveText(JSON.stringify(Site.diagnostics(), null, 2), "YandexDisk-page-diagnostics.json");
  browser.storage.local.get("yd-clicker-prefs").then(stored => {
    const prefs = stored["yd-clicker-prefs"]; if (!prefs) return;
    $("prefix").value = prefs.prefix || "Яндекс-Диск"; $("fallback").checked = prefs.fallback !== false;
    $("urls").value = Array.isArray(prefs.urls) ? prefs.urls.join("\n") : prefs.urls || "";
    $("pause").value = prefs.pauseSeconds ?? 1; $("recovery").checked = prefs.recovery !== false;
  }).catch(() => {});
  browser.runtime.onMessage.addListener(async message => {
    if (message?.channel !== "yd-clicker") return undefined;
    if (message.type === "show") { if (message.urls !== undefined) $("urls").value = message.urls; show(); return { ok: true }; }
    if (message.type === "status") { update(message.value); return undefined; }
    if (message.type !== "command") return undefined;
    const allowed = new Set(["scan", "open", "clickDownload", "picture", "closeViewer", "snapshot", "settled", "refreshViewer", "stop", "resume"]);
    if (!allowed.has(message.name)) return { ok: false, error: "Неизвестная команда" };
    try { return { ok: true, value: await Site[message.name](["open", "refreshViewer"].includes(message.name) ? message.item : undefined) }; }
    catch (e) { return { ok: false, error: e.message, fatal: e.name === "FatalError" }; }
  });
  globalThis.YDClickerPanel = { show, hide };
  if (YDCommon.publicKey(location.href)) show();
})();
