/* Shared helpers; no calls to the public Disk API. */
(function (root) {
  "use strict";
  const publicHosts = new Set(["disk.yandex.ru", "disk.yandex.com", "disk.yandex.kz", "disk.yandex.by", "disk.yandex.com.tr", "yadi.sk"]);
  const imageExtensions = /\.(?:jpe?g|png|gif|webp|bmp|tiff?|heic|avif|svg)$/i;
  function publicKey(url) {
    try {
      const u = new URL(url), parts = u.pathname.split("/").filter(Boolean);
      const host = u.hostname.replace(/^disk\.360\./, "disk.");
      if (u.protocol !== "https:" || u.username || u.password || u.port || !publicHosts.has(host)) return null;
      let kind, code;
      if (/^[di]$/.test(parts[0]) && parts[1]) { kind = parts[0]; code = parts[1]; }
      else if (parts[0] === "client" && parts[1] === "aa" && parts[2]) {
        const match = decodeURIComponent(parts[2]).match(/^([di])_([A-Za-z0-9_-]+)(?::|$)/);
        if (!match) return null;
        kind = match[1]; code = match[2];
      } else return null;
      // The authenticated 360 UI and the public URL identify the same shared folder.
      return `https://disk.yandex.ru/${kind}/${code}`;
    } catch (_) { return null; }
  }
  function hash(text) {
    let h = 2166136261;
    for (const char of text) { h ^= char.codePointAt(0); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16).padStart(8, "0");
  }
  function links(text) {
    const lines = Array.isArray(text) ? text : String(text || "").split(/\r?\n/);
    const found = new Set(), result = [];
    for (const line of lines) {
      const value = String(line).trim(); if (!value) continue;
      if (!publicKey(value)) throw new Error("Недопустимая публичная ссылка в строке " + (lines.indexOf(line) + 1));
      const u = new URL(value); u.hash = "";
      const identity = rootKey(u.href);
      if (!found.has(identity)) { found.add(identity); result.push(u.href); }
    }
    return result;
  }
  function rootKey(url) {
    const share = publicKey(url); if (!share) return null;
    const u = new URL(url), parts = u.pathname.split("/").filter(Boolean);
    const client = parts[0] === "client";
    let suffix = parts.slice(client ? 3 : 2).map(decodeURIComponent).join("/");
    if (client && parts[2]?.includes(":")) suffix = decodeURIComponent(parts[2]).split(":").slice(1).join(":") + "/" + suffix;
    const queryPath = u.searchParams.get("path");
    if (queryPath) suffix = queryPath;
    return share + "/" + suffix.replace(/^\/+|\/+$/g, "");
  }
  function pause(value) {
    const seconds = value === undefined || value === "" ? 1 : Number(String(value).replace(",", "."));
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) throw new Error("Пауза должна быть от 0 до 3600 секунд.");
    return Math.round(seconds * 1000);
  }
  function safeName(text) {
    const original = String(text || "Без имени");
    let name = original.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "") || "_";
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
    if (name.length > 120) name = name.slice(0, 105);
    if (name !== original) {
      const dot = name.lastIndexOf("."), ext = dot > 0 && name.length - dot < 15 ? name.slice(dot) : "";
      name = (ext ? name.slice(0, -ext.length) : name) + "_" + hash(original) + ext;
    }
    return name;
  }
  function relativeRoot(text) {
    text = String(text || "Яндекс-Диск").trim().replace(/\\/g, "/");
    if (/^(?:\/|[a-z]:)/i.test(text) || text.split("/").some(x => x === "." || x === "..")) throw new Error("Укажите имя подпапки внутри Загрузок, например Яндекс-Диск. Абсолютный путь здесь не поддерживается.");
    return text.split("/").filter(Boolean).map(safeName).join("/") || "Яндекс-Диск";
  }
  function filePath(prefix, path, name, preview = false) {
    const folders = path.map(safeName);
    name = safeName(name);
    if (preview) name = name.replace(/\.[^.]+$/, "") + "_preview.png";
    return [relativeRoot(prefix), ...folders, name].join("/");
  }
  function allowedAsset(url) {
    try {
      const u = new URL(url);
      return u.protocol === "https:" && /(?:^|\.)(?:yandex\.(?:ru|net|com|kz|by|com\.tr)|yandexusercontent\.com|yandexcloud\.net)$/.test(u.hostname);
    } catch (_) { return false; }
  }
  function isAttachment(url) {
    if (!allowedAsset(url)) return false;
    const u = new URL(url);
    return /(?:^|\.)downloader\.(?:disk|dst)\.yandex\./.test(u.hostname)
      || (u.searchParams.get("disposition") === "attachment" && !!u.searchParams.get("filename"));
  }
  function sameFile(url, name) {
    try { const filename = new URL(url).searchParams.get("filename"); return !filename || filename === name; } catch (_) { return false; }
  }
  function abortError() { const e = new Error("Остановлено"); e.name = "AbortError"; return e; }
  function check(signal) { if (signal && signal.aborted) throw abortError(); }
  function delay(ms, signal) {
    check(signal);
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); if (signal) signal.removeEventListener("abort", cancel); resolve(); };
      const cancel = () => { clearTimeout(timer); if (signal) signal.removeEventListener("abort", cancel); reject(abortError()); };
      const timer = setTimeout(done, ms);
      if (signal) signal.addEventListener("abort", cancel, { once: true });
    });
  }
  class FatalError extends Error { constructor(message) { super(message); this.name = "FatalError"; } }
  class NavigationError extends Error { constructor(message) { super(message); this.name = "NavigationError"; } }
  root.YDCommon = { publicKey, rootKey, links, pause, hash, safeName, relativeRoot, filePath, allowedAsset, isAttachment, sameFile, imageExtensions, abortError, check, delay, FatalError, NavigationError };
  if (typeof module !== "undefined" && module.exports) module.exports = root.YDCommon;
})(typeof globalThis !== "undefined" ? globalThis : this);
