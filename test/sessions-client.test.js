const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHarness, createScriptHarness } = require('./helpers/client-harness');

test('initBrowser all omits active session, while section restart includes it', async () => {
  const { client, requests } = createHarness(); client.isConnected = true; client.sessionId = 's3';
  await client.initBrowser({ all: true }); await client.initBrowser();
  assert.equal(JSON.parse(requests[0].options.body).session, undefined);
  assert.equal(JSON.parse(requests[1].options.body).session, 's3');
});
test('stale stored section recovers a usable connection and selects the server default', async () => {
  const { client, sockets } = createHarness(undefined, async url => {
    if (url.includes('/api/status?session=gone')) return { ok:false,status:404,statusText:'Not Found' };
    if (url.includes('/api/status')) return { ok:true,json:async()=>({success:true,browser:'connected'}) };
    return { ok:true,json:async()=>({success:true,sessions:[{id:'s1',name:'Default',url:''}],default:'s1',max:5}) };
  });
  client.sessionId = 'gone'; let recovered = false;
  client.onSessionGone = async () => { const result = await client.listSessions(); client.switchSession(result.default); recovered = true; };
  assert.equal(await client.connect(), true);
  assert.equal(client.sessionId, 's1');
  assert.equal(client.isConnected, true);
  assert.ok(sockets.length);
  assert.equal(recovered, true);
});

test('makeRequest invokes onSessionGone from actual 404 response', async () => {
  const { client } = createHarness(undefined, async () => ({ ok:false,status:404,statusText:'Not Found' }));
  client.isConnected = true; client.sessionId='gone'; let reported; client.onSessionGone=id=>reported=id;
  await assert.rejects(client.makeRequest('/api/navigate','POST',{url:'https://x.test'}),e=>e.status===404); assert.equal(reported,'gone');
});
test('real socket 4404 reports stale ID and does not reconnect', () => {
  const {client,sockets,timers}=createHarness();client.isConnected=true;client.sessionId='gone';let reported;client.onSessionGone=id=>reported=id;
  client.openPreviewSocket(0);sockets[0].close(4404);assert.equal(reported,'gone');assert.equal(timers.some(t=>!t.cancelled&&t.delay===1000),false);
});

test('late manual screenshot from an inactive section does not replace the shared preview', async () => {
  const { client } = createHarness();
  client.isConnected = true; client.sessionId = 's1';
  let resolve;
  const pending = new Promise(r => resolve = r);
  client.makeRequest = async () => pending;
  const images = []; client.onScreenshotUpdate = image => images.push(image);
  const request = client.takeScreenshot();
  client.switchSession('s2');
  resolve({success:true,screenshot:'section-a-image'});
  await request;
  assert.deepEqual(images, []);
});

test('the inline add input arrives pre-filled with the next section name, still editable', async () => {
  const h=createScriptHarness({sessions:[{id:'s1',name:'Sección 1',url:'/'}]});await h.load();
  h.elements.get('sessionAdd').dispatch('click');
  const input=h.elements.get('sessionList').children[0].children[0];
  assert.equal(input.value,'Sección 2','next name pre-filled');
  input.value='Mi sección';input.dispatch('keydown',{key:'Enter'});await new Promise(r=>setImmediate(r));
  assert.ok(h.operations.some(x=>x[0]==='create'&&x[1]==='Mi sección'),'editing before Enter is respected');
});

