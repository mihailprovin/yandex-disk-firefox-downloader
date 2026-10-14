"use strict";
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const ext=path.resolve(__dirname,'../extension');
function event(){return{listeners:[],addListener(fn){this.listeners.push(fn);}};}
const share='https://disk.yandex.ru/d/timeout-test';
(async()=>{
  let clock=100000,current=null,viewer=false,id=0,context;
  const files=['never-starts.jpg','stalled.jpg','paused.txt','keeps-moving.txt','good.txt'];
  const records=new Map(),storage={},canceled=[],pictureCalls=[],downloadCalls=[];
  const fake={runtime:{id:'yandex-disk-clicker@local.codex',onMessage:event()},webRequest:{onBeforeRequest:event()},tabs:{onRemoved:event(),
    async get(){return{id:9,url:share};},async goBack(){viewer=false;},async sendMessage(tab,msg){
      if(msg.type==='status')return;
      if(msg.name==='resume'||msg.name==='stop')return{ok:true};
      const state=()=>({url:share,viewer,rows:viewer?0:files.length,fingerprint:viewer?'':files.join('|'),crumbs:'root',busy:false});
      if(msg.name==='scan')return{ok:true,value:{url:share,single:false,entries:files.map(name=>({name,type:'file',key:'file:'+name,image:name.endsWith('.jpg')}))}};
      if(msg.name==='open'){const before=state();current=msg.item.name;viewer=true;return{ok:true,value:{before}};}
      if(msg.name==='snapshot'||msg.name==='settled')return{ok:true,value:state()};
      if(msg.name==='closeViewer'){viewer=false;return{ok:true,value:{closed:true}};}
      if(msg.name==='picture'){pictureCalls.push(current);return{ok:true,value:{data:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII='}};}
      if(msg.name==='clickDownload'){
        if(current!=='never-starts.jpg')setTimeout(()=>fake.webRequest.onBeforeRequest.listeners[0]({url:'https://downloader.disk.yandex.ru/disk/test?filename='+current,tabId:9,originUrl:share,type:'main_frame'}),0);
        return{ok:true,value:{clicked:true}};
      }
      throw new Error('Unknown '+msg.name);
    }},storage:{local:{async get(key){return{[key]:storage[key]};},async set(obj){Object.assign(storage,obj);}}},
    downloads:{onCreated:event(),async download(opts){
      const record={id:++id,name:opts.filename.split('/').pop(),state:'in_progress',bytesReceived:0,url:opts.url,filename:opts.filename,exists:true,start:clock};
      records.set(record.id,record);downloadCalls.push(record.name);return record.id;
    },async search({id}){
      const item=records.get(id);if(!item)return[];
      if(item.state==='in_progress'){
        if(item.name==='good.txt'||item.name.endsWith('_preview.png'))item.state='complete';
        if(item.name==='stalled.jpg')item.bytesReceived=128;
        if(item.name==='paused.txt')item.paused=true;
        if(item.name==='keeps-moving.txt'){
          item.bytesReceived=Math.floor((clock-item.start)/1000)*100;
          if(clock-item.start>=12000)item.state='complete';
        }
      }
      return[{...item}];
    },async cancel(id){const item=records.get(id);if(item&&item.state==='in_progress'){item.state='interrupted';canceled.push({id,name:item.name,elapsed:clock-item.start});}}}
  };
  class ClockDate extends Date{static now(){return clock;}}
  function timer(fn,ms){return setTimeout(()=>{if(ms===3000)clock+=3000;fn();},ms===3000?20:ms);}
  class PreviewURL extends URL{static createObjectURL(){return'blob:moz-extension://timeout-test/preview-'+id;}static revokeObjectURL(){}}
  context=vm.createContext({browser:fake,console,URL:PreviewURL,AbortController,Blob,fetch,setTimeout:timer,clearTimeout,Date:ClockDate});
  for(const file of['common.js','background.js'])vm.runInContext(fs.readFileSync(path.join(ext,file),'utf8'),context);
  vm.runInContext('blobToPNG = async blob => blob;',context);
  context.YDCommon.delay=async(ms,signal)=>{context.YDCommon.check(signal);clock+=ms;await new Promise(resolve=>setTimeout(resolve,0));context.YDCommon.check(signal);};
  const send=msg=>fake.runtime.onMessage.listeners[0]({channel:'yd-clicker',...msg},{tab:{id:9,url:share}});
  assert((await send({type:'start',prefix:'Timeouts',fallback:true})).ok);
  let result;
  for(let i=0;i<1000;i++){result=await send({type:'getStatus'});if(!result.running)break;await new Promise(resolve=>setTimeout(resolve,2));}
  assert.equal(result.running,false);assert.equal(result.counts.originals,2);assert.equal(result.counts.errors,1);assert.equal(result.counts.previews,2);
  assert.deepEqual(downloadCalls,['never-starts_preview.png','stalled.jpg','stalled_preview.png','paused.txt','keeps-moving.txt','good.txt']);
  assert.deepEqual(pictureCalls,['never-starts.jpg','stalled.jpg']);
  assert(canceled.some(x=>x.name==='stalled.jpg'&&x.elapsed===3000));assert(canceled.some(x=>x.name==='paused.txt'&&x.elapsed===3000));
  assert(!canceled.some(x=>x.name==='keeps-moving.txt'));
  console.log('PASS: no-start and stalled image originals are replaced with PNG from the viewer before continuing');
  console.log('PASS: frozen bytes and paused download canceled at 3 seconds, then next file runs');
  console.log('PASS: 12-second download with continuing byte growth is not canceled');
  assert.equal(Object.keys(storage['yd-clicker-completed']).length,4);
  assert.equal(Object.values(storage['yd-clicker-completed']).filter(x=>x.preview).length,2);
  console.log('PASS: saved fallback PNGs are remembered; failed original and paused non-image are not marked successful');
  const late=fake.webRequest.onBeforeRequest.listeners[0]({url:'https://downloader.disk.yandex.ru/disk/test?filename=never-starts.jpg',tabId:9,originUrl:share,type:'main_frame'});
  assert.equal(late.cancel,true);
  const other=fake.webRequest.onBeforeRequest.listeners[0]({url:'https://downloader.disk.yandex.ru/disk/test?filename=never-starts.jpg',tabId:10,originUrl:share,type:'main_frame'});
  assert.equal(other.cancel,undefined);
  console.log('PASS: late timed-out click is blocked; another tab is left alone');
  const peer={id:100,state:'in_progress',name:'other-extension',url:'https://downloader.disk.yandex.ru/disk/test?filename=stalled.jpg',byExtensionId:'other-extension',start:clock};records.set(peer.id,peer);
  fake.downloads.onCreated.listeners[0](peer);assert.equal(peer.state,'in_progress');
  console.log('PASS: a download owned by another extension is not canceled');

  const normalDownload=fake.downloads.download;
  fake.downloads.download=async()=>{await new Promise(resolve=>setTimeout(resolve,60));const item={id:++id,state:'in_progress',name:'delayed.txt',url:'https://downloader.disk.yandex.ru/disk/delayed?filename=delayed.txt',start:clock};records.set(item.id,item);return item.id;};
  context.testJob={tabId:9,share,controller:new AbortController()};
  await assert.rejects(vm.runInContext("download(testJob,'https://downloader.disk.yandex.ru/disk/delayed?filename=delayed.txt','Timeouts/delayed.txt')",context),e=>e.name==='FileTimeout');
  await new Promise(resolve=>setTimeout(resolve,80));assert(canceled.some(x=>x.name==='delayed.txt'));
  console.log('PASS: delayed Firefox download creation times out and its late ID is canceled');
  fake.downloads.download=normalDownload;
  const normalCommand=fake.tabs.sendMessage;
  fake.tabs.sendMessage=async(tab,msg)=>msg.name==='picture'?{ok:true,value:{url:'https://avatars.mds.yandex.net/test-preview'}}:normalCommand(tab,msg);
  vm.runInContext('blobToPNG = async blob => blob;',context);
  context.fetch=async(url,opts)=>new Response(new ReadableStream({start(controller){
    opts.signal.addEventListener('abort',()=>{const error=new Error('Idle preview');error.name='AbortError';controller.error(error);},{once:true});
  }}),{headers:{'content-type':'image/png'}});
  await assert.rejects(vm.runInContext("savePicture(testJob,'Timeouts/good.txt')",context),e=>e.name==='FileTimeout');
  console.log('PASS: preview response with no incoming body bytes is aborted after 3 seconds');
  context.URL=class extends URL{static createObjectURL(){return'blob:moz-extension://timeout-test/preview';}static revokeObjectURL(){}};
  context.fetch=async(url,opts)=>new Response(new ReadableStream({start(controller){
    let received=0;const push=()=>{if(opts.signal.aborted)return;controller.enqueue(new Uint8Array([1,2,3]));if(++received>=18)controller.close();else setTimeout(push,3);};setTimeout(push,3);
    opts.signal.addEventListener('abort',()=>{const error=new Error('Unexpected abort');error.name='AbortError';controller.error(error);},{once:true});
  }}),{headers:{'content-type':'image/png'}});
  const preview=await vm.runInContext("savePicture(testJob,'Timeouts/good.txt')",context);assert.equal(preview.state,'complete');
  console.log('PASS: continued preview byte chunks reset the idle timer, allowing a longer transfer');
  console.log('ALL THREE-SECOND TIMEOUT TESTS PASSED');
})().catch(e=>{console.error(e);process.exitCode=1;});
