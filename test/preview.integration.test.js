'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

// Fail safely before importing the old self-starting server during the RED run.
test('live preview preserves REST controls through navigation, reconnect and reset', { timeout: 90000 }, async (t) => {
    const source = readFileSync(join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(source, /require\.main\s*===\s*module/, 'server must be importable without starting a browser');
    const puppeteer = require('puppeteer');
    const { WebSocket } = require('ws');
    const { app, server, startServer, stopServer } = require('../server');
    let viewerBrowser;
    const sockets = new Set();
    t.after(async () => {
        for (const socket of sockets) socket.terminate();
        if (viewerBrowser) await viewerBrowser.close();
        await stopServer();
    });
    let submitted;
    app.get('/__test/submitted', (req, res) => {
        submitted = req.query.value;
        res.sendStatus(204);
    });
    app.get('/__test/result', (_req, res) => res.json({ submitted }));
    app.get('/__test/fixture', (_req, res) => res.type('html').send(`<!doctype html>
        <html><body style="margin:0;background:#fff">
        <button id="focus" style="position:absolute;left:20px;top:20px;width:150px;height:40px"
          onclick="document.querySelector('input').focus()">Focus input</button>
        <input style="position:absolute;left:20px;top:80px" id="value">
        <div id="counter" style="position:absolute;left:220px;top:20px;font:48px monospace"></div>
        <script>let n=0;setInterval(()=>{document.querySelector('#counter').textContent=++n;
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

    viewerBrowser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const viewer = await viewerBrowser.newPage();
    const failures = [];
    const automaticScreenshots = [];
    let manual = false;
    viewer.on('pageerror', (error) => failures.push(error.message));
    await viewer.setRequestInterception(true);
    viewer.on('request', (request) => {
        // Configure the real client to use this isolated server's ephemeral port.
        // The existing localhost auto-detection defaults to port 3000.
        if (request.url() === `${base}/config.js`) {
            const config = readFileSync(join(__dirname, '..', 'public', 'config.js'), 'utf8');
            void request.respond({ status: 200, contentType: 'application/javascript',
                body: `${config}\nwindow.PyRockConfig.serverUrl = ${JSON.stringify(base)};` });
        } else if (request.url().startsWith(base) || request.url().startsWith('data:')) {
            if (request.url().includes('/api/screenshot') && !manual) automaticScreenshots.push(request.method());
            void request.continue();
        } else void request.abort();
    });
    await viewer.goto(base, { waitUntil: 'domcontentloaded' });
    await viewer.waitForFunction(() => typeof pyrock !== 'undefined' && pyrock && pyrock.isConnected);
    await viewer.evaluate((url) => pyrock.navigate(url), `${base}/__test/fixture`);
    await viewer.waitForFunction(() => {
        const image = document.querySelector('#preview');
        return image.complete && image.naturalWidth === 1366 && image.naturalHeight === 768;
    });
    const first = await viewer.$eval('#preview', (image) => image.src);
    await viewer.waitForFunction((previous) => document.querySelector('#preview').src !== previous, {}, first);
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
    }, {}, `${base}/__test/result`);
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
    await viewer.waitForFunction((previous) => document.querySelector('#preview').src !== previous, {}, frozen);
    assert.equal(automaticScreenshots.length, 0, 'REST controls and reconnect must not trigger automatic screenshots');
    assert.deepEqual(failures, [], 'no browser JavaScript exceptions');
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.browserReady, true);
    await stopServer();
    await stopServer();
});
