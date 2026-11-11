const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.join(__dirname, 'extension');
const version = JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8')).version;
const key = 'e6nav:pending-update';

function harness(options = {}) {
  let messageListener, installedListener, removedListener;
  const store = {language:'en',endMode:'loop',autoPage:true,seekPercent:12.5};
  const refreshed = [], closed = [];
  let reloads = 0;
  const pages = [
    {id:1,url:'https://e621.net/posts?page=5'},
    {id:2,url:'https://e621.net/favorites?user_id=42'},
    {id:3,url:'https://example.com/'},
    {id:4,url:'https://e621.net/users/42'},
    {id:5,url:'https://e621.net/posts/99#e6play=1'},
    {id:6,url:'https://e621.net/posts/66'},
    {id:7,url:'https://e621.net/posts/77'},
    {id:8,url:'https://e621.net/posts/88'}
  ];
  const runtime = {id:'test-extension',getURL:file=>'chrome-extension://test-extension/'+file,
    reload:()=>{reloads++;},onMessage:{addListener:fn=>messageListener=fn},onInstalled:{addListener:fn=>installedListener=fn}};
  const worker = vm.createContext({console,URL,URLSearchParams,Date,setTimeout,clearTimeout,chrome:{runtime,
    storage:{local:{
      get:async name=>({[name]:structuredClone(store[name])}),
      set:async patch=>{if(options.failWrite) throw new Error('Storage unavailable');Object.assign(store,structuredClone(patch));},
      remove:async name=>{delete store[name];}
    }},
    tabs:{
      query:async filter=>{assert.deepEqual(Array.from(filter.url),['https://e621.net/posts*','https://e621.net/favorites*']);return pages;},
      get:async id=>{
        if(id===6) throw new Error('Closed tab');
        if(id===7) return {id,url:'https://example.com/'};
        if(id===8) return {id,url:'https://e621.net/posts/999'};
        if(id===5) return {id,url:'https://e621.net/posts/99'};
        return pages.find(page=>page.id===id);
      },
      reload:async id=>{refreshed.push(id);},
      create:async()=> options.createPromise || {id:99},
      remove:async id=>{closed.push(id);removedListener(id);},
      onUpdated:{addListener:()=>{}},onRemoved:{addListener:fn=>removedListener=fn}
    }
  }});
  worker.importScripts = file=>vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),worker);
  vm.runInContext(fs.readFileSync(path.join(root,'background.js'),'utf8'),worker);
  const popup = {id:runtime.id,url:runtime.getURL('popup.html')};
  const send = (message,sender=popup)=>new Promise(resolve=>{
    if(messageListener(message,sender,resolve)!==true) resolve(undefined);
  });
  return {store,refreshed,closed,send,get reloads(){return reloads;},installed:reason=>installedListener({reason})};
}
async function eventually(fn) {
  const deadline = Date.now()+10000;
  while(!await fn() && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(await fn());
}
async function unitTests() {
  const h = harness();
  assert.equal(await h.send({type:'e6:apply-update'},{id:'test-extension',url:'https://e621.net/posts/99',frameId:0,tab:{id:5}}),undefined);
  assert.equal(h.reloads,0);
  h.installed('update');
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(h.refreshed,[]);
  assert.equal((await h.send({type:'e6:apply-update'})).ok,true);
  assert.equal(h.reloads,1);
  assert.ok(h.store[key]);
  assert.equal((await h.send({type:'e6:apply-update'})).ok,false);
  h.installed('update');
  await eventually(()=>h.refreshed.length===3);
  assert.deepEqual(h.refreshed.sort(),[1,2,5]);
  assert.equal(h.store[key],undefined);
  assert.equal(h.store.language,'en');
  assert.equal(h.store.seekPercent,12.5);
  h.installed('update');
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(h.refreshed.length,3);
  console.log('PASS: only the extension settings page can request an update; one-use handoff refreshes supported unchanged tabs, skips closed/navigated/unrelated tabs, and retains settings');
  const stale = harness();
  stale.store[key]={createdAt:Date.now()-180000,pages:[{id:1,url:'https://e621.net/posts?page=5'}]};
  stale.installed('update');
  await eventually(()=>!stale.store[key]);
  assert.deepEqual(stale.refreshed,[]);
  let create;
  const late = harness({createPromise:new Promise(resolve=>create=resolve)});
  const load = late.send({type:'e6:load-search',id:'00000000-0000-4000-8000-000000000000',url:'https://e621.net/posts?page=6'},
    {id:'test-extension',frameId:0,url:'https://e621.net/posts/99',tab:{id:5,windowId:1}});
  const update = late.send({type:'e6:apply-update'});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(late.reloads,0);
  create({id:99});
  assert.equal((await load).error,'cancelled');
  assert.equal((await update).ok,true);
  assert.deepEqual(late.closed,[99]);
  assert.equal(late.reloads,1);
  console.log('PASS: expired update markers are ignored; an update waits for late temporary-tab creation and closes that tab before reloading');
}
async function realExtensionTest(executablePath, browserName) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(),'e621-update-test-'));
  fs.mkdirSync(path.join(profile,'Default'));
  fs.writeFileSync(path.join(profile,'Default','Preferences'),JSON.stringify({extensions:{ui:{developer_mode:true}}}));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath,headless:true,
    ...(browserName !== 'Edge' ? {channel:'chromium',ignoreDefaultArgs:['--disable-extensions']} : {}),
    args:browserName !== 'Edge' ? ['--enable-unsafe-extension-debugging'] : ['--disable-extensions-except='+root,'--load-extension='+root]
  });
  context.setDefaultTimeout(10000);
  try {
    if(browserName !== 'Edge') {
      const manager = context.pages()[0];
      await manager.goto('chrome://extensions/');
      const developerMode = manager.locator('#devMode');
      if(!await developerMode.evaluate(node=>node.checked)) await developerMode.click();
      const session = await context.browser().newBrowserCDPSession();
      // Load as an actual unpacked extension; command-line-loaded extensions in
      // newer Chromium builds can be disabled instead of reloaded by runtime.reload().
      await session.send('Extensions.loadUnpacked',{path:root});
      await session.detach();
    }
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).hostname;
    const requests = new Map();
    const gallery = '<div id="posts"><section class="posts-container"><article class="thumbnail" data-file-ext="webm"><a class="thm-link" href="/posts/99">Test</a></article></section></div>';
    await context.route('https://e621.net/**', route=>{
      if(route.request().isNavigationRequest()) requests.set(route.request().url(),(requests.get(route.request().url())||0)+1);
      return route.fulfill({contentType:'text/html',body:/\/posts\/99/.test(route.request().url())?'<main><video controls></video></main>':gallery});
    });
    await context.route('https://example.com/**',route=>route.fulfill({contentType:'text/html',body:'Other site'}));
    const urls = ['https://e621.net/posts?tags=test','https://e621.net/favorites','https://e621.net/posts/99','https://e621.net/users/42','https://example.com/'];
    const pages = [];
    for(const url of urls) { const page=await context.newPage(); await page.goto(url); pages.push(page); }
    await worker.evaluate(()=>chrome.storage.local.set({seekPercent:12.5,endMode:'loop'}));
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.waitForFunction(async()=>{await ready;return document.documentElement.lang==='en'&&document.querySelector('#language').value==='en';});
    await popup.locator('#language').selectOption('zh');
    await popup.waitForFunction(()=>document.documentElement.lang==='zh-CN');
    await popup.locator('#advanced-settings summary').click();
    assert.ok((await popup.locator('#current-version').textContent()).includes(version));
    await popup.locator('#apply-update').click();
    try {
      await eventually(()=>urls.slice(0,3).every(url=>(requests.get(url)||0)===2));
    } catch (error) {
      console.error('Update diagnostics:',Object.fromEntries(requests),await popup.locator('#update-status').textContent().catch(()=>'<popup closed>'));
      console.error('Worker URLs:',context.serviceWorkers().map(worker=>worker.url()));
      const check = await context.newPage();
      await check.goto(`chrome-extension://${id}/popup.html`);
      console.error('Reload diagnostics:',await check.evaluate(async()=>({version:chrome.runtime.getManifest().version,pending:await chrome.storage.local.get('e6nav:pending-update'),contexts:await chrome.runtime.getContexts({contextTypes:['BACKGROUND']})})));
      throw error;
    }
    // New Chromium versions retain the Playwright worker handle across extension reload.
    const reloadedWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    assert.equal(requests.get(urls[3]),1);
    const saved = await reloadedWorker.evaluate(()=>chrome.storage.local.get(['language','seekPercent','endMode','e6nav:pending-update']));
    assert.equal(saved.language,'zh');
    assert.equal(saved.seekPercent,12.5);
    assert.equal(saved.endMode,'loop');
    assert.equal(saved['e6nav:pending-update'],undefined);
    await pages[0].waitForFunction(()=>document.querySelector('a.thm-link').hash.includes('e6nav='));
    assert.equal(pages[4].url(),'https://example.com/');
    console.log(`PASS: real ${browserName} MV3 extension reloads itself through its UI, new worker consumes the handoff and refreshes only e621 list/video pages; new content scripts run and settings survive`);
  } finally { await context.close(); }
}
(async()=>{
  await unitTests();
  if(process.env.TEST_UPDATE_BROWSER !== 'chromium') await realExtensionTest('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','Edge');
  const cache = path.join(process.env.LOCALAPPDATA, 'ms-playwright');
  const cached = fs.readdirSync(cache).filter(name=>/^chromium-\d+$/.test(name)).sort((a,b)=>Number(b.slice(9))-Number(a.slice(9)));
  const executable = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe',chromium.executablePath(),
    ...cached.flatMap(name=>['chrome-win64','chrome-win'].map(folder=>path.join(cache,name,folder,'chrome.exe')))]
    .find(file=>file && fs.existsSync(file));
  assert.ok(executable,'Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a Chromium executable');
  if(process.env.TEST_UPDATE_BROWSER !== 'edge') await realExtensionTest(executable,'Chrome / Chromium');
})().catch(error=>{console.error(error);process.exit(1);});
