'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

// Fail safely before importing the old self-starting server during the RED run.
test('live preview preserves REST controls through navigation, reconnect and reset', { timeout: 90000 }, async (t) => {
    const source = readFileSync(join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(source, /require\.main\s*===\s*module/, 'server must be importable without starting a browser');
    const path = require('node:path');
    const originalModule = process.env.PYROCK_CAMOUFOX_MODULE;
    const originalProxy = process.env.PYROCK_PROXY;
    const originalStickyBase = process.env.PYROCK_PROXY_STICKY_BASE;
    // The server under test runs on a real browser through the camoufox-js contract.
    process.env.PYROCK_CAMOUFOX_MODULE = path.join(__dirname, 'fixtures', 'playwright-chromium-camoufox.js');
    // The local .env must not decide how this test reaches the network: a proxy
    // would send the test server itself through a remote gateway.
    process.env.PYROCK_PROXY = '';
    process.env.PYROCK_PROXY_STICKY_BASE = '';
    const { WebSocket } = require('ws');
    const { chromium } = require('playwright-core');
    const { chromiumExecutable } = require('./helpers/chromium-binary');
    const { app, server, startServer, stopServer } = require('../server');
    let viewerBrowser;
    const sockets = new Set();
    t.after(async () => {
        // Each cleanup step is isolated: one failure must not skip the rest, or the
        // browser process and its server stay alive and the test never exits.
        for (const socket of sockets) { try { socket.terminate(); } catch { /* already closed */ } }
        if (viewerBrowser) { try { await viewerBrowser.close(); } catch { /* already gone */ } }
        try { await stopServer(); } catch { /* already stopped */ }
        try { await require('./fixtures/playwright-chromium-camoufox').stop(); } catch { /* already gone */ }
        if (originalModule === undefined) delete process.env.PYROCK_CAMOUFOX_MODULE;
        else process.env.PYROCK_CAMOUFOX_MODULE = originalModule;
        if (originalProxy === undefined) delete process.env.PYROCK_PROXY;
        else process.env.PYROCK_PROXY = originalProxy;
        if (originalStickyBase === undefined) delete process.env.PYROCK_PROXY_STICKY_BASE;
        else process.env.PYROCK_PROXY_STICKY_BASE = originalStickyBase;
    });
    let submitted;
    app.get('/__test/submitted', (req, res) => {
        submitted = req.query.value;
        res.sendStatus(204);
    });
    app.get('/__test/result', (_req, res) => res.json({ submitted }));
    let observedPageSize = null;
    app.post('/__test/page-size', (req, res) => { observedPageSize = req.body; res.sendStatus(204); });
    app.get('/__test/page-size', (_req, res) => res.json(observedPageSize));
    app.get('/__test/fixture', (_req, res) => res.type('html').send(`<!doctype html>
        <html><body style="margin:0;background:#fff">
        <button id="focus" style="position:absolute;left:20px;top:20px;width:150px;height:40px"
          onclick="document.querySelector('input').focus()">Focus input</button>
        <input style="position:absolute;left:20px;top:80px" id="value">
        <div id="counter" style="position:absolute;left:220px;top:20px;font:48px monospace"></div>
        <script>fetch('/__test/page-size',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({w:innerWidth,h:innerHeight})});
        let n=0;setInterval(()=>{document.querySelector('#counter').textContent=++n;
        document.body.style.background=n%2?'#efffee':'#eeeeff'},150);
        document.querySelector('input').addEventListener('keydown',e=>{
        if(e.key==='Enter')fetch('/__test/submitted?value='+encodeURIComponent(document.querySelector('input').value));
        });</script></body></html>`));
    await startServer({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (route, body) => {
        const response = await fetch(`${base}/api/${route}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
        });
        assert.equal(response.status, 200, route);
        const data = await response.json();
        assert.equal(data.success, true, JSON.stringify(data));
        return data;
    };
    const connect = (path = '/ws/preview', origin = base) => new WebSocket(base.replace('http:', 'ws:') + path, { origin });
    const rejected = async (path, origin) => {
        const socket = connect(path, origin);
        await new Promise((resolve, reject) => {
            socket.once('open', () => { socket.terminate(); reject(new Error('unexpected upgrade')); });
            socket.once('error', resolve);
        });
    };
    await rejected('/ws/not-preview', base);
    await rejected('/ws/preview', 'http://different.invalid');

    viewerBrowser = await chromium.launch({
        executablePath: chromiumExecutable(),
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const viewer = await viewerBrowser.newPage();
    const failures = [];
    const automaticScreenshots = [];
    let manual = false;
    viewer.on('pageerror', (error) => failures.push(error.message));
    await viewer.route('**/*', async route => {
        // Configure the real client to use this isolated server's ephemeral port.
        // The existing localhost auto-detection defaults to port 3000.
        const url = route.request().url();
        if (url === `${base}/config.js`) {
            const config = readFileSync(join(__dirname, '..', 'public', 'config.js'), 'utf8');
            await route.fulfill({ status: 200, contentType: 'application/javascript',
                body: `${config}\nwindow.PyRockConfig.serverUrl = ${JSON.stringify(base)};` });
        } else if (url.startsWith(base) || url.startsWith('data:')) {
            if (url.includes('/api/screenshot') && !manual) automaticScreenshots.push(route.request().method());
            await route.continue();
        } else await route.abort();
    });
    await viewer.goto(base, { waitUntil: 'domcontentloaded' });
    await viewer.waitForFunction(() => typeof pyrock !== 'undefined' && pyrock && pyrock.isConnected);
    await viewer.evaluate((url) => pyrock.navigate(url), `${base}/__test/fixture`);
    await viewer.waitForFunction(() => {
        const image = document.querySelector('#preview');
        // The initial hidden GIF is already complete and 1x1: wait for an
        // actual preview frame before asserting its coordinate dimensions.
        return image.src.startsWith('data:image/jpeg') && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
    });
    // The preview frame is the page's own CSS size: the client maps a click on the
    // image back to page coordinates through the image's pixel size, so the two
    // must agree exactly or clicks land off target.
    const pageSize = await (await fetch(`${base}/__test/page-size`)).json();
    const frameSize = await viewer.$eval('#preview', image => ({ w: image.naturalWidth, h: image.naturalHeight }));
    assert.deepEqual(frameSize, { w: pageSize.w, h: pageSize.h }, 'the preview frame matches the page CSS size');
    const first = await viewer.$eval('#preview', (image) => image.src);
    await viewer.waitForFunction((previous) => document.querySelector('#preview').src !== previous, first);
    assert.equal(automaticScreenshots.length, 0, 'no automatic GET/POST screenshots');

    // Exercise the existing public client: actions must remain REST calls.
    await viewer.evaluate(async () => {
        await pyrock.click(60, 40);
        await pyrock.type('preview-check');
        await pyrock.pressKey('Enter');
    });
    await viewer.waitForFunction(async (url) => {
        const result = await (await fetch(url)).json();
        return result.submitted === 'preview-check';
    }, `${base}/__test/result`);
    manual = true;
    const capture = await viewer.evaluate(() => pyrock.takeScreenshot());
    assert.equal(capture.success, true);
    assert.match(capture.screenshot, /^data:image\/jpeg;base64,/);
    const cached = await (await fetch(`${base}/api/screenshot`)).json();
    assert.equal(cached.screenshot, capture.screenshot);
    manual = false;

    // A second viewer must receive frames without disrupting the UI viewer.
    const observe = () => {
        const socket = connect();
        sockets.add(socket);
        const frames = [];
        socket.on('message', (raw) => {
            const message = JSON.parse(raw);
            if (message.type === 'frame') {
                frames.push(message);
                if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ack', id: message.id }));
            }
        });
        return { socket, frames };
    };
    const awaitFrame = (observer, after = 0) => new Promise((resolve, reject) => {
        if (observer.frames.some((frame) => frame.id > after)) return resolve();
        const timer = setTimeout(() => { cleanup(); reject(new Error('no new preview frame')); }, 15000);
        const onMessage = () => {
            if (observer.frames.some((frame) => frame.id > after)) { cleanup(); resolve(); }
        };
        function cleanup() { clearTimeout(timer); observer.socket.off('message', onMessage); }
        observer.socket.on('message', onMessage);
    });
    const second = observe();
    await awaitFrame(second);
    const previousId = second.frames.at(-1).id;
    await post('init');
    await post('navigate', { url: `${base}/__test/fixture` });
    await awaitFrame(second, previousId);
    assert(second.frames.at(-1).id > previousId, 'frame IDs survive browser replacement');
    second.socket.close();

    await viewer.evaluate(() => pyrock.disconnect());
    const frozen = await viewer.$eval('#preview', (image) => image.src);
    await viewer.evaluate(() => pyrock.connect());
    await viewer.waitForFunction((previous) => document.querySelector('#preview').src !== previous, frozen);
    assert.equal(automaticScreenshots.length, 0, 'REST controls and reconnect must not trigger automatic screenshots');
    assert.deepEqual(failures, [], 'no browser JavaScript exceptions');
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.browserReady, true);
    await stopServer();
    await stopServer();
});
