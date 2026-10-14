"use strict";
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.YD_PLAYWRIGHT_MODULE || 'playwright');
const ext = path.resolve(__dirname, '../extension');
const artifacts = path.resolve(__dirname, '../test-artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const common = require(path.join(ext, 'common.js'));
function pass(text) { console.log('PASS: ' + text); }
function event() { const listeners=[]; return {listeners,addListener(fn){listeners.push(fn);},removeListener(fn){const i=listeners.indexOf(fn);if(i>=0)listeners.splice(i,1);}}; }
const delay=ms=>new Promise(r=>setTimeout(r,ms));

(async()=>{
  assert.equal(common.publicKey('https://disk.yandex.ru/d/abc/nested?x=1'), 'https://disk.yandex.ru/d/abc');
  assert.equal(common.publicKey('https://example.com/d/abc'), null);
  assert.equal(common.publicKey('https://disk.360.yandex.ru/client/aa/d_demo-share/'), 'https://disk.yandex.ru/d/demo-share');
  assert.equal(common.publicKey('https://disk.360.yandex.ru/client/aa/d_demo-share/nested?path=1'), 'https://disk.yandex.ru/d/demo-share');
  assert.equal(common.publicKey('https://disk.360.yandex.ru/client/disk'), null);
  assert.equal(common.publicKey('https://disk.360.yandex.ru.evil.example/client/aa/d_demo-share'), null);
  assert.equal(common.allowedAsset('https://yandex.ru.evil.example/x'), false);
  assert.throws(()=>common.relativeRoot('../outside'));
  assert.throws(()=>common.relativeRoot('C:\\outside'));
  assert.equal(common.filePath('Result',['nested'],'photo.jpg',true),'Result/nested/photo_preview.png');
  assert.match(common.safeName('CON.txt'),/^_/); pass('public links, asset domains, Windows names and safe relative paths');
  const manifest = JSON.parse(fs.readFileSync(path.join(ext,'manifest.json'),'utf8'));
  assert.equal(manifest.manifest_version,2); assert(manifest.permissions.includes('webRequestBlocking'));
  for(const script of [...manifest.background.scripts,...manifest.content_scripts[0].js,'popup.js']) assert(fs.existsSync(path.join(ext,script)));
  pass('Firefox manifest and all packaged script references');

  const browser = await chromium.launch({executablePath:process.env.YD_BROWSER_EXECUTABLE||undefined,headless:true,chromiumSandbox:true,ignoreDefaultArgs:['--unsafely-disable-devtools-self-xss-warnings','--disable-client-side-phishing-detection'],args:['--no-proxy-server'],env:{...process.env,TEMP:artifacts,TMP:artifacts}});
  try {
    const ctx = await browser.newContext({viewport:{width:1100,height:920}}), page = await ctx.newPage();
    const source=fs.readFileSync(path.join(__dirname,'fixture.html'),'utf8');
    await page.route('https://disk.yandex.ru/**',route=>route.fulfill({contentType:'text/html',body:source}));
    await page.route('https://disk.360.yandex.ru/**',route=>route.fulfill({contentType:'text/html',body:source.replaceAll('/d/fixture','/client/aa/d_fixture')}));
    const storage={}, items=new Map(), starts=[], ends=[], commands=[];
    let nextId=1, concurrent=0,maxConcurrent=0, slow=false, stopOnDownload=false, suppressPhoto=false, stallPhoto=false, bgContext;
    const fake={
      runtime:{onMessage:event()},
      webRequest:{onBeforeRequest:event()},
      tabs:{onRemoved:event(),async get(){return {id:7,url:page.url()};},async goBack(){await page.goBack();},async sendMessage(id,msg){
        if(msg.type==='command') commands.push(msg.name);
        return page.evaluate(async m=>{let result;for(const fn of globalThis.testContentListeners||[]){const value=await fn(m);if(value!==undefined)result=value;}return result;},msg);
      }},
      storage:{local:{async get(key){return {[key]:storage[key]};},async set(obj){Object.assign(storage,obj);}}},
      downloads:{onCreated:event(),async search(query){const item=items.get(query.id);return item?[{...item}]:[];},async cancel(id){const item=items.get(id);if(item?.state==='in_progress'){item.state='interrupted';item.error='USER_CANCELED';concurrent--;clearTimeout(item.timer);}},async download(options){
        const id=nextId++, item={id,url:options.url,filename:'C:/Downloads/'+options.filename,state:'in_progress',bytesReceived:0,exists:true,byExtensionId:'test-extension'};
        items.set(id,item);starts.push({id,time:Date.now(),filename:options.filename});concurrent++;maxConcurrent=Math.max(maxConcurrent,concurrent);
        item.timer=setTimeout(()=>{if(item.state==='in_progress'){item.state='complete';item.bytesReceived=100;concurrent--;ends.push({id,time:Date.now()});}},slow||(stallPhoto&&options.filename.endsWith('/photo.jpg'))?10000:120);
        for(const fn of fake.downloads.onCreated.listeners)fn(item);
        if(stopOnDownload)setTimeout(()=>background({channel:'yd-clicker',type:'stop'}),20);
        return id;
      }}
    };
    async function background(msg){return fake.runtime.onMessage.listeners[0](msg,{tab:{id:7,url:page.url()}});}
    const TestURL=class extends URL{static createObjectURL(){return 'blob:moz-extension://test/png';}static revokeObjectURL(){}};
    bgContext=vm.createContext({browser:fake,console,URL:TestURL,AbortController,Blob,fetch,setTimeout,clearTimeout,Date});
    vm.runInContext(fs.readFileSync(path.join(ext,'common.js'),'utf8'),bgContext);
    vm.runInContext(fs.readFileSync(path.join(ext,'background.js'),'utf8'),bgContext);
    bgContext.testPNG=async blob=>{
      const input=Buffer.from(await blob.arrayBuffer()).toString('base64');
      const data=await page.evaluate(async base64=>{const image=await createImageBitmap(await(await fetch('data:image/png;base64,'+base64)).blob());const c=document.createElement('canvas');c.width=image.width;c.height=image.height;c.getContext('2d').drawImage(image,0,0);image.close();return c.toDataURL('image/png');},input);
      const bytes=Buffer.from(data.split(',')[1],'base64');assert.deepEqual([...bytes.subarray(0,4)],[137,80,78,71]);
      return new Blob([bytes],{type:'image/png'});
    };
    vm.runInContext('blobToPNG = testPNG;',bgContext); // Use real browser canvas instead of a fake Node canvas.
    await page.exposeFunction('_ydSend',background);
    await page.exposeFunction('_ydRequest',async url=>{
      if(suppressPhoto&&new URL(url).searchParams.get('filename')==='photo.jpg')return true;
      const results=fake.webRequest.onBeforeRequest.listeners.map(fn=>fn({url,tabId:7,originUrl:page.url(),method:'GET',type:'main_frame'}));
      assert(results.some(r=>r.cancel),'website attachment should be captured');return true;
    });
    async function load(client360=false){
      await page.goto(client360?'https://disk.360.yandex.ru/client/aa/d_fixture':'https://disk.yandex.ru/d/fixture');
      await page.evaluate(()=>{
        globalThis.testContentListeners=[];
        globalThis.browser={runtime:{onMessage:{addListener(fn){testContentListeners.push(fn);}},sendMessage:msg=>window._ydSend(msg)},storage:{local:{async get(){return {};},async set(){}}}};
      });
      for(const file of ['common.js','site.js','content.js'])await page.addScriptTag({path:path.join(ext,file)});
    }
    async function finished(){
      const until=Date.now()+120000;
      while(Date.now()<until){const s=await background({channel:'yd-clicker',type:'getStatus'});if(!s.running)return s;await delay(100);}
      throw new Error('Timed out waiting for job');
    }
    await load();
    const scan=await page.evaluate(()=>YDSite.scan());
    assert.equal(scan.entries.length,5); assert.equal(scan.entries.filter(x=>x.type==='folder').length,1);
    pass('real DOM adapter reads file cards and explicit folder icons');
    await page.evaluate(()=>YDClickerPanel.show());
    await page.screenshot({path:path.join(artifacts,'browser-preview.png')});
    await page.locator('#yd-clicker-host').screenshot({path:path.resolve(__dirname,'../docs/panel.png')});
    const result=await background({channel:'yd-clicker',type:'start',prefix:'Result',fallback:true});assert(result.ok);
    const end=await finished();
    assert.equal(end.counts.originals,3);assert.equal(end.counts.previews,1);assert.equal(end.counts.errors,1);
    assert.equal(maxConcurrent,1);assert.equal(await page.evaluate(()=>wholeClicked),false);
    assert(starts.some(x=>x.filename==='Result/nested/b.txt'));assert(starts.some(x=>x.filename==='Result/unknown-folder/c.txt'));assert(starts.some(x=>x.filename==='Result/photo_preview.png'));
    assert(commands.includes('open')&&commands.includes('clickDownload')&&commands.includes('picture')&&commands.includes('closeViewer'));
    for(let i=1;i<starts.length;i++){const previous=ends.find(x=>x.id===starts[i-1].id);assert(starts[i].time-previous.time>=990);}
    pass('website double-clicks, nested/empty folders, unknown folder detection and back navigation');
    pass('three originals, real PNG from viewer, unavailable non-image logged and skipped');
    pass('one active download at a time and minimum one-second interval after completion');
    pass('folder-wide Download all button never clicked');
    const before=starts.length;await load();
    await background({channel:'yd-clicker',type:'start',prefix:'Result',fallback:true});
    const resumed=await finished();assert.equal(resumed.counts.skipped,4);assert.equal(starts.length,before);assert.equal(resumed.counts.errors,1);
    pass('resume uses Firefox completed-download records and skips saved originals/previews');

    await load();slow=true;stopOnDownload=true;
    await background({channel:'yd-clicker',type:'start',prefix:'StopTest',fallback:true});
    const stopped=await finished();assert.equal(starts.length,before+1);assert.equal(concurrent,0);assert.match(stopped.text,/Остановлено/);
    pass('stop cancels the active download and prevents the next file');
    slow=false;stopOnDownload=false;

    bgContext.testJob={tabId:7,share:'https://disk.yandex.ru/d/fixture',controller:new AbortController()};
    const capture=vm.runInContext("armCapture(testJob,{name:'x.txt'})",bgContext);
    const listener=fake.webRequest.onBeforeRequest.listeners[0],url='https://downloader.disk.yandex.ru/disk/test?filename=x.txt';
    assert.equal(listener({url,tabId:8,originUrl:'https://disk.yandex.ru/d/fixture'}).cancel,undefined);
    assert.equal(listener({url:'https://downloader.disk.yandex.ru/disk/test?filename=other.txt',tabId:7}).cancel,undefined);
    assert.equal(listener({url,tabId:7}).cancel,true);assert.equal((await capture.promise).url,url);
    pass('request capture ignores other tabs and other filenames');
    const abortCapture=vm.runInContext("armCapture(testJob,{name:'y.txt'})",bgContext);
    bgContext.testJob.controller.abort();await assert.rejects(abortCapture.promise,/Остановлено/);
    pass('pending website click is canceled cleanly on stop');
    bgContext.testJob.controller=new AbortController();
    const normalTimeout=bgContext.setTimeout;bgContext.setTimeout=(fn,ms)=>setTimeout(fn,ms===3000?20:ms);
    const noStart=vm.runInContext("armCapture(testJob,{name:'never-started.txt'})",bgContext);
    await assert.rejects(noStart.promise,e=>e.name==='FileTimeout'&&/3 секунды/.test(e.message));bgContext.setTimeout=normalTimeout;
    pass('unconfirmed original start returns a three-second per-file timeout for fallback handling');

    await load();
    const originalGet=fake.tabs.get, originalBack=fake.tabs.goBack;let backCalls=0;
    fake.tabs.get=async()=>({url});fake.tabs.goBack=async()=>{backCalls++;};
    await vm.runInContext(`restoreAfterAttachment(testJob,${JSON.stringify(url)})`,bgContext);
    assert.equal(backCalls,1);
    fake.tabs.get=async()=>({url:'https://example.org/user-navigation'});
    await assert.rejects(vm.runInContext(`restoreAfterAttachment(testJob,${JSON.stringify(url)})`,bgContext),e=>e.name==='FatalError');
    assert.equal(backCalls,1);fake.tabs.get=originalGet;fake.tabs.goBack=originalBack;
    pass('known attachment navigation recovery and refusal to navigate an unrelated page');

    await load(true);
    assert.equal(await page.locator('#yd-clicker-host').evaluate(el=>el.style.display),'block');
    await page.evaluate(()=>{tree['']=tree[''].slice(0,1);render();});
    const aliasStart=starts.length;
    assert((await background({channel:'yd-clicker',type:'start',prefix:'Client360',fallback:true})).ok);
    const aliasDone=await finished();assert.equal(aliasDone.counts.originals,1);assert.equal(aliasDone.counts.errors,0);assert.equal(starts.length,aliasStart+1);
    pass('360 shared-client URL automatically shows panel and completes a website-click download');

    for(const mode of ['no-start','stalled']){
      await load();
      await page.evaluate(()=>{const photo=tree[''].find(x=>x.name==='photo.jpg');photo.blocked=false;tree['']=[photo];render();});
      suppressPhoto=mode==='no-start';stallPhoto=mode==='stalled';
      const photoStart=starts.length;
      await background({channel:'yd-clicker',type:'start',prefix:'Photo-'+mode,fallback:true});
      const photoDone=await finished();
      assert.equal(photoDone.counts.previews,1);assert.equal(photoDone.counts.originals,0);assert.equal(photoDone.counts.errors,0);
      assert.equal(starts.at(-1).filename,'Photo-'+mode+'/photo_preview.png');
      if(mode==='stalled')assert.equal(items.get(starts[photoStart].id).state,'interrupted');
      assert.equal(concurrent,0);
      pass('real viewer PNG saved after '+mode+' original timeout, with no skipped image');
    }
    suppressPhoto=false;stallPhoto=false;

    await load();
    await page.evaluate(()=>{
      const listing=document.querySelector('.listing');listing.innerHTML='';listing.style.cssText='display:block;position:relative;height:220px;overflow:auto;width:240px';
      const spacer=document.createElement('div');spacer.style.height='3000px';listing.appendChild(spacer);
      const renderRows=()=>{
        listing.querySelectorAll('.listing-item').forEach(x=>x.remove());const from=Math.floor(listing.scrollTop/50);
        for(let i=from;i<Math.min(60,from+7);i++){const row=document.createElement('div');row.className='listing-item';row.style.cssText='position:absolute;top:'+(i*50)+'px;height:45px;width:200px;padding:4px';row.innerHTML='<div class="listing-item__title">virtual-'+i+'.txt</div>';listing.appendChild(row);}
      };listing.addEventListener('scroll',renderRows);renderRows();
    });
    const virtual=await page.evaluate(()=>YDSite.scan());assert.equal(virtual.entries.length,60);
    pass('virtual scrolling discovers all 60 cards, including off-screen files');
    await page.evaluate(()=>setTimeout(()=>YDSite.stop(),40));
    await assert.rejects(page.evaluate(()=>YDSite.scan()),/Остановлено/);
    pass('stop interrupts a long DOM scan');
    assert(!fs.readFileSync(path.join(ext,'background.js'),'utf8').includes('cloud-api.yandex.net'));
    pass('originals come from website clicks; extension never calls the public REST API');
    console.log('ALL FIREFOX CLICKER TESTS PASSED');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
