'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { wrapPage, createCamoufoxEngine, measurePage } = require('../engines/camoufox');

function fakePlaywrightPage({ withScreencast = true, viewport = { width: 900, height: 600 } } = {}) {
    const calls = [];
    const page = {
        calls,
        closed: false,
        mouse: { move: async (...a) => calls.push(['mouse.move', ...a]), click: async (...a) => calls.push(['mouse.click', ...a]) },
        keyboard: { type: async (...a) => calls.push(['keyboard.type', ...a]), press: async (...a) => calls.push(['keyboard.press', ...a]) },
        viewportSize: () => viewport,
        // The fake emulates the browser's window size: the real evaluate runs
        // inside the page, where window.innerWidth/innerHeight exist.
        evaluate: async () => ({ width: viewport.width, height: viewport.height }),
        goto: async (url, options) => { calls.push(['goto', url, options]); return { status: () => 200, statusText: () => 'OK' }; },
        screenshot: async options => { calls.push(['screenshot', options]); return Buffer.from('jpeg-bytes'); },
        isClosed: () => page.closed
    };
    if (withScreencast) {
        page.screencast = {
            onFrame: null,
            start: async options => { calls.push(['screencast.start', { size: options.size, quality: options.quality }]); page.screencast.onFrame = options.onFrame; },
            stop: async () => { calls.push(['screencast.stop']); page.screencast.onFrame = null; }
        };
    }
    return page;
}

test('wrapPage maps the calls PyRock makes onto Playwright', async () => {
    const page = fakePlaywrightPage();
    const wrapped = wrapPage(page);
    await wrapped.goto('https://example.test/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await wrapped.mouse.click(3, 4);
    await wrapped.keyboard.press('Enter');
    assert.deepEqual(page.calls.find(c => c[0] === 'goto'), ['goto', 'https://example.test/', { waitUntil: 'domcontentloaded', timeout: 45000 }]);
    assert.ok(page.calls.some(c => c[0] === 'mouse.click' && c[1] === 3 && c[2] === 4));
    assert.ok(page.calls.some(c => c[0] === 'keyboard.press' && c[1] === 'Enter'));
    assert.equal(wrapped.isClosed(), false);
});

test('wrapPage.screenshot returns a base64 string when encoding is base64, a Buffer otherwise', async () => {
    const wrapped = wrapPage(fakePlaywrightPage());
    const asBase64 = await wrapped.screenshot({ encoding: 'base64', quality: 60, type: 'jpeg' });
    assert.equal(asBase64, Buffer.from('jpeg-bytes').toString('base64'));
    const asBuffer = await wrapped.screenshot({ type: 'jpeg' });
    assert.ok(Buffer.isBuffer(asBuffer));
});

test('manual screenshots are taken in CSS pixels so they match the live frames', async () => {
    const page = fakePlaywrightPage();
    const wrapped = wrapPage(page);
    await wrapped.screenshot({ encoding: 'base64', quality: 60, type: 'jpeg' });
    const shot = page.calls.find(c => c[0] === 'screenshot');
    assert.equal(shot[1].scale, 'css', 'scale:css keeps the click mapping honest');
});

test('the CDP-compatible session turns screencast.onFrame frames into Page.screencastFrame events', async () => {
    const page = fakePlaywrightPage();
    const session = await wrapPage(page).createCDPSession();
    const seen = [];
    session.on('Page.screencastFrame', event => seen.push(event));
    await session.send('Page.startScreencast', { format: 'jpeg', quality: 60 });
    assert.deepEqual(page.calls.find(c => c[0] === 'screencast.start'), ['screencast.start', { size: { width: 900, height: 600 }, quality: 60 }]);
    await page.screencast.onFrame({ data: Buffer.from('frame-1'), timestamp: 1, viewportWidth: 900, viewportHeight: 600 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].data, Buffer.from('frame-1').toString('base64'));
    assert.ok(seen[0].sessionId !== undefined, 'frames carry a session id like CDP');
    await session.send('Page.screencastFrameAck', { sessionId: seen[0].sessionId });
    await session.send('Page.stopScreencast');
    assert.ok(page.calls.some(c => c[0] === 'screencast.stop'));
    await session.detach();
});

test('frames are requested at the page own CSS size, so preview clicks land where they are aimed', async () => {
    const page = fakePlaywrightPage({ viewport: { width: 1234, height: 567 } });
    const session = await wrapPage(page).createCDPSession();
    await session.send('Page.startScreencast', {});
    assert.deepEqual(page.calls.find(c => c[0] === 'screencast.start')[1].size, { width: 1234, height: 567 });
    await session.send('Page.stopScreencast');
});

test('measurePage falls back to the window size when the page has no viewport', async () => {
    const page = fakePlaywrightPage();
    page.viewportSize = () => null;
    const size = await measurePage(page);
    assert.deepEqual(size, { width: 900, height: 600 });
});

test('without page.screencast the session falls back to polling screenshots', async () => {
    const page = fakePlaywrightPage({ withScreencast: false });
    const timers = [];
    const session = await wrapPage(page, {
        timers: { setInterval: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return t; }, clearInterval: t => { t.cancelled = true; } },
        fallbackIntervalMs: 150
    }).createCDPSession();
    const seen = [];
    session.on('Page.screencastFrame', event => seen.push(event));
    await session.send('Page.startScreencast', {});
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 150);
    await timers[0].fn();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].data, Buffer.from('jpeg-bytes').toString('base64'));
    await session.send('Page.stopScreencast');
    assert.equal(timers[0].cancelled, true, 'stopping clears the polling timer');
});

