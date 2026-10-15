"use strict";
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const ext=path.resolve(__dirname,'../extension');
const example='https://disk.yandex.ru/d/demo-share';
function event(){return{listeners:[],addListener(fn){this.listeners.push(fn);}};}
async function scenario(tabs,options={}){
  tabs=tabs.map(t=>({...t,status:'complete'}));const storage={},calls={created:[],injected:[],focused:[],shown:[],badges:[]};
  let injected=options.alreadyInjected!==false;
  const browser={
    runtime:{onMessage:event()},webRequest:{onBeforeRequest:event()},downloads:{onCreated:event()},
    browserAction:{async setBadgeText(arg){calls.badges.push(arg.text);}},windows:{async update(id,arg){calls.focused.push({windowId:id,...arg});}},
    storage:{local:{async get(key){return{[key]:storage[key]};},async set(obj){Object.assign(storage,obj);}}},
    tabs:{onRemoved:event(),async query(){return tabs;},async get(id){return tabs.find(t=>t.id===id);},
      async create(arg){calls.created.push(arg);const tab={id:50,windowId:1,status:'complete',url:options.redirect||arg.url};tabs.push(tab);await new Promise(resolve=>setTimeout(resolve,5));return tab;},
      async sendMessage(id,arg){if(!injected)throw new Error('No receiving end');calls.shown.push(id);return{ok:true};},
      async executeScript(id,arg){calls.injected.push({id,file:arg.file});if(arg.file==='content.js')injected=true;},
      async update(id,arg){calls.focused.push({id,...arg});return tabs.find(t=>t.id===id);}}
  };
  const ctx=vm.createContext({browser,console,URL,AbortController,setTimeout,clearTimeout,Date});
  for(const file of['common.js','background.js'])vm.runInContext(fs.readFileSync(path.join(ext,file),'utf8'),ctx);
  const send=msg=>browser.runtime.onMessage.listeners[0]({channel:'yd-clicker',type:'openPanel',tabId:1,windowId:1,url:example,...msg},{});
  return{send,calls,storage};
}
(async()=>{
  let test=await scenario([{id:1,windowId:1,url:'about:debugging#/runtime/this-firefox'},{id:2,windowId:1,url:example}],{alreadyInjected:false});
  let result=await test.send({});assert(result.ok);assert.equal(result.tabId,2);assert.equal(test.calls.created.length,0);
  assert.deepEqual(test.calls.injected.map(x=>x.file),['common.js','site.js','content.js']);assert(test.calls.focused.some(x=>x.id===2&&x.active));
  console.log('PASS: from installation page find Disk tab, inject missing content script, show and focus panel');

  test=await scenario([{id:1,windowId:1,url:'about:debugging'}],{alreadyInjected:false});
  const results=await Promise.all([test.send({}),test.send({})]);assert(results.every(x=>x.ok));assert.equal(test.calls.created.length,1);
  assert.equal(test.calls.created[0].url,example);assert.equal(test.calls.created[0].active,false);assert.equal(test.calls.shown[0],50);
  console.log('PASS: when Disk is absent open the supplied URL, finish in background and prevent duplicate tabs');

  test=await scenario([{id:1,windowId:1,url:'https://disk.yandex.ru/d/another'},{id:2,windowId:1,url:example}]);
  result=await test.send({});assert.equal(result.tabId,1);assert.equal(test.calls.injected.length,0);
  console.log('PASS: active public Disk tab is preferred and an existing panel is reused');
  result=await test.send({example:true});assert.equal(result.tabId,2);
  console.log('PASS: sample button selects the exact user-supplied shared folder');

  test=await scenario([{id:1,windowId:1,url:'about:debugging'},{id:2,windowId:1,url:'https://disk.360.yandex.ru/client/aa/d_demo-share/'}],{alreadyInjected:false});
  result=await test.send({example:true});assert(result.ok);assert.equal(result.tabId,2);assert.equal(test.calls.created.length,0);
  assert.equal(test.calls.injected.length,3);
  console.log('PASS: example redirected 360 URL is reused and receives the panel');

  test=await scenario([{id:1,windowId:1,url:'about:debugging'}],{redirect:'about:neterror'});
  result=await test.send({});assert.equal(result.ok,false);assert(test.storage['yd-clicker-panel-error']);assert(test.calls.badges.includes('!'));assert.equal(test.calls.injected.length,0);
  console.log('PASS: failed/redirected page loading reports a saved error and does not inject into another page');

  test=await scenario([{id:1,windowId:1,url:'about:debugging'}]);
  result=await test.send({url:''});assert.equal(result.ok,false);assert.equal(test.calls.created.length,0);assert.match(result.error,/ссылку/);
  console.log('PASS: no default private archive is embedded; an empty input asks for a public URL');
  const controls={show:{},example:{},status:{},url:{value:example}};let closed=false,received;
  const popup=vm.createContext({document:{getElementById(id){return controls[id];}},window:{close(){closed=true;}},
    YDCommon: require(path.join(ext,'common.js')),
    browser:{tabs:{async query(){return[{id:1,windowId:1,url:'about:debugging'}];}},runtime:{async sendMessage(msg){received=msg;return{ok:true};}},storage:{local:{async get(){return{};}}}}});
  vm.runInContext(fs.readFileSync(path.join(ext,'popup.js'),'utf8'),popup);
  await controls.show.onclick();assert(closed);assert.equal(received.type,'openPanel');assert.equal(received.tabId,1);
  console.log('PASS: popup no longer rejects a non-Disk active tab and delegates work to persistent background');
  console.log('ALL PANEL STARTUP TESTS PASSED');
})().catch(e=>{console.error(e);process.exitCode=1;});
