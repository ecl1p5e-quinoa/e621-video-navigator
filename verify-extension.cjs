const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.join(__dirname, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
assert.ok(manifest.content_scripts.some(script => script.matches.includes('https://e621.net/favorites*')), 'favorites pages must receive the extension content script');
const source = 'https://e621.net/posts?page=5&tags=sound+order%3Afavcount';
const card = (id, ext, extra = '') => `<article class="thumbnail ${extra}" data-file-ext="${ext}"><a class="thm-link" href="/posts/${id}?q=sound+order%3Afavcount">${id}</a></article>`;
const gallery = `<div id="posts"><section class="posts-container">${card(90,'jpg')}${card(500,'webm')}${card(12,'webm','blacklisted')}${card(3,'gif')}${card(100,'mp4')}${card(700,'webm')}</section></div>`;
const detail = id => `<main><div id="player"><video controls muted loop><source src="https://static1.e621.net/test/${id}.webm" type="video/webm"></video></div><input id="search"><div id="comment" contenteditable="true">comment</div></main>`;
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const context = await browser.newContext();
  // Execute the real service worker against a Tabs API bridge; pages run the real collector.
  const tabPages = new Map();
  const temporaryTabs = new Set();
  let nextTabId = 1;
  let runtimeListener;
  let updatedListener;
  let removedListener;
  const workerStorage = {};
  const tabIdFor = page => {
    for (const [id, entry] of tabPages) if (entry === page) return id;
    const id = nextTabId++; tabPages.set(id, page); return id;
  };
  const worker = vm.createContext({ console, URL, URLSearchParams, setTimeout, clearTimeout, chrome: {
    runtime: { id: 'test-extension', getURL: file => 'chrome-extension://test-extension/'+file, onInstalled:{addListener:()=>{}}, onMessage: { addListener: fn => runtimeListener = fn } },
    storage: {local:{get:async key=>({[key]:workerStorage[key]}),set:async patch=>Object.assign(workerStorage,patch),remove:async key=>delete workerStorage[key]}},
    tabs: {
      create: async options => {
        assert.equal(options.active, false);
        assert.equal(options.url, 'about:blank');
        const page = await context.newPage();
        const id = tabIdFor(page); temporaryTabs.add(id); return { id };
      },
      update: async (id, options) => {
        await tabPages.get(id).goto(options.url);
        updatedListener(id, {status:'complete'});
      },
      remove: async id => {
        assert.ok(temporaryTabs.has(id), 'worker must never close a pre-existing user tab');
        const page = tabPages.get(id);
        tabPages.delete(id); temporaryTabs.delete(id);
        if (page) await page.close();
        removedListener(id);
      },
      sendMessage: async (id, message) => tabPages.get(id).evaluate(message => new Promise((resolve, reject) => {
        const listener = window.__messages?.[0];
        if (!listener) { reject(new Error('No content script yet')); return; }
        listener(message, {id: 'test-extension'}, resolve);
      }), message),
      onUpdated: { addListener: fn => updatedListener = fn },
      onRemoved: { addListener: fn => removedListener = fn }
    }
  }});
  worker.importScripts = file => vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),worker);
  vm.runInContext(fs.readFileSync(path.join(root,'background.js'),'utf8'), worker);
  await context.exposeBinding('__runtimeSend', ({page}, message) => new Promise(resolve => {
    const retained = runtimeListener(message, {id:'test-extension',frameId:0,url:page.url(),tab:{id:tabIdFor(page),windowId:1}}, resolve);
    if (!retained && message.type !== 'e6:cancel-search') resolve(undefined);
  }));
  const store = {language:'zh'};
  const errors = [];
  await context.exposeBinding('__getLocal', (_, keys) => {
    if (keys === null) return structuredClone(store);
    return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in store).map(key => [key, store[key]]));
  });
  await context.exposeBinding('__setLocal', (_, values) => { Object.assign(store, values); });
  await context.exposeBinding('__removeLocal', (_, keys) => { for (const key of keys) delete store[key]; });
  await context.addInitScript(version => {
    window.__changes = [];
    window.__messages = [];
    window.chrome = { runtime: {id:'test-extension', getManifest:()=>({version}), sendMessage: message => window.__runtimeSend(message),
      onMessage:{addListener: listener => window.__messages.push(listener)}}, storage: { local: {
      get: keys => window.__getLocal(keys), set: values => window.__setLocal(values), remove: keys => window.__removeLocal(keys)
    }, onChanged: { addListener: listener => window.__changes.push(listener) } } };
  }, manifest.version);
  await context.addInitScript({ content: fs.readFileSync(path.join(root,'i18n.js'),'utf8') });
  await context.addInitScript({ content: fs.readFileSync(path.join(root,'core.js'),'utf8') });
  await context.addInitScript({ content: `if (window.top === window) document.addEventListener('DOMContentLoaded', () => { ${fs.readFileSync(path.join(root,'content.js'),'utf8')} });` });
  // WPT media fixture: https://github.com/web-platform-tests/wpt/blob/master/media/test-1s.webm
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures', 'test-1s.webm'));
  await context.route('https://static1.e621.net/test/**', route => {
    const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    return route.fulfill({status:range ? 206 : 200,contentType:'video/webm',
      headers:{'accept-ranges':'bytes',...(range ? {'content-range':`bytes ${start}-${end}/${bytes.length}`} : {})},
      body:Buffer.from(bytes).subarray(start,end+1)});
  });
  let failNext = false;
  let paginationTest = false;
  let failNextPage = false;
  const pageRequests = [];
  const favoritesRequests = [];
  function favoritesGallery(number) {
    const favoriteCard = (id, ext, extra = '') => card(id, ext, extra).replace('q=sound+order%3Afavcount','q=fav%3Ausername');
    const contents = number === 1 ? favoriteCard(9200,'webm') + favoriteCard(9990,'jpg') + favoriteCard(9190,'webm','blacklisted') + favoriteCard(9100,'mp4')
      : favoriteCard(9010,'webm') + favoriteCard(9000,'mp4') + favoriteCard(8900,'webm');
    const next = number === 1 ? '<a id="paginator-next" href="/favorites?page=2">Next</a>' : '<span id="paginator-next">Next</span>';
    const blacklist = number === 2 ? `<div id="blacklisted-hider"></div><script>setTimeout(()=>{document.querySelector('a[href*="/posts/9010"]').closest('article').classList.add('blacklisted');document.querySelector('#blacklisted-hider').remove();},650);</script>` : '';
    return `<div id="posts"><section class="posts-container">${contents}</section><nav class="pagination">${next}</nav></div>${blacklist}`;
  }
  function paginatedGallery(number) {
    const contents = number === 5 ? card(500,'webm') + card(100,'mp4') + card(700,'webm')
      : number === 6 ? card(900,'webm') + card(650,'jpg') + card(700,'webm') + card(800,'webm') + card(801,'mp4')
      : number === 7 ? card(802,'webm') : '';
    // The real site supplies numbered or cursor-based links. Deliberately omit tags/limit here to test preservation.
    const next = number < 7 ? `<nav class="pagination"><a id="paginator-next" href="/posts?page=${number+1}">Next</a></nav>` : '<nav class="pagination"><span id="paginator-next">Next</span></nav>';
    const blacklist = number === 6 ? `<div id="blacklisted-hider"></div><script>setTimeout(()=>{document.querySelector('a[href*="/posts/900"]').closest('article').classList.add('blacklisted');document.querySelector('#blacklisted-hider').remove();},650);</script>` : '';
    return `<div id="posts"><section class="posts-container">${contents}</section>${next}</div>${blacklist}`;
  }
  await context.route('https://e621.net/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/favorites' || url.pathname === '/favorites/') {
      favoritesRequests.push(url.href);
      return route.fulfill({contentType:'text/html', headers:{'content-security-policy':"frame-ancestors 'none'"}, body:favoritesGallery(Number(url.searchParams.get('page') || '1'))});
    }
    if (failNext && url.pathname === '/posts/100') { failNext = false; return route.fulfill({status:503,body:'Unavailable'}); }
    if (paginationTest && url.pathname === '/posts') {
      pageRequests.push(url.href);
      if (failNextPage && url.searchParams.get('page') === '6') {failNextPage=false;return route.fulfill({status:503,body:'Unavailable'});}
      return route.fulfill({contentType:'text/html',headers:{'content-security-policy':"frame-src https://www.google.com/recaptcha/; frame-ancestors 'none'"},body:paginatedGallery(Number(url.searchParams.get('page')))});
    }
    return route.fulfill({ contentType: 'text/html', body: url.pathname === '/posts' ? gallery : detail(url.pathname.split('/').pop()) });
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage();
  await page.goto(source);
  await page.waitForFunction(() => document.querySelector('a[href*="/posts/500"]').hash.includes('e6nav='));
  const first = await page.locator('a[href*="/posts/500"]').getAttribute('href');
  const records = Object.values(store).filter(value => value?.videos);
  assert.deepEqual(records[0].videos.map(x => x.id), ['500','100','700']);
  assert.equal(records[0].source, source);
  console.log('PASS: search-page order preserved; images, GIF and hidden video skipped');
  await page.locator('a[href*="/posts/500"]').click();
  await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('1/3'));
  await page.locator('#search').fill('');
  await page.keyboard.press('BracketRight');
  assert.equal(new URL(page.url()).pathname, '/posts/500');
  await page.locator('#comment').click();
  await page.keyboard.press('BracketRight');
  assert.equal(new URL(page.url()).pathname, '/posts/500');
  console.log('PASS: shortcut does not navigate while editing text');
  await page.locator('main').click({ position: {x: 700, y: 5} });
  await Promise.all([page.waitForURL('**/posts/100?**'), page.keyboard.press('BracketRight')]);
  await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('2/3'));
  assert.equal(new URL(page.url()).searchParams.get('q'), 'sound order:favcount');
  assert.equal(new URL(page.url()).hash, new URL(first).hash);
  console.log('PASS: ] opens actual next video, preserving search and source marker');
  await Promise.all([page.waitForURL('**/posts/700?**'), page.keyboard.press('BracketRight')]);
  await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('3/3'));
  await page.keyboard.press('BracketRight');
  await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes('最后一个'));
  assert.equal(new URL(page.url()).pathname, '/posts/700');
  console.log('PASS: end of source page stops without wrapping or crossing pages');
  await Promise.all([page.waitForURL('**/posts/100?**'), page.keyboard.press('BracketLeft')]);
  await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('2/3'));
  await Promise.all([page.waitForURL('**/posts/500?**'), page.keyboard.press('BracketLeft')]);
  await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('1/3'));
  await page.keyboard.press('BracketLeft');
  await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes('第一个视频'));
  assert.equal(new URL(page.url()).pathname, '/posts/500');
  console.log('PASS: [ navigates previous search-page videos and stops at first');
  const secondSource = await context.newPage();
  await secondSource.goto('https://e621.net/posts?page=2&tags=test');
  await secondSource.waitForFunction(() => document.querySelector('a[href*="/posts/500"]').hash.includes('e6nav='));
  const secondFirst = await secondSource.locator('a[href*="/posts/500"]').getAttribute('href');
  assert.notEqual(new URL(first).hash, new URL(secondFirst).hash);
  const opened = await context.newPage();
  await opened.goto(first);
  await opened.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('1/3'));
  await Promise.all([opened.waitForURL('**/posts/100?**'), opened.keyboard.press('BracketRight')]);
  assert.equal(new URL(opened.url()).hash, new URL(first).hash);
  console.log('PASS: independent source tabs and detail opened in a new tab retain correct context');
  await opened.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('2/3'));
  const custom = { code:'KeyJ', alt:false, ctrl:false, shift:false, meta:false };
  await opened.evaluate(key => window.__changes.forEach(fn => fn({ nextKey: {newValue:key} }, 'local')), custom);
  await opened.keyboard.press('BracketRight');
  assert.equal(new URL(opened.url()).pathname, '/posts/100');
  await Promise.all([opened.waitForURL('**/posts/700?**'), opened.keyboard.press('j')]);
  console.log('PASS: changed shortcut applies immediately; old shortcut stops triggering');
  const seek = await context.newPage();
  await seek.bringToFront();
  await seek.goto('https://e621.net/posts/500');
  await seek.waitForFunction(() => {const v=document.querySelector('video'); return v.readyState >= 3 && v.seekable.length && v.seekable.end(0) > 0;});
  await seek.evaluate(() => {
    const video = document.querySelector('video'); video.pause(); video.loop = false; video.currentTime = video.duration * 0.1;
  });
  await seek.keyboard.press('ArrowRight');
  let seekState = await seek.evaluate(() => ({time:document.querySelector('video').currentTime,duration:document.querySelector('video').duration,paused:document.querySelector('video').paused}));
  assert.ok(Math.abs(seekState.time / seekState.duration - 0.3) < 0.002);
  assert.equal(seekState.paused, true);
  await seek.keyboard.press('ArrowLeft');
  assert.ok(Math.abs(await seek.evaluate(() => document.querySelector('video').currentTime / document.querySelector('video').duration) - 0.1) < 0.002);
  await seek.keyboard.press('ArrowLeft');
  assert.equal(await seek.evaluate(() => document.querySelector('video').currentTime), 0);
  await seek.keyboard.press('ArrowRight');
  seekState.time = await seek.evaluate(() => document.querySelector('video').currentTime);
  console.log('PASS: left-arrow rewind subtracts 20% of duration and clamps to zero');
  await seek.locator('#search').click();
  await seek.keyboard.press('ArrowRight');
  assert.equal(await seek.evaluate(() => document.querySelector('video').currentTime), seekState.time);
  await seek.locator('main').click({position:{x:700,y:5}});
  await seek.evaluate(() => document.querySelector('video').currentTime = document.querySelector('video').duration * 0.9);
  await seek.keyboard.press('ArrowRight');
  seekState = await seek.evaluate(() => ({time:document.querySelector('video').currentTime,duration:document.querySelector('video').duration}));
  assert.equal(seekState.time, seekState.duration);
  console.log('PASS: direct detail seek advances by 20% of total duration, preserves pause, ignores editing, and clamps to end');
  const customSeek = {code:'KeyL',alt:false,ctrl:false,shift:false,meta:false};
  await seek.evaluate(key => {
    window.__changes.forEach(fn => fn({seekKey:{newValue:key},seekPercent:{newValue:10}},'local'));
    document.querySelector('video').currentTime = 0;
  }, customSeek);
  await seek.keyboard.press('l');
  assert.ok(Math.abs(await seek.evaluate(() => document.querySelector('video').currentTime / document.querySelector('video').duration) - 0.1) < 0.002);
  await seek.evaluate(() => {Object.defineProperty(document.querySelector('video'),'duration',{value:Infinity,configurable:true});});
  const previousTime = await seek.evaluate(() => document.querySelector('video').currentTime);
  await seek.keyboard.press('l');
  await seek.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes('时长尚未加载'));
  assert.equal(await seek.evaluate(() => document.querySelector('video').currentTime), previousTime);
  console.log('PASS: custom seek key and percentage apply immediately; unknown duration is handled without changing progress');
  await seek.evaluate(() => {
    const video = document.querySelector('video'); delete video.duration; video.currentTime = video.duration * 0.5;
    window.__changes.forEach(fn => fn({rewindKey:{newValue:{code:'KeyH',alt:false,ctrl:false,shift:false,meta:false}},rewindPercent:{newValue:12.5}},'local'));
  });
  await seek.keyboard.press('h');
  assert.ok(Math.abs(await seek.evaluate(() => document.querySelector('video').currentTime / document.querySelector('video').duration) - 0.375) < 0.002);
  console.log('PASS: independent custom rewind shortcut and percentage apply immediately');
  // Native-video fullscreen: preserve the actual element and fullscreen session.
  const full = await context.newPage();
  await full.bringToFront();
  await full.goto(first);
  await full.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('1/3'));
  await full.evaluate(async () => {
    window.originalVideo = document.querySelector('video');
    originalVideo.playbackRate = 1.25;
    originalVideo.volume = 0.3;
    await Promise.race([originalVideo.play(), new Promise((_,reject) => setTimeout(() => reject(new Error('play fixture timed out: ' + originalVideo.readyState + ' ' + originalVideo.error?.message)), 5000))]);
    await originalVideo.requestFullscreen();
  });
  await full.waitForFunction(() => document.fullscreenElement === window.originalVideo);
  await full.evaluate(() => {originalVideo.pause(); originalVideo.loop = false; originalVideo.currentTime = originalVideo.duration * 0.1;});
  await full.keyboard.press('ArrowRight');
  assert.ok(Math.abs(await full.evaluate(() => originalVideo.currentTime / originalVideo.duration) - 0.3) < 0.002);
  assert.equal(await full.evaluate(() => document.fullscreenElement === originalVideo), true);
  await full.keyboard.press('ArrowLeft');
  assert.ok(Math.abs(await full.evaluate(() => originalVideo.currentTime / originalVideo.duration) - 0.1) < 0.002);
  console.log('PASS: percentage seek works in real native fullscreen without exiting');
  failNext = true;
  await full.keyboard.press('BracketRight');
  await full.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes('加载失败'));
  assert.equal(new URL(full.url()).pathname, '/posts/500');
  assert.equal(await full.locator('video source').getAttribute('src'), 'https://static1.e621.net/test/500.webm');
  console.log('PASS: failed fullscreen fetch retains current video and can be retried');
  await full.keyboard.press('BracketRight');
  await full.waitForFunction(() => document.querySelector('video source')?.src.includes('/100.webm') && !document.querySelector('video').paused && document.querySelector('video').readyState >= 2);
  assert.equal(await full.evaluate(() => document.fullscreenElement === window.originalVideo), true);
  assert.equal(new URL(full.url()).pathname, '/posts/500');
  assert.equal(await full.evaluate(() => originalVideo.playbackRate), 1.25);
  assert.equal(await full.evaluate(() => originalVideo.volume), 0.3);
  console.log('PASS: actual native fullscreen retained; next real media plays with settings preserved');
  await full.keyboard.press('BracketLeft');
  await full.waitForFunction(() => document.querySelector('video source')?.src.includes('/500.webm') && !document.querySelector('video').paused);
  assert.equal(await full.evaluate(() => document.fullscreenElement === originalVideo), true);
  await full.keyboard.press('BracketLeft');
  await full.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes('第一个视频'));
  await full.keyboard.press('BracketRight');
  await full.waitForFunction(() => document.querySelector('video source')?.src.includes('/100.webm') && !document.querySelector('video').paused);
  console.log('PASS: fullscreen previous navigation preserves fullscreen and queue position across both directions');
  await full.keyboard.press('BracketRight');
  await full.waitForFunction(() => document.querySelector('video source')?.src.includes('/700.webm') && !document.querySelector('video').paused);
  await full.keyboard.press('BracketRight');
  await full.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes('最后一个'));
  assert.equal(await full.evaluate(() => document.fullscreenElement === window.originalVideo), true);
  await Promise.all([full.waitForURL('**/posts/700?**'), full.evaluate(() => document.exitFullscreen())]);
  await full.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('3/3'));
  console.log('PASS: repeated fullscreen ] advances; last stops; exit loads current post detail');
  const customFull = await context.newPage();
  await customFull.goto(first);
  await customFull.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('1/3'));
  await customFull.evaluate(() => document.querySelector('#player').requestFullscreen());
  await customFull.keyboard.press('BracketRight');
  await customFull.waitForFunction(() => document.querySelector('video source')?.src.includes('/100.webm'));
  assert.equal(await customFull.evaluate(() => document.fullscreenElement.id), 'player');
  assert.equal(await customFull.evaluate(() => document.querySelector('[role="status"]').parentElement.id), 'player');
  await Promise.all([customFull.waitForURL('**/posts/100?**'), customFull.evaluate(() => document.exitFullscreen())]);
  console.log('PASS: container fullscreen retains player and renders status inside fullscreen');
  await page.goto('https://e621.net/posts/500');
  await page.keyboard.press('BracketRight');
  await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('请先刷新'));
  assert.equal(new URL(page.url()).pathname, '/posts/500');
  console.log('PASS: direct detail URL cannot accidentally use another tab context');
  // Exercise settings UI with the real popup scripts.
  const popup = await context.newPage();
  await popup.route('https://settings.test/**', route => {
    const name = new URL(route.request().url()).pathname.slice(1) || 'popup.html';
    route.fulfill({ contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', body: fs.readFileSync(path.join(root,name)) });
  });
  await popup.goto('https://settings.test/popup.html');
  await popup.locator('#shortcut').click();
  await popup.keyboard.press('Alt+ArrowRight');
  await popup.waitForFunction(() => document.querySelector('#status').textContent.includes('已保存'));
  assert.equal(store.nextKey.code, 'ArrowRight');
  assert.equal(store.nextKey.alt, true);
  await popup.locator('#reset').click();
  await popup.waitForFunction(() => document.querySelector('#shortcut').value === ']');
  assert.equal(store.nextKey.code, 'BracketRight');
  console.log('PASS: popup records custom key and restores ]');
  await popup.locator('#seek-shortcut').click();
  await popup.keyboard.press('BracketRight');
  await popup.waitForFunction(() => document.querySelector('#status').textContent.includes('不能使用相同'));
  assert.equal(store.seekKey.code, 'ArrowRight');
  await popup.keyboard.press('l');
  await popup.waitForFunction(() => document.querySelector('#seek-shortcut').value === 'L');
  assert.equal(store.seekKey.code, 'KeyL');
  await popup.locator('#advanced-settings summary').click();
  await popup.locator('#seek-percent').fill('12.5');
  await popup.locator('#seek-shortcut').click();
  await popup.waitForFunction(() => document.querySelector('#status').textContent.includes('已保存'));
  assert.equal(store.seekPercent, 12.5);
  await popup.locator('#seek-percent').fill('101');
  await popup.locator('#seek-shortcut').click();
  await popup.waitForFunction(() => document.querySelector('#status').textContent.includes('不超过 100'));
  assert.equal(store.seekPercent, 12.5);
  await popup.locator('#reset').click();
  await popup.waitForFunction(() => document.querySelector('#seek-shortcut').value === '→' && document.querySelector('#seek-percent').value === '20');
  assert.equal(store.seekPercent, 20);
  assert.equal(store.seekKey.code, 'ArrowRight');
  console.log('PASS: settings save custom seek key and decimal percentage, reject conflicts and invalid percentages, and restore defaults');
  await popup.locator('#previous-shortcut').click();
  await popup.keyboard.press('k');
  await popup.waitForFunction(() => document.querySelector('#previous-shortcut').value === 'K');
  assert.equal(store.previousKey.code, 'KeyK');
  await popup.locator('#rewind-shortcut').click();
  await popup.keyboard.press('k');
  await popup.waitForFunction(() => document.querySelector('#status').textContent.includes('不能使用相同'));
  await popup.keyboard.press('h');
  await popup.waitForFunction(() => document.querySelector('#rewind-shortcut').value === 'H');
  await popup.locator('#rewind-percent').fill('15');
  await popup.locator('#rewind-shortcut').click();
  await popup.waitForFunction(() => document.querySelector('#status').textContent.includes('已保存'));
  assert.equal(store.rewindPercent, 15);
  assert.equal(store.seekPercent, 20);
  await popup.locator('#reset').click();
  await popup.waitForFunction(() => document.querySelector('#previous-shortcut').value === '[');
  await popup.waitForFunction(() => document.querySelector('#rewind-shortcut').value === '←' && document.querySelector('#rewind-percent').value === '20');
  const migration = await popup.evaluate(async () => {
    const old = {nextKey:{code:'KeyN',alt:false,ctrl:false,shift:false,meta:false}};
    const saved = {};
    const upgraded = await E6Nav.loadSettings({get:async()=>old,set:async patch=>Object.assign(saved,patch)});
    const later = E6Nav.settings({...old,settingsVersion:2});
    return {upgraded:upgraded.nextKey.code,saved,later:later.nextKey.code};
  });
  assert.equal(migration.upgraded, 'BracketRight');
  assert.equal(migration.saved.settingsVersion, 2);
  assert.equal(migration.later, 'KeyN');
  console.log('PASS: all four shortcuts validate conflicts; rewind settings are independent; old default migrates once and later custom N is retained');
  await popup.locator('#end-mode').selectOption('next');
  await popup.waitForFunction(() => document.querySelector('#status').textContent.includes('已保存'));
  assert.equal(store.endMode, 'next');
  await popup.locator('#end-mode').selectOption('loop');
  await popup.waitForFunction(() => document.querySelector('#end-mode').value === 'loop');
  // Wait for the actual asynchronous persistence, not the previous status text.
  await popup.waitForFunction(async () => (await chrome.storage.local.get('endMode')).endMode === 'loop');
  assert.equal(store.endMode, 'loop');
  console.log('PASS: popup persists both end-of-video modes');
  const repeating = await context.newPage();
  await repeating.bringToFront();
  await repeating.goto(first);
  await repeating.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('1/3'));
  assert.equal(await repeating.evaluate(() => document.querySelector('video').loop), true);
  await repeating.evaluate(async () => {
    const player = document.querySelector('video');
    window.wraps = 0; let previous = 0;
    player.addEventListener('timeupdate', () => {if (player.currentTime < previous) window.wraps++; previous = player.currentTime;});
    player.playbackRate = 3;
    await player.play();
  });
  await repeating.waitForFunction(() => window.wraps > 0);
  assert.equal(new URL(repeating.url()).pathname, '/posts/500');
  await repeating.evaluate(() => document.querySelector('video').pause());
  // Settings updates override later writes from the site's player settings.
  await repeating.evaluate(() => window.__changes.forEach(fn => fn({endMode:{newValue:'next'}},'local')));
  assert.equal(await repeating.evaluate(() => document.querySelector('video').loop), false);
  await repeating.evaluate(() => document.querySelector('video').loop = true);
  await repeating.waitForFunction(() => document.querySelector('video').loop === false);
  await repeating.evaluate(() => window.__changes.forEach(fn => fn({endMode:{newValue:'loop'}},'local')));
  assert.equal(await repeating.evaluate(() => document.querySelector('video').loop), true);
  console.log('PASS: loop mode really replays, and switching mode applies immediately despite site loop initialization');
  store.endMode = 'next';
  const autoPage = await context.newPage();
  await autoPage.bringToFront();
  await autoPage.goto(first);
  await autoPage.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('1/3'));
  await autoPage.evaluate(() => document.querySelector('video').play());
  await autoPage.waitForURL('**/posts/100?**');
  await autoPage.waitForFunction(() => !document.querySelector('video').paused);
  await autoPage.waitForURL('**/posts/700?**');
  await autoPage.waitForFunction(() => document.querySelector('video').ended && document.querySelector('[role="status"]')?.textContent.includes('最后一个'));
  assert.equal(new URL(autoPage.url()).pathname, '/posts/700');
  assert.equal(new URL(autoPage.url()).hash, new URL(first).hash);
  console.log('PASS: real ordinary playback auto-advances, starts the next video, and stops at the last source-page video');
  const autoFull = await context.newPage();
  await autoFull.bringToFront();
  await autoFull.goto(first);
  await autoFull.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('1/3'));
  failNext = true;
  await autoFull.evaluate(async () => {
    window.autoPlayer = document.querySelector('video');
    let duplicated = false;
    autoPlayer.addEventListener('ended', () => {
      if (!duplicated) { duplicated = true; autoPlayer.dispatchEvent(new Event('ended')); }
    });
    await autoPlayer.play();
    await autoPlayer.requestFullscreen();
  });
  await autoFull.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('加载失败'));
  assert.equal(await autoFull.locator('video source').getAttribute('src'), 'https://static1.e621.net/test/500.webm');
  assert.equal(await autoFull.evaluate(() => document.fullscreenElement === autoPlayer), true);
  await autoFull.keyboard.press('BracketRight');
  await autoFull.waitForFunction(() => document.querySelector('video source')?.src.includes('/100.webm') && !document.querySelector('video').paused);
  await autoFull.waitForFunction(() => document.querySelector('video source')?.src.includes('/700.webm') && document.querySelector('video').ended);
  await autoFull.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('最后一个'));
  assert.equal(await autoFull.evaluate(() => document.fullscreenElement === autoPlayer), true);
  assert.equal(new URL(autoFull.url()).pathname, '/posts/500');
  await Promise.all([autoFull.waitForURL('**/posts/700?**'), autoFull.evaluate(() => document.exitFullscreen())]);
  console.log('PASS: fullscreen auto-next preserves fullscreen, handles duplicate ended events and fetch failures, supports manual retry, and exits to the current post');
  const noContext = await context.newPage();
  await noContext.bringToFront();
  await noContext.goto('https://e621.net/posts/500');
  await noContext.evaluate(() => document.querySelector('video').play());
  await noContext.waitForFunction(() => document.querySelector('video').ended && document.querySelector('[role="status"]')?.textContent.includes('请先刷新'));
  assert.equal(new URL(noContext.url()).pathname, '/posts/500');
  console.log('PASS: automatic playback without a source queue stops safely with a setup hint');
  const settingsBeforeLanguage = structuredClone(store);
  await popup.locator('#language').selectOption('en');
  await popup.waitForFunction(() => document.documentElement.lang === 'en' && document.querySelector('#status').textContent.startsWith('Saved'));
  assert.equal(store.language, 'en');
  assert.equal(await popup.title(), 'Video Navigation Settings');
  assert.equal(await popup.locator('h1').textContent(), 'Search Video Navigation');
  assert.equal(await popup.locator('#end-mode option[value="next"]').textContent(), 'Automatically play the next video');
  const translations = await popup.evaluate(() => ({
    zh: Object.keys(E6I18n.messages.zh).sort(), en: Object.keys(E6I18n.messages.en).sort(),
    missing: Array.from(document.querySelectorAll('[data-i18n]')).filter(node => !E6I18n.messages.en[node.dataset.i18n]).length,
    unlocalized: Array.from(document.querySelectorAll('[data-i18n]')).filter(node => /[\u4e00-\u9fff]/.test(node.textContent) && node.dataset.i18n !== 'language').length,
    space: E6Nav.label({code:'Space'},'en')
  }));
  assert.deepEqual(translations.zh, translations.en);
  assert.equal(translations.missing, 0);
  assert.equal(translations.unlocalized, 0);
  assert.equal(translations.space, 'Space');
  for (const name of ['nextKey','previousKey','seekKey','rewindKey','seekPercent','rewindPercent','endMode']) assert.deepEqual(store[name],settingsBeforeLanguage[name]);
  await popup.locator('#rewind-percent').fill('101');
  await popup.locator('#rewind-shortcut').click();
  await popup.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Enter a percentage'));
  await popup.reload();
  await popup.waitForFunction(() => document.querySelector('#language').value === 'en' && document.documentElement.lang === 'en');
  console.log('PASS: popup fully translates, localizes validation, persists English, and preserves playback and shortcut settings');
  // Mock extension change delivery to an already-open page; real Chrome supplies this event.
  await noContext.evaluate(() => window.__changes.forEach(fn => fn({language:{newValue:'en'}},'local')));
  await noContext.waitForFunction(() => document.querySelector('[role="status"]').textContent.startsWith('Refresh the search results'));
  await noContext.keyboard.press('BracketLeft');
  await noContext.waitForFunction(() => document.querySelector('[role="status"]').textContent.startsWith('Refresh the search results'));
  store.endMode = 'loop';
  const english = await context.newPage();
  await english.bringToFront();
  await english.goto(first);
  await english.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.startsWith('Search-page video 1/3'));
  await english.evaluate(() => {const video=document.querySelector('video'); video.pause(); video.currentTime=0;});
  await english.waitForFunction(() => document.querySelector('video').readyState >= 3);
  await english.keyboard.press('ArrowRight');
  await english.waitForFunction(() => document.querySelector('[role="status"]').textContent.startsWith('Forward 20%'));
  await english.keyboard.press('ArrowLeft');
  await english.waitForFunction(() => document.querySelector('[role="status"]').textContent.startsWith('Backward 20%'));
  await english.keyboard.press('BracketLeft');
  await english.waitForFunction(() => document.querySelector('[role="status"]').textContent.startsWith('This is the first video'));
  console.log('PASS: existing notices switch immediately and new pages use English for queue, seek, rewind, and boundary messages');
  await popup.locator('#language').selectOption('zh');
  await popup.waitForFunction(() => document.documentElement.lang === 'zh-CN' && document.querySelector('#status').textContent.includes('已保存'));
  await english.evaluate(() => window.__changes.forEach(fn => fn({language:{newValue:'zh'}},'local')));
  await english.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes('第一个视频'));
  assert.equal(store.language,'zh');
  assert.equal(await popup.title(),'视频导航设置');
  console.log('PASS: switching back to Chinese updates popup and active page notices');
  await popup.reload();
  await popup.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  assert.equal(await popup.locator('#advanced-settings').getAttribute('open'), null);
  await popup.locator('#advanced-settings summary').click();
  assert.equal(await popup.locator('#advanced-settings').evaluate(node => node.open), true);
  await popup.locator('#auto-page').check();
  await popup.waitForFunction(async () => (await chrome.storage.local.get('autoPage')).autoPage === true);
  await popup.reload();
  await popup.locator('#advanced-settings summary').click();
  await popup.waitForFunction(() => document.querySelector('#auto-page').checked);
  console.log('PASS: advanced drawer expands, pagination defaults off, and enabled setting persists');
  paginationTest = true;
  store.endMode = 'next';
  const paginatedSource = await context.newPage();
  const pagingSource = source + '&limit=32';
  await paginatedSource.goto(pagingSource);
  await paginatedSource.waitForFunction(() => document.querySelector('a[href*="/posts/700"]').hash.includes('e6nav='));
  const last = await paginatedSource.locator('a[href*="/posts/700"]').getAttribute('href');
  // Manual cross-page navigation must also work while the current video is set to loop.
  store.endMode = 'loop';
  const manual = await context.newPage();
  await manual.bringToFront();
  await manual.goto(last);
  await manual.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('3/3'));
  await manual.evaluate(() => window.__changes.forEach(fn => fn({autoPage:{newValue:false}},'local')));
  await manual.keyboard.press('BracketRight');
  await manual.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('高级设置'));
  assert.equal(new URL(manual.url()).pathname, '/posts/700');
  await manual.evaluate(() => window.__changes.forEach(fn => fn({autoPage:{newValue:true}},'local')));
  await Promise.all([manual.waitForURL('**/posts/800?**'), manual.keyboard.press('BracketRight')]);
  await manual.waitForFunction(() => !document.querySelector('video').paused);
  assert.equal(await manual.evaluate(() => document.querySelector('video').loop), true);
  await manual.evaluate(() => document.querySelector('video').pause());
  await Promise.all([manual.waitForURL('**/posts/700?**'), manual.keyboard.press('BracketLeft')]);
  assert.equal(temporaryTabs.size,0);
  console.log('PASS: manual ] crosses pages in loop mode, starts the first new video, keeps previous history, and stops with a setting hint when pagination is off');
  const manualFull = await context.newPage();
  await manualFull.bringToFront();
  await manualFull.goto(last);
  await manualFull.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('3/3'));
  await manualFull.evaluate(() => document.querySelector('video').requestFullscreen());
  await manualFull.keyboard.press('BracketRight');
  await assertEventually(() => temporaryTabs.size > 0);
  // Unrelated settings changes in loop mode must not cancel a manual page request.
  await manualFull.evaluate(() => window.__changes.forEach(fn => fn({language:{newValue:'en'}},'local')));
  await manualFull.waitForFunction(() => document.querySelector('video source')?.src.includes('/800.webm'));
  assert.equal(await manualFull.evaluate(() => document.fullscreenElement === document.querySelector('video')), true);
  assert.equal(new URL(manualFull.url()).pathname, '/posts/700');
  await manualFull.evaluate(() => document.querySelector('video').pause());
  await Promise.all([manualFull.waitForURL('**/posts/800?**'), manualFull.evaluate(() => document.exitFullscreen())]);
  console.log('PASS: manual ] crosses pages while retaining native fullscreen and loop mode, and survives unrelated settings updates');
  const manualCancel = await context.newPage();
  await manualCancel.bringToFront();
  await manualCancel.goto(last);
  await manualCancel.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('3/3'));
  await manualCancel.keyboard.press('BracketRight');
  await assertEventually(() => temporaryTabs.size > 0);
  await manualCancel.evaluate(() => window.__changes.forEach(fn => fn({autoPage:{newValue:false}},'local')));
  await assertEventually(() => temporaryTabs.size === 0);
  assert.equal(new URL(manualCancel.url()).pathname, '/posts/700');
  await manualCancel.close();
  console.log('PASS: disabling pagination cancels manual cross-page loading and cleans up its temporary tab');
  store.endMode = 'next';
  const paging = await context.newPage();
  await paging.bringToFront();
  await paging.goto(last);
  await paging.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('3/3'));
  await paging.evaluate(() => document.querySelector('video').play());
  await paging.waitForURL('**/posts/800?**');
  await paging.waitForFunction(() => !document.querySelector('video').paused);
  await paging.evaluate(() => document.querySelector('video').pause());
  const newToken = await paging.evaluate(() => E6Nav.token(location.href));
  const newRecord = store['e6nav:context:' + newToken];
  assert.deepEqual(newRecord.videos.map(video => video.id), ['500','100','700','800','801']);
  assert.equal(new URL(newRecord.source).searchParams.get('page'), '6');
  assert.equal(new URL(newRecord.source).searchParams.get('tags'), 'sound order:favcount');
  assert.equal(new URL(newRecord.source).searchParams.get('limit'), '32');
  assert.equal(await paging.locator('iframe').count(), 0);
  assert.equal(temporaryTabs.size, 0);
  assert.equal(store['e6nav:context:' + new URLSearchParams(new URL(last).hash.slice(1)).get('e6nav')].videos.length,3);
  await Promise.all([paging.waitForURL('**/posts/700?**'),paging.keyboard.press('BracketLeft')]);
  console.log('PASS: auto-pagination works with site CSP prohibiting frames, preserves search/filter order, and closes only its temporary background tab');
  const pageFull = await context.newPage();
  await pageFull.bringToFront();
  await pageFull.goto(last);
  await pageFull.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('3/3'));
  await pageFull.evaluate(async () => {
    window.pagingPlayer=document.querySelector('video');window.loadedIds=[];
    pagingPlayer.addEventListener('loadedmetadata',()=>window.loadedIds.push(pagingPlayer.querySelector('source').src.match(/\/(\d+)\.webm/)[1]));
    await pagingPlayer.play();await pagingPlayer.requestFullscreen();
  });
  await pageFull.waitForFunction(() => document.querySelector('video source')?.src.includes('/802.webm') && document.querySelector('video').ended);
  await pageFull.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('最后一页'));
  assert.deepEqual(await pageFull.evaluate(() => window.loadedIds), ['800','801','802']);
  assert.equal(await pageFull.evaluate(() => document.fullscreenElement === pagingPlayer), true);
  assert.equal(new URL(pageFull.url()).pathname, '/posts/700');
  await Promise.all([pageFull.waitForURL('**/posts/802?**'),pageFull.evaluate(()=>document.exitFullscreen())]);
  const finalRecord = store['e6nav:context:' + await pageFull.evaluate(()=>E6Nav.token(location.href))];
  assert.equal(new URL(finalRecord.source).searchParams.get('page'),'7');
  console.log('PASS: real fullscreen playback continues across multiple pages in order, stops at search end, and exits to the current post with the updated queue');
  failNextPage = true;
  const retryPage = await context.newPage();
  await retryPage.bringToFront();
  await retryPage.goto(last);
  await retryPage.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('3/3'));
  await retryPage.evaluate(()=>document.querySelector('video').play());
  await retryPage.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('下一页加载失败'));
  assert.equal(new URL(retryPage.url()).pathname,'/posts/700');
  assert.equal(await retryPage.locator('iframe').count(),0);
  assert.equal(temporaryTabs.size,0);
  assert.ok((await retryPage.locator('[role="status"]').textContent()).includes('未取得搜索结果'));
  await retryPage.evaluate(()=>{const v=document.querySelector('video');v.currentTime=0;return v.play();});
  await retryPage.waitForURL('**/posts/800?**');
  await retryPage.evaluate(()=>document.querySelector('video').pause());
  console.log('PASS: failed next-page load shows a specific reason, retains the current video, closes its temporary tab, and permits replay retry');
  const cancellation = await context.newPage();
  await cancellation.bringToFront();
  await cancellation.goto(last);
  await cancellation.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('3/3'));
  await cancellation.evaluate(()=>document.querySelector('video').play());
  await assertEventually(()=>temporaryTabs.size > 0);
  await cancellation.evaluate(()=>window.__changes.forEach(fn=>fn({autoPage:{newValue:false}},'local')));
  await assertEventually(()=>temporaryTabs.size === 0);
  assert.equal(new URL(cancellation.url()).pathname,'/posts/700');
  const cursor = await cancellation.evaluate(()=> {
    const doc=new DOMParser().parseFromString('<a id="paginator-next" href="/posts?page=b700">Next</a>','text/html');
    return E6Nav.nextPage(doc,'https://e621.net/posts?page=5&tags=sound+order%3Afavcount&limit=32');
  });
  assert.equal(new URL(cursor).searchParams.get('page'),'b700');
  assert.equal(new URL(cursor).searchParams.get('tags'),'sound order:favcount');
  console.log('PASS: turning pagination off cancels an in-flight page load; cursor pagination preserves the search query');
  store.endMode = 'next';
  store.autoPage = false;
  const favorites = await context.newPage();
  await favorites.goto('https://e621.net/favorites');
  await favorites.waitForFunction(() => document.querySelector('a[href*="/posts/9200"]').hash.includes('e6nav='));
  const favoriteFirst = await favorites.locator('a[href*="/posts/9200"]').getAttribute('href');
  const favoriteRecord = store['e6nav:context:' + new URLSearchParams(new URL(favoriteFirst).hash.slice(1)).get('e6nav')];
  assert.equal(favoriteRecord.source, 'https://e621.net/favorites');
  assert.deepEqual(favoriteRecord.videos.map(video => video.id), ['9200','9100']);
  assert.equal(new URL(favoriteRecord.nextPage).pathname, '/favorites');
  await favorites.bringToFront();
  await favorites.goto(favoriteFirst);
  await favorites.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('1/2'));
  await favorites.evaluate(() => document.querySelector('video').play());
  await favorites.waitForURL('**/posts/9100?**');
  await favorites.waitForFunction(() => !document.querySelector('video').paused);
  await favorites.evaluate(() => document.querySelector('video').pause());
  const routeChecks = await favorites.evaluate(() => {
    const C = E6Nav;
    const doc = new DOMParser().parseFromString('<a id="paginator-next" href="/favorites?page=2">Next</a>', 'text/html');
    const wrong = new DOMParser().parseFromString('<a id="paginator-next" href="/posts?page=2&tags=fav%3Ausername">Next</a>', 'text/html');
    return {
      next: C.nextPage(doc, 'https://e621.net/favorites?user_id=42&limit=2'),
      wrong: C.nextPage(wrong, 'https://e621.net/favorites'),
      identities: [C.pageIdentity('https://e621.net/favorites/?page=2'), C.pageIdentity('https://e621.net/favorites?page=2'), C.pageIdentity('https://e621.net/posts?page=2')],
      invalid: ['/favorites/1','/favorites.json','/posts/1'].map(path => C.searchUrl('https://e621.net'+path))
    };
  });
  assert.equal(new URL(routeChecks.next).searchParams.get('user_id'), '42');
  assert.equal(new URL(routeChecks.next).searchParams.get('limit'), '2');
  assert.equal(routeChecks.wrong, null);
  assert.equal(routeChecks.identities[0], routeChecks.identities[1]);
  assert.notEqual(routeChecks.identities[1], routeChecks.identities[2]);
  assert.deepEqual(routeChecks.invalid, [null,null,null]);
  console.log('PASS: /favorites records its real video order and auto-plays the second video; pagination keeps favorites separate from fav: search');
  store.autoPage = true;
  const favoriteFull = await context.newPage();
  await favoriteFull.bringToFront();
  await favoriteFull.goto(favoriteFirst);
  await favoriteFull.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('1/2'));
  await favoriteFull.evaluate(async () => {
    window.favoritePlayer = document.querySelector('video');
    window.favoriteIds = [];
    favoritePlayer.addEventListener('loadedmetadata', () => favoriteIds.push(favoritePlayer.querySelector('source').src.match(/\/(\d+)\.webm/)[1]));
    await favoritePlayer.play(); await favoritePlayer.requestFullscreen();
  });
  await favoriteFull.waitForFunction(() => document.querySelector('video source')?.src.includes('/8900.webm') && document.querySelector('video').ended && document.querySelector('[role="status"]')?.textContent.includes('最后一页'));
  assert.deepEqual(await favoriteFull.evaluate(() => favoriteIds), ['9100','9000','8900']);
  assert.equal(await favoriteFull.evaluate(() => document.fullscreenElement === favoritePlayer), true);
  await Promise.all([favoriteFull.waitForURL('**/posts/8900?**'), favoriteFull.evaluate(() => document.exitFullscreen())]);
  const finalFavorites = store['e6nav:context:' + await favoriteFull.evaluate(() => E6Nav.token(location.href))];
  assert.equal(new URL(finalFavorites.source).pathname, '/favorites');
  assert.deepEqual(finalFavorites.videos.map(video => video.id), ['9200','9100','9000','8900']);
  console.log('PASS: favorites auto-next and pagination preserve native fullscreen, blacklist filtering, exact list order, and the current post on exit');
  const otherFavorites = await context.newPage();
  store.endMode = 'loop';
  await otherFavorites.goto('https://e621.net/favorites?user_id=42&limit=2');
  await otherFavorites.waitForFunction(() => document.querySelector('a[href*="/posts/9100"]').hash.includes('e6nav='));
  const otherLast = await otherFavorites.locator('a[href*="/posts/9100"]').getAttribute('href');
  await otherFavorites.goto(otherLast);
  await otherFavorites.bringToFront();
  await otherFavorites.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('2/2'));
  await Promise.all([otherFavorites.waitForURL('**/posts/9000?**'), otherFavorites.keyboard.press('BracketRight')]);
  await otherFavorites.waitForFunction(() => !document.querySelector('video').paused);
  await otherFavorites.evaluate(() => document.querySelector('video').pause());
  const otherQueue = store['e6nav:context:' + await otherFavorites.evaluate(() => E6Nav.token(location.href))];
  assert.equal(new URL(otherQueue.source).searchParams.get('user_id'), '42');
  assert.equal(new URL(otherQueue.source).searchParams.get('limit'), '2');
  assert.ok(favoritesRequests.some(url => new URL(url).searchParams.get('page') === '2' && new URL(url).searchParams.get('user_id') === '42'));
  console.log('PASS: manual favorites pagination preserves the selected user, page size and source token independently of the account favorites list');
  assert.ok(pageRequests.filter(url=>new URL(url).searchParams.get('page')==='6').every(url=>new URL(url).searchParams.get('limit')==='32' && new URL(url).searchParams.get('tags')==='sound order:favcount'));
  assert.deepEqual(errors, []);
  assert.equal(temporaryTabs.size,0);
  console.log('PASS: no page script errors');
  await browser.close();
})().catch(error => { console.error(error); process.exit(1); });

async function assertEventually(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,20));
  assert.ok(predicate());
}
