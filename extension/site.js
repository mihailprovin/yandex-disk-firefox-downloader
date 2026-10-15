/* DOM adapter: opens cards, presses website buttons and reads displayed images. */
(function (root) {
  "use strict";
  if (root.YDSite) return;
  const C = root.YDCommon;
  const ROW = '.listing-item, .public-listing__item, .public-folder__item, [data-testid="listing-item"], [data-testid="resource-item"], [role="row"][data-id]';
  const NAME = '.listing-item__title, .listing-item__name, .listing-item__title-text, .public-listing__item-name, [data-testid="resource-name"], [data-testid="file-name"], [data-testid="name"]';
  const VIEWER = '.public-file-preview, .file-preview, .preview, .slider, .public-file, [data-testid="file-viewer"], [role="dialog"]';
  const FOLDER = '[data-type="dir"], [data-type="folder"], [class*="type_dir"], [class*="type_folder"], [class*="type_directory"], [class*="icon-folder"], [class*="icon_folder"], use[href*="folder"]';
  let controller = new AbortController();
  function stop() { controller.abort(); }
  function resume() { if (controller.signal.aborted) controller = new AbortController(); }
  function visible(el) { return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none"; }
  function elements(selector, scope = document) { return Array.from(scope.querySelectorAll(selector)).filter(visible); }
  function allRows() { return elements(ROW).filter(row => !row.parentElement?.closest(ROW)); }
  function nameOf(row) {
    const el = row.querySelector(NAME);
    let name = el && (el.getAttribute("title") || el.textContent.trim());
    name = name || row.getAttribute("data-name") || row.getAttribute("aria-label") || row.getAttribute("title");
    if (!name || name.length > 255 || /\n/.test(name)) throw new Error("Не удалось прочитать имя карточки. Нажмите «Диагностика» и сохраните отчёт.");
    return name.trim();
  }
  function descriptor(row) {
    const name = nameOf(row);
    const type = row.matches(FOLDER) || row.querySelector(FOLDER) || /(?:папка|folder)/i.test(row.getAttribute("aria-label") || "") ? "folder" : "file";
    const image = C.imageExtensions.test(name) || /^(?:image|photo)$/.test(row.getAttribute("data-media-type") || "")
      || (row.getAttribute("data-mime-type") || "").startsWith("image/")
      || !!row.querySelector('[class*="type_image"], [class*="type_photo"], [class*="icon-image"]');
    return { name, type, key: `${type}:${name}`, image };
  }
  function titleName() {
    const candidates = elements('.public-file__name, .public-file__title, .public-file-preview__title, .file-preview__title, .preview__title, .slider__title, [data-testid="file-name"], h1');
    return candidates.map(x => x.getAttribute("title") || x.textContent.trim()).find(x => x && x.length < 256)
      || document.title.replace(/\s*[—–-]\s*Яндекс\s*Диск.*$/i, "").trim();
  }
  function viewer() {
    const candidates = elements(VIEWER).filter(el => el.querySelector('img, canvas, video, iframe, [class*="preview"], [class*="download"]') || /(?:скачать|download)/i.test(el.textContent));
    // Prefer an actual dialog / slider over a large ancestor that includes the listing.
    return candidates.find(el => !el.querySelector(ROW)) || null;
  }
  function label(el) { return (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim().replace(/\s+/g, " "); }
  function viewerTitle() {
    const scope = viewer(); if (!scope) return "";
    const node = elements('.public-file__name, .public-file__title, .public-file-preview__title, .file-preview__title, .preview__title, .slider__title, [data-testid="file-name"]', scope)[0];
    return node ? (node.getAttribute("title") || node.textContent.trim()) : "";
  }
  function downloadButton() {
    const scope = viewer() || (allRows().length === 0 ? document : null);
    if (!scope) return null; // Never use the download-whole-folder button.
    const controls = elements('button, a, [role="button"]', scope);
    return controls.find(el => /^(?:скачать|download)(?:\s+файл)?$/i.test(label(el)))
      || controls.find(el => /(?:^|[ _-])download(?:$|[ _-])/.test(String(el.className)) && !/(?:все|всё|папк|all|folder|zip)/i.test(label(el))) || null;
  }
  function challenge() {
    return !!document.querySelector('form[action*="captcha"], [id*="smartcaptcha"], [class*="SmartCaptcha"]')
      || /(?:Подтвердите, что вы не робот|Confirm you are not a robot)/i.test(document.body?.innerText || "");
  }
  function busy() { return elements('[aria-busy="true"], .listing__spin, .listing__loader, .public-folder__loader').length > 0; }
  function snapshot() {
    const rows = allRows();
    return { url: location.href, viewer: !!viewer(), viewerName: viewerTitle(), rows: rows.length,
      fingerprint: rows.map(r => { try { return descriptor(r).key; } catch (_) { return "?"; } }).join("|"),
      title: titleName(), busy: busy(), challenge: challenge(),
      crumbs: elements('.breadcrumb, .breadcrumbs, [class*="crumb"], [data-testid="breadcrumbs"]').map(x => x.textContent.trim()).join(" / ") };
  }
  async function settled(ms = 1000) {
    let last = "", stable = 0;
    const started = Date.now();
    while (Date.now() - started < 30000) {
      C.check(controller.signal);
      const state = snapshot(), signature = JSON.stringify([state.url, state.fingerprint, state.viewer, state.crumbs]);
      if (state.challenge) throw new C.FatalError("На странице проверка «Я не робот». Пройдите её вручную и запустите расширение снова.");
      if (!state.busy && signature === last) stable += 200; else stable = 0;
      if (stable >= ms) return state;
      last = signature; await C.delay(200, controller.signal);
    }
    throw new Error("Страница не закончила загрузку за 30 секунд.");
  }
  function scrollArea() {
    const row = allRows()[0];
    for (let el = row?.parentElement; el && el !== document.body; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
    }
    return document.scrollingElement;
  }
  async function scan() {
    resume(); await settled();
    if (viewer() && allRows().length) throw new Error("Закройте просмотр файла и откройте папку, с которой нужно начать.");
    if (!allRows().length) {
      if (viewer() || downloadButton()) {
        const name = titleName();
        if (!name) throw new Error("Не удалось прочитать имя отдельного файла.");
        return { url: location.href, single: true, title: name, entries: [{ name, type: "file", key: `file:${name}`, image: C.imageExtensions.test(name), single: true }] };
      }
      if (elements('.listing, .public-folder, .public-listing, [data-testid="listing"], [class*="empty-folder"], .listing-empty').length
        || /(?:В этой папке пока нет файлов|Папка пуста|This folder is empty)/i.test(document.body.innerText)) return { url: location.href, single: false, title: titleName(), entries: [] };
      throw new Error("Не найдены карточки файлов. Дождитесь загрузки страницы или сохраните «Диагностику».");
    }
    const area = scrollArea(), oldScroll = area.scrollTop, found = new Map();
    area.scrollTop = 0; area.dispatchEvent(new Event("scroll", { bubbles: true }));
    let bottomStable = 0, previousCount = 0;
    try {
      for (let i = 0; i < 1200; i++) {
        C.check(controller.signal); await C.delay(250, controller.signal);
        for (const row of allRows()) { const item = descriptor(row); found.set(item.key, item); }
        const atBottom = area.scrollTop + area.clientHeight >= area.scrollHeight - 4;
        if (atBottom && previousCount === found.size && !busy()) bottomStable++; else bottomStable = 0;
        if (bottomStable >= 5) return { url: location.href, single: false, title: titleName(), entries: [...found.values()] };
        previousCount = found.size;
        area.scrollTop = Math.min(area.scrollHeight, area.scrollTop + Math.max(150, area.clientHeight * 0.65));
        area.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
      throw new Error("Слишком длинный/неполный список. Разделите загрузку по папкам; очередь не запущена.");
    } finally { area.scrollTop = oldScroll; area.dispatchEvent(new Event("scroll", { bubbles: true })); }
  }
  async function findRow(item) {
    const area = scrollArea(); area.scrollTop = 0;
    for (let i = 0; i < 1200; i++) {
      C.check(controller.signal);
      const row = allRows().find(r => { const d = descriptor(r); return d.name === item.name && d.type === item.type; });
      if (row) { row.scrollIntoView({ block: "center" }); return row; }
      if (area.scrollTop + area.clientHeight >= area.scrollHeight - 4 && i > 2) break;
      area.scrollTop += Math.max(150, area.clientHeight * 0.65);
      area.dispatchEvent(new Event("scroll", { bubbles: true })); await C.delay(200, controller.signal);
    }
    throw new C.FatalError("Не удалось найти карточку «" + item.name + "». Содержимое папки могло измениться.");
  }
  async function open(item) {
    resume(); C.check(controller.signal);
    if (item.single) return { before: snapshot(), already: true };
    const row = await findRow(item), before = snapshot();
    // Return before navigation can tear down the content-script message port.
    setTimeout(() => {
      if (controller.signal.aborted) return;
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, button: 0 }));
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 2, button: 0 }));
      row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2, button: 0 }));
    }, 30);
    return { before };
  }
  function clickDownload() {
    C.check(controller.signal);
    const button = downloadButton();
    if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return { unavailable: true };
    const text = label(button);
    if (/(?:все|всё|папк|all|folder)/i.test(text)) throw new C.FatalError("Кнопка относится к целой папке, а не к текущему файлу. Остановка.");
    setTimeout(() => { if (!controller.signal.aborted) button.click(); }, 30);
    return { clicked: true };
  }
  async function picture(deadline = Date.now() + 3000) {
    C.check(controller.signal);
    const scope = viewer() || (allRows().length === 0 ? document : null);
    if (!scope) throw new Error("Окно просмотра изображения не найдено.");
    const canvases = elements("canvas", scope).filter(x => x.width >= 64 && x.height >= 64);
    const images = elements("img", scope).filter(x => !x.closest(ROW) && x.naturalWidth >= 64 && x.naturalHeight >= 64
      && !/(?:icon|avatar|placeholder|illustration|error-image)/i.test(String(x.className)));
    const list = [...canvases, ...images].sort((a, b) => (b.naturalWidth || b.width) * (b.naturalHeight || b.height) - (a.naturalWidth || a.width) * (a.naturalHeight || a.height));
    const best = list[0];
    if (best) {
      const width = best.naturalWidth || best.width, height = best.naturalHeight || best.height;
      if (width * height > 80000000) throw new Error("Изображение слишком большое для сохранения через просмотр.");
      try {
        const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(best, 0, 0);
        const data = canvas.toDataURL("image/png");
        if (data.length <= 48 * 1024 * 1024) return { data, width, height, name: viewerTitle() };
      } catch (_) { /* Cross-origin images may taint a canvas; use their visible source. */ }
      if (best.currentSrc || best.src) return { url: best.currentSrc || best.src, width, height, name: viewerTitle() };
    }
    for (const el of elements('[class*="preview__image"], [class*="slider__image"], [class*="preview-image"]', scope)) {
      const match = getComputedStyle(el).backgroundImage.match(/^url\(["']?(.*?)["']?\)$/);
      if (match) return { url: new URL(match[1], location.href).href, name: viewerTitle() };
    }
    if (Date.now() < deadline && elements('img, canvas, [class*="preview__image"], [class*="slider__image"], [class*="preview-image"]', scope).length) {
      await C.delay(250, controller.signal);
      return picture(deadline);
    }
    throw new Error("В просмотре нет доступной картинки. Миниатюры из списка не сохраняются.");
  }
  function closeViewer() {
    const scope = viewer(); if (!scope) return { closed: true };
    const button = elements('button, a, [role="button"]', scope).find(x => /^(?:закрыть|close)(?:\s+просмотр)?$/i.test(label(x)))
      || elements('.slider__close, .preview__close, .file-preview__close, .public-file-preview__close, [data-testid="close-preview"]', scope)[0];
    const before = snapshot();
    if (button) setTimeout(() => { if (!controller.signal.aborted) button.click(); }, 30);
    else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true }));
    return { before };
  }
  function arrow(direction) {
    const scope = viewer(); if (!scope) return null;
    const expression = direction === "next" ? /^(?:следующ(?:ий|ее|ая)(?: файл| фото| изображение| фотография)?|впер[её]д|next(?: file| image| photo)?)$/i
      : /^(?:предыдущ(?:ий|ее|ая)(?: файл| фото| изображение| фотография)?|назад|previous(?: file| image| photo)?)$/i;
    const selector = direction === "next" ? '.slider__arrow_right, .preview__next, [data-testid="next-file"]' : '.slider__arrow_left, .preview__prev, [data-testid="previous-file"]';
    return [...elements('button, a, [role="button"]', scope).filter(el => expression.test(label(el))), ...elements(selector, scope)]
      .find(el => !el.disabled && el.getAttribute("aria-disabled") !== "true") || null;
  }
  async function waitTitle(predicate) {
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      C.check(controller.signal);
      if (challenge()) throw new C.FatalError("На странице проверка «Я не робот». Пройдите её вручную.");
      const name = viewerTitle(); if (name && predicate(name)) return true;
      await C.delay(150, controller.signal);
    }
    return false;
  }
  async function refreshViewer(item) {
    C.check(controller.signal);
    if (!item?.image || viewerTitle() !== item.name) return { recovered: false };
    const direction = arrow("next") ? "next" : "previous", button = arrow(direction);
    if (!button) return { recovered: false };
    button.click();
    if (!await waitTitle(name => name !== item.name)) return { recovered: false };
    const back = arrow(direction === "next" ? "previous" : "next");
    if (!back) return { recovered: false };
    back.click();
    if (!await waitTitle(name => name === item.name)) return { recovered: false };
    await settled();
    return { recovered: viewerTitle() === item.name, name: viewerTitle() };
  }
  function diagnostics() {
    return { extension: "1.2.0", time: new Date().toISOString(), page: snapshot(),
      selectors: { rows: ROW, name: NAME, viewer: VIEWER, folder: FOLDER },
      cards: allRows().slice(0, 30).map(row => ({ tag: row.tagName, class: String(row.className), title: row.getAttribute("title"), text: row.textContent.trim().slice(0, 220) })),
      buttons: elements('button, [role="button"], a').slice(0, 100).map(el => ({ tag: el.tagName, label: label(el).slice(0, 100), class: String(el.className), disabled: !!el.disabled })) };
  }
  root.YDSite = { scan, open, clickDownload, picture, closeViewer, snapshot, settled, refreshViewer, diagnostics, stop, resume };
})(globalThis);
