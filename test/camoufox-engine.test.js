'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { wrapPage, createCamoufoxEngine, selectEngine } = require('../engines/camoufox');

function fakePlaywrightPage({ withScreencast = true } = {}) {
    const calls = [];
    const page = {
        calls,
        closed: false,
        mouse: { move: async (...a) => calls.push(['mouse.move', ...a]), click: async (...a) => calls.push(['mouse.click', ...a]) },
        keyboard: { type: async (...a) => calls.push(['keyboard.type', ...a]), press: async (...a) => calls.push(['keyboard.press', ...a]) },
        setViewportSize: async size => calls.push(['setViewportSize', size]),
        goto: async (url, options) => { calls.push(['goto', url, options]); return { status: () => 200 }; },
        screenshot: async options => { calls.push(['screenshot', options]); return Buffer.from('jpeg-bytes'); },
        isClosed: () => page.closed,
        addInitScript: async () => calls.push(['addInitScript'])
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

test('wrapPage maps the Puppeteer-style calls PyRock makes onto Playwright', async () => {
    const page = fakePlaywrightPage();
    const wrapped = wrapPage(page);
    await wrapped.setViewport({ width: 1366, height: 768 });
    await wrapped.goto('https://example.test/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await wrapped.mouse.click(3, 4);
    await wrapped.keyboard.press('Enter');
    assert.deepEqual(page.calls.find(c => c[0] === 'setViewportSize'), ['setViewportSize', { width: 1366, height: 768 }]);
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

test('the CDP-compatible session turns screencast.onFrame frames into Page.screencastFrame events', async () => {
    const page = fakePlaywrightPage();
    const session = await wrapPage(page).createCDPSession();
    const seen = [];
    session.on('Page.screencastFrame', event => seen.push(event));
    await session.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1366, maxHeight: 768 });
    assert.deepEqual(page.calls.find(c => c[0] === 'screencast.start'), ['screencast.start', { size: { width: 1366, height: 768 }, quality: 60 }]);
    await page.screencast.onFrame({ data: Buffer.from('frame-1'), timestamp: 1, viewportWidth: 1366, viewportHeight: 768 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].data, Buffer.from('frame-1').toString('base64'));
    assert.ok(seen[0].sessionId !== undefined, 'frames carry a session id like CDP');
    await session.send('Page.screencastFrameAck', { sessionId: seen[0].sessionId });
    await session.send('Page.stopScreencast');
    assert.ok(page.calls.some(c => c[0] === 'screencast.stop'));
    await session.detach();
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

test('openPage isolates each section in its own context and injects no Chromium-only stealth', async () => {
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
    assert.ok(pages.every(p => !p.calls.some(c => c[0] === 'addInitScript')), 'no window.chrome / webdriver patches: Camoufox masks at the C++ level');
    assert.ok(pages[0].calls.some(c => c[0] === 'setViewportSize'));
    await engine.closeContext(a.context);
    assert.equal(contexts[0].closed, true);
});

test('launch asks Camoufox for headless with its own cursor humanizer', async () => {
    let received = null;
    const engine = createCamoufoxEngine({ loader: async () => ({ Camoufox: async options => { received = options; return { newContext: async () => ({}), close: async () => {} }; } }) });
    await engine.launch();
    assert.equal(received.headless, true);
    assert.equal(received.humanize, true, 'the browser humanizes the cursor, so PyRock must not double-humanize');
    assert.equal(engine.humanizesCursor, true);
});

test('selectEngine defaults to chromium and only switches on ENGINE=camoufox', () => {
    assert.equal(selectEngine({}), 'chromium');
    assert.equal(selectEngine({ ENGINE: 'chromium' }), 'chromium');
    assert.equal(selectEngine({ ENGINE: 'CAMOUFOX' }), 'camoufox');
    assert.equal(selectEngine({ ENGINE: 'nonsense' }), 'chromium');
});

test('wrapPage.setExtraHTTPHeaders is a no-op: Camoufox owns request headers and Chrome-style ones would break its fingerprint', async () => {
    const page = fakePlaywrightPage();
    page.setExtraHTTPHeaders = async headers => page.calls.push(['setExtraHTTPHeaders', headers]);
    const wrapped = wrapPage(page);
    await wrapped.setExtraHTTPHeaders({ 'Sec-Fetch-Dest': 'document', Accept: 'text/html' });
    assert.equal(page.calls.some(c => c[0] === 'setExtraHTTPHeaders'), false, 'headers are not forwarded');
});

test('wrapPage frame bridge is an EventEmitter-compatible session (screencast.js uses on/off/removeListener)', async () => {
    const session = await wrapPage(fakePlaywrightPage()).createCDPSession();
    assert.ok(session instanceof EventEmitter || (typeof session.on === 'function' && typeof session.off === 'function'));
});