test('openPage isolates each section in its own context and never pins a viewport', async () => {
    const pages = [];
    const contexts = [];
    const browser = {
        newContext: async options => {
            const ctx = { options, closed: false, close: async () => { ctx.closed = true; }, newPage: async () => { const p = fakePlaywrightPage(); pages.push(p); return p; } };
            contexts.push(ctx);
            return ctx;
        },
        close: async () => {}
    };
    const engine = createCamoufoxEngine({ loader: async () => ({ Camoufox: async () => browser }) });
    const launched = await engine.launch();
    const a = await engine.openPage(launched);
    const b = await engine.openPage(launched);
    assert.equal(contexts.length, 2, 'one browser context per section');
    assert.notStrictEqual(a.context, b.context);
    assert.deepEqual(contexts[0].options, undefined, 'no context options: Camoufox owns the fingerprint');
    assert.ok(pages.every(p => !p.calls.some(c => c[0] === 'setViewportSize')), 'no viewport is pinned: an explicit one breaks the spoofed window');
    await engine.closeContext(a.context);
    assert.equal(contexts[0].closed, true);
});

test('launch asks Camoufox for headless and leaves cursor humanization to PyRock', async () => {
    let received = null;
    const engine = createCamoufoxEngine({ loader: async () => ({ Camoufox: async options => { received = options; return { newContext: async () => ({}), close: async () => {} }; } }) });
    await engine.launch();
    assert.equal(received.headless, true);
    assert.equal(received.humanize, false, 'Camoufox humanization is launch-time only; PyRock humanizes per request');
    assert.equal(engine.humanizesCursor, false);
    assert.ok(received.os, 'an operating system is chosen for the fingerprint');
    assert.ok(received.locale, 'a locale is set for the fingerprint');
});

test('a residential proxy can be set, so the exit IP is not a datacenter one', async () => {
    const original = process.env.PYROCK_PROXY;
    process.env.PYROCK_PROXY = 'http://user:secret@residential.example:8080';
    try {
        let received = null;
        const engine = createCamoufoxEngine({ loader: async () => ({ Camoufox: async options => { received = options; return { newContext: async () => ({}) }; } }) });
        await engine.launch();
        assert.equal(received.proxy, 'http://user:secret@residential.example:8080', 'the proxy reaches the browser launch');
    } finally {
        if (original === undefined) delete process.env.PYROCK_PROXY;
        else process.env.PYROCK_PROXY = original;
    }
});

test('no proxy is configured by default', async () => {
    const original = process.env.PYROCK_PROXY;
    delete process.env.PYROCK_PROXY;
    try {
        let received = null;
        const engine = createCamoufoxEngine({ loader: async () => ({ Camoufox: async options => { received = options; return { newContext: async () => ({}) }; } }) });
        await engine.launch();
        assert.equal(received.proxy, undefined);
    } finally {
        if (original !== undefined) process.env.PYROCK_PROXY = original;
    }
});

test('the loader accepts an ESM namespace and a CommonJS default export', async () => {
    const esm = createCamoufoxEngine({ loader: async () => ({ Camoufox: async () => ({ newContext: async () => ({}) }) }) });
    await esm.launch();
    const cjs = createCamoufoxEngine({ loader: async () => ({ default: { Camoufox: async () => ({ newContext: async () => ({}) }) } }) });
    await cjs.launch();
});

test('wrapPage leaves the fingerprint to Camoufox: no viewport, user agent, headers or injected scripts', async () => {
    const page = fakePlaywrightPage();
    const wrapped = wrapPage(page);
    await wrapped.setViewport({ width: 1366, height: 768 });
    await wrapped.setUserAgent('Chrome/120');
    await wrapped.setExtraHTTPHeaders({ 'Sec-Fetch-Dest': 'document' });
    await wrapped.evaluateOnNewDocument(() => {});
    assert.equal(page.calls.length, 0, 'nothing is pushed into the page');
});

test('wrapPage frame bridge is an EventEmitter-compatible session (screencast.js uses on/off/removeListener)', async () => {
    const session = await wrapPage(fakePlaywrightPage()).createCDPSession();
    assert.ok(session instanceof EventEmitter || (typeof session.on === 'function' && typeof session.off === 'function'));
});
