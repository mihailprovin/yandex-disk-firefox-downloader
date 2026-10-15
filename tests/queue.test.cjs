"use strict";
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), assert = require("node:assert/strict");
const extension = path.resolve(__dirname, "../extension"), C = require(path.join(extension, "common.js"));
const first = "https://disk.yandex.ru/d/demo-share", second = "https://disk.yandex.ru/d/another";
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
const clone = value => JSON.parse(JSON.stringify(value));
function environment(options = {}) {
  const storage = options.storage || {}, records = options.records || new Map(), calls = [], blobs = new Map();
  let url = first, viewer = false, current = "", id = 100, now = 100000, opens = 0, reloads = 0, stopAfter = options.stopAfter || 0;
  const entries = options.names || ["photo.jpg"];
  const state = () => ({ url, viewer, viewerName: viewer ? current : "", rows: viewer ? 0 : entries.length, fingerprint: viewer ? "" : entries.join("|"), crumbs: "root", busy: false });
  const api = {
    runtime: { id: "yandex-disk-clicker@local.codex", onMessage: event() }, webRequest: { onBeforeRequest: event() },
    storage: { local: {
      async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => storage[key] !== undefined).map(key => [key, clone(storage[key])])); },
      async set(values) { if (options.storageFailure) throw new Error("Storage full"); Object.assign(storage, clone(values)); }
    } },
    tabs: { onRemoved: event(), async get() { return { id: 3, url, status: "complete" }; },
      async update(tab, values) { if (values.url) { url = values.url; viewer = false; calls.push(["navigate", url]); } return { id: 3, url }; },
      async reload() { reloads++; viewer = false; }, async goBack() { viewer = false; },
      async sendMessage(tab, message) {
        if (message.type !== "command") return undefined;
        if (message.name === "resume" || message.name === "stop") return { ok: true };
        if (message.name === "scan") return { ok: true, value: { url, single: false, entries: entries.map(name => ({ name, type: "file", image: true })) } };
        if (message.name === "open") { const before = state(); opens++; current = message.item.name;
          if (!(options.failFirstOpen && opens === 1) && current !== options.neverOpen) viewer = true;
          return { ok: true, value: { before } }; }
        if (message.name === "snapshot" || message.name === "settled") return { ok: true, value: state() };
        if (message.name === "refreshViewer") {
          if(options.arrowRecovery){viewer=true;if(options.wrongArrow)current='wrong.jpg';return{ok:true,value:{recovered:true}};}
          return { ok: true, value: { recovered: false } };
        }
        if (message.name === "closeViewer") { viewer = false; return { ok: true, value: { closed: true } }; }
        if (message.name === "clickDownload") {
          setTimeout(() => api.webRequest.onBeforeRequest.listeners[0]({ url: "https://downloader.disk.yandex.ru/disk/test?filename=" + current, tabId: 3, originUrl: url }), 0);
          return { ok: true, value: { clicked: true } };
        }
        throw new Error("Unexpected command: " + message.name);
      }
    },
    downloads: { onCreated: event(), async download(values) {
      if (values.filename.startsWith("YandexDisk-full-log-")) { calls.push(["export", values]); return ++id; }
      const record = { id: ++id, state: "complete", exists: true, filename: "C:/Downloads/" + values.filename, url: values.url };
      records.set(record.id, record); calls.push(["download", values.filename]); return record.id;
    }, async search(query) {
      const items = query.id !== undefined ? [records.get(query.id)].filter(Boolean) : [...records.values()].filter(item => new RegExp(query.filenameRegex).test(item.filename));
      if (stopAfter && items.some(item => item.state === "complete")) { stopAfter = 0; await send({ type: "stop" }); }
      return items.map(item => ({ ...item }));
    }, async cancel(id) { const record = records.get(id); if (record && record.state !== "complete") record.state = "interrupted"; } }
  };
  class Clock extends Date { static now() { return now; } }
  class ObjectURL extends URL { static createObjectURL(blob) { const key = "blob:moz-extension://test/" + blobs.size; blobs.set(key, blob); return key; } static revokeObjectURL() {} }
  const timers = new Set();
  const context = vm.createContext({ browser: api, URL: ObjectURL, Blob, AbortController, console, Date: Clock,
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms === 60000 ? 1 : ms); timers.add(timer); return timer; }, clearTimeout });
  for (const file of ["common.js", "background.js"]) vm.runInContext(fs.readFileSync(path.join(extension, file), "utf8"), context);
  context.YDCommon.delay = async (ms, signal) => { context.YDCommon.check(signal); now += ms; calls.push(["delay", ms]); await new Promise(resolve => setTimeout(resolve, 0)); context.YDCommon.check(signal); };
  const send = message => api.runtime.onMessage.listeners[0]({ channel: "yd-clicker", ...message }, { tab: { id: 3, url } });
  async function finish() { for (let i = 0; i < 2000; i++) { const status = await send({ type: "getStatus" }); if (!status.running) return status; await new Promise(resolve => setTimeout(resolve, 1)); } throw new Error("Queue did not finish"); }
  return { context, api, storage, records, calls, blobs, send, finish, reloads: () => reloads, dispose() { timers.forEach(clearTimeout); } };
}
(async () => {
  assert.deepEqual(C.links(first + "\n\n" + first + "\n" + second), [first, second]);
  assert.throws(() => C.links(first + "\nhttps://example.org"));
  const credentialLink = new URL(first); credentialLink.username = "example"; assert.throws(() => C.links(credentialLink.href));
  assert.equal(C.rootKey(first), C.rootKey("https://disk.360.yandex.ru/client/aa/d_demo-share/"));
  assert.notEqual(C.rootKey(first), C.rootKey(first + "/nested"));
  assert.equal(C.pause("2,5"), 2500); assert.equal(C.pause(0), 0); assert.throws(() => C.pause(-1)); assert.throws(() => C.pause("wrong"));
  console.log("PASS: multiple public links, de-duplication, canonical identity and configurable pause validation");
  const env = environment();
  assert((await env.send({ type: "start", urls: first + "\n" + second, prefix: "Photos", pauseSeconds: 2.5 })).ok);
  const done = await env.finish(); assert.equal(done.counts.originals, 2);
  const paths = env.calls.filter(call => call[0] === "download").map(call => call[1]);
  assert.equal(paths.length, 2); assert.notEqual(paths[0], paths[1]); assert(env.calls.some(call => call[0] === "delay" && call[1] === 2500));
  const resumed = environment({ storage: env.storage, records: env.records });
  const originalSession = env.storage['yd-clicker-journal'].sessionId, originalLogCount = env.storage['yd-clicker-journal'].count;
  assert((await resumed.send({ type: "resumeQueue" })).ok); const resumedStatus = await resumed.finish();
  assert.equal(resumedStatus.counts.skipped, 2); assert.equal(resumed.calls.filter(call => call[0] === "download").length, 0);
  assert.equal(env.storage['yd-clicker-journal'].sessionId, originalSession); assert(env.storage['yd-clicker-journal'].count > originalLogCount);
  console.log("PASS: two links use distinct stable folders; resume after background restart skips saved files");
  const removed = [...resumed.records.values()][0]; removed.exists = false;
  assert((await resumed.send({ type: "resumeQueue" })).ok); const retried = await resumed.finish();
  assert.equal(retried.counts.originals, 1); assert.equal(retried.counts.skipped, 1);
  console.log("PASS: a file deleted from disk is downloaded again, not silently skipped");
  const changedRecord = [...resumed.records.values()].find(item => item.exists);
  resumed.records.delete(changedRecord.id); changedRecord.id = 999; resumed.records.set(changedRecord.id, changedRecord);
  const changedID = environment({ storage: resumed.storage, records: resumed.records });
  assert((await changedID.send({ type: 'resumeQueue' })).ok);assert.equal((await changedID.finish()).counts.skipped,2);
  assert.equal(changedID.calls.filter(call=>call[0]==='download').length,0);
  console.log('PASS: changed Firefox download IDs are resolved by the exact saved filename');
  const legacyPath='C:/Downloads/Legacy/photo.jpg';
  const legacy=environment({storage:{'yd-clicker-completed':{[JSON.stringify([first,'Legacy',[],'photo.jpg'])]:{downloadId:1,filename:legacyPath,preview:false}}},
    records:new Map([[1,{id:1,state:'complete',exists:true,filename:legacyPath}]])});
  assert((await legacy.send({type:'start',prefix:'Legacy'})).ok);assert.equal((await legacy.finish()).counts.skipped,1);
  console.log('PASS: completed-file records from 1.1.1 are migrated without re-downloading');
  const recover = environment({ failFirstOpen: true });
  assert((await recover.send({ type: "start", prefix: "Recovery" })).ok); const recovered = await recover.finish();
  assert.equal(recovered.counts.originals, 1); assert.equal(recover.reloads(), 1); assert.equal(recovered.counts.errors, 0);
  console.log("PASS: unconfirmed viewer transition reloads the folder once and retries the same file");
  const arrow = environment({failFirstOpen:true,arrowRecovery:true});
  assert((await arrow.send({type:'start',prefix:'Arrows'})).ok);assert.equal((await arrow.finish()).counts.originals,1);assert.equal(arrow.reloads(),0);
  const wrongArrow = environment({failFirstOpen:true,arrowRecovery:true,wrongArrow:true});
  assert((await wrongArrow.send({type:'start',prefix:'Arrows'})).ok);assert.equal((await wrongArrow.finish()).counts.originals,1);assert.equal(wrongArrow.reloads(),1);
  console.log('PASS: arrow recovery is accepted only for the requested filename; a neighbor forces folder recovery');
  const failed = environment({ names: ["broken.jpg", "good.jpg"], neverOpen: "broken.jpg" });
  assert((await failed.send({ type: "start", prefix: "Recovery" })).ok); const afterFailure = await failed.finish();
  assert.equal(afterFailure.counts.errors, 1); assert.equal(afterFailure.counts.originals, 1); assert.equal(failed.reloads(), 1);
  console.log("PASS: bounded recovery of an unreadable card does not trap the queue or save its neighbor");
  const stopped = environment({ names: ["a.jpg", "b.jpg"], stopAfter: 1 });
  assert((await stopped.send({ type: "start", prefix: "Stop", pauseSeconds: 0 })).ok); await stopped.finish();
  const restart = environment({ names: ["a.jpg", "b.jpg"], storage: stopped.storage, records: stopped.records });
  assert((await restart.send({ type: "resumeQueue" })).ok); const continued = await restart.finish();
  assert.equal(continued.counts.skipped, 1); assert.equal(continued.counts.originals, 1);
  console.log("PASS: stop persists the queue and completed file before continuing after restart");
  const journal = environment();
  journal.context.journalJob = { tabId: 3, controller: new AbortController(), logs: [], sessionId: "journal-test", logCount: 0, counts: {}, journalChunk: [], stateWrites: Promise.resolve() };
  vm.runInContext('for (let i = 1; i <= 650; i++) log(journalJob, "record-" + i);', journal.context);
  await journal.context.journalJob.stateWrites;
  assert.equal(journal.context.journalJob.logs.length, 150);
  assert((await journal.send({ type: "exportLog" })).ok);
  const exported = await [...journal.blobs.values()].at(-1).text();
  assert.equal(exported.trim().split(/\r?\n/).length, 650); assert(exported.includes("record-1\r\n")); assert(exported.includes("record-650\r\n"));
  const journalRestart = environment({ storage: journal.storage }); assert((await journalRestart.send({ type: "exportLog" })).ok);
  assert.equal(await [...journalRestart.blobs.values()].at(-1).text(), exported);
  console.log("PASS: all 650 journal lines export intact, including after background restart; only UI is paged");
  const diskFull = environment({ storageFailure: true }); const rejected = await diskFull.send({ type: "start" }); assert.equal(rejected.ok, false);
  assert.equal((await diskFull.send({ type: "getStatus" })).running, false);
  console.log("PASS: failed progress/journal persistence prevents running an untracked queue");
  for (const instance of [env, resumed, changedID, legacy, recover, arrow, wrongArrow, failed, stopped, restart, journal, journalRestart, diskFull]) instance.dispose();
  console.log("ALL QUEUE, JOURNAL AND RECOVERY TESTS PASSED");
})().catch(error => { console.error(error); process.exitCode = 1; });