test('sidebar add opens inline input; Escape and blur cancel; Enter creates and selects', async () => {
  const h=createScriptHarness();await h.load();const add=h.elements.get('sessionAdd');add.dispatch('click');
  let list=h.elements.get('sessionList'),input=list.children[0].children[0];assert.equal(input.tag,'input');input.dispatch('keydown',{key:'Escape'});assert.equal(list.children.length,1);
  add.dispatch('click');input=list.children[0].children[0];input.blur();assert.equal(list.children.length,1);
  add.dispatch('click');input=list.children[0].children[0];input.value='New tab';input.dispatch('keydown',{key:'Enter'});await new Promise(r=>setImmediate(r));
  assert.ok(h.operations.some(x=>x[0]==='create'&&x[1]==='New tab'));assert.equal(h.client.sessionId,'s2');
});
test('selecting section switches client and updates aria-current; malicious name remains text', async () => {
  const h=createScriptHarness({sessions:[{id:'s1',name:'one',url:'/'},{id:'s2',name:'<b>evil</b>',url:'/two'}]});await h.load();
  const li=h.elements.get('sessionList').children[1],button=li.children[0];button.dispatch('click');await new Promise(r=>setImmediate(r));
  assert.ok(h.operations.some(x=>x[0]==='switch'&&x[1]==='s2'));
  const selected=h.elements.get('sessionList').children[1].children[0];assert.equal(selected.getAttribute('aria-current'),'true');
  assert.equal(selected.children[1].textContent,'<b>evil</b>');assert.equal(selected.children[1].innerHTML,undefined);assert.equal(selected.title,'<b>evil</b>');
});
test('closing active section selects its adjacent neighbor; final close disabled; max disables add', async () => {
  const h=createScriptHarness({sessions:[{id:'s1',name:'one'},{id:'s2',name:'two'},{id:'s3',name:'three'}],max:3});await h.load();
  const list=h.elements.get('sessionList');assert.equal(h.elements.get('sessionAdd').disabled,true);assert.equal(list.children[0].children[1].disabled,false);
  list.children[1].children[0].dispatch('click');
  let close=list.children[1].children[1];close.dispatch('click');close.dispatch('click');await new Promise(r=>setImmediate(r));
  assert.ok(h.operations.some(x=>x[0]==='switch'&&x[1]==='s1'));
  await h.api().refreshSessions();assert.equal(h.elements.get('sessionAdd').disabled,false);
});
test('close confirmation expires and starting another confirmation disarms the first', async () => {
  const h=createScriptHarness({sessions:[{id:'s1',name:'one'},{id:'s2',name:'two'},{id:'s3',name:'three'}]});await h.load();
  const list=h.elements.get('sessionList');const first=list.children[0].children[1], second=list.children[1].children[1];
  first.dispatch('click');const timer=h.timers.at(-1);timer.fn();
  assert.equal(first.dataset.confirm,'');
  first.dispatch('click');second.dispatch('click');
  assert.equal(first.dataset.confirm,'');
  first.dispatch('click');
  assert.ok(h.timers.at(-1).delay===3000);
  const expiry=h.timers.at(-1);expiry.fn();
  first.dispatch('click');
  assert.equal(h.operations.some(x=>x[0]==='close'&&x[1]==='s1'),false);
  first.dispatch('click');await new Promise(r=>setImmediate(r));
  assert.ok(h.operations.some(x=>x[0]==='close'&&x[1]==='s1'));
});

test('a single remaining section has a disabled close control', async () => {
  const h=createScriptHarness({sessions:[{id:'s1',name:'only'}]});await h.load();
  assert.equal(h.elements.get('sessionList').children[0].children[1].disabled,true);
});
test('closing first active section switches to its live next neighbor', async () => {
  const h=createScriptHarness({sessions:[{id:'s1',name:'one'},{id:'s2',name:'two'}]});await h.load();
  const close=h.elements.get('sessionList').children[0].children[1];close.dispatch('click');close.dispatch('click');await new Promise(r=>setImmediate(r));
  assert.equal(h.client.sessionId,'s2');assert.ok(h.operations.some(x=>x[0]==='switch'&&x[1]==='s2'));
});
test('stored section is restored and invalid stored section falls back to server default', async () => {
  const sessions=[{id:'s1',name:'one'},{id:'s2',name:'two'}];
  const valid=createScriptHarness({sessions,storedId:'s2'});await valid.load();assert.equal(valid.options.sessionId,'s2');assert.equal(valid.client.sessionId,'s2');
  const stale=createScriptHarness({sessions,storedId:'gone',defaultId:'s2'});await stale.load();assert.ok(stale.operations.some(x=>x[0]==='switch'&&x[1]==='s2'));
});
test('script is pinned to start section; indicators are suppressed after UI switches', async () => {
  let release;const gate=new Promise(r=>release=r);
  const h=createScriptHarness({sessions:[{id:'s1',name:'one'},{id:'s2',name:'two'}],onExecute:()=>gate});await h.load();
  h.elements.get('scriptEditor').value='click';h.elements.get('preview').naturalWidth=500;h.elements.get('preview').naturalHeight=300;const running=h.api().executeScript();await new Promise(r=>setImmediate(r));
  h.elements.get('sessionList').children[1].children[0].dispatch('click');release();await running;
  assert.ok(h.operations.some(x=>x[0]==='execute'&&x[1]==='s1'));assert.equal(h.document.querySelector('.preview-container').children.length,0);
});
test('restart button handler restarts only active section', async () => {
  const h=createScriptHarness({sessions:[{id:'s1',name:'one'},{id:'s2',name:'two'}]});await h.load();
  h.elements.get('sessionList').children[1].children[0].dispatch('click');await h.api().initBrowser();assert.ok(h.operations.some(x=>x[0]==='restart'&&x[1]==='s2'));
});
test('the inline add-section input is not covered by the tally dot', () => {
  const css=fs.readFileSync('public/styles.css','utf8');
  assert.match(css,/#sessionList\s+li:has\(input\)::before\s*\{[^}]*display:\s*none/);
});
test('CSS reserves rail space and markup exposes accessible sidebar', () => {
  const html=fs.readFileSync('public/index.html','utf8'),css=fs.readFileSync('public/styles.css','utf8');
  assert.match(html,/<nav class="session-rail" aria-label="Secciones">/);
  assert.match(css,/--rail-width:\s*280px/);assert.match(css,/grid-template-columns:\s*var\(--rail-width\)\s+1fr\s+var\(--rack-width\)/);
});
