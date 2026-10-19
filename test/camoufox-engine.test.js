'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { wrapPage, createCamoufoxEngine, measurePage } = require('../engines/camoufox');

function fakePlaywrightPage({ withScreencast = true, viewport = { width: 900, height: 600 } } = {}) {
    const calls = [];
    const handlers = new Map();
    const page = {
        calls,
        closed: false,
        on(type, handler) {
            if (!handlers.has(type)) handlers.set(type, []);
            handlers.get(type).push(handler);
        },
        emit(type, payload) { for (const handler of handlers.get(type) || []) handler(payload); },
        mouse: { move: async (...a) => calls.push(['mouse.move', ...a]), click: async (...a) => calls.push(['mouse.click', ...a]) },
        keyboard: { type: async (...a) => calls.push(['keyboard.type', ...a]), press: async (...a) => calls.push(['keyboard.press', ...a]) },
        viewportSize: () => viewport,
        // The fake emulates the browser's window size, and answers a document
        // inspection when the asked function looks at the DOM.
        evaluate: async fn => {
            const source = String(fn);
            if (source.includes('readyState')) {
                return { readyState: 'complete', title: 'Página', textLength: 42, spinnerish: 0 };
            }
            return { width: viewport.width, height: viewport.height };
        },
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

test('the page console errors and failed requests reach the log', async () => {
    const warnings = [];
    const pages = [];
    const browser = {
        newContext: async () => ({
            newPage: async () => { const p = fakePlaywrightPage(); pages.push(p); return p; },
            close: async () => {}
        }),
        close: async () => {}
    };
    const engine = createCamoufoxEngine({
        loader: async () => ({ Camoufox: async () => browser }),
        logger: { warn: message => warnings.push(message), info: () => {}, error: () => {} }
    });
    const opened = await engine.openPage(await engine.launch());
    opened.page.raw.emit('console', { type: () => 'error', text: () => 'boom en la página' });
    opened.page.raw.emit('requestfailed', { url: () => 'https://cdn.example/x.js', failure: () => ({ errorText: 'net::ERR_BLOCKED_BY_CLIENT' }) });
    assert.ok(warnings.some(message => /boom en la página/.test(message)), 'the console error is reported');
    assert.ok(warnings.some(message => /cdn\.example\/x\.js/.test(message)), 'the failed request is reported');
});

test('diagnosePage explains a blank preview: a page stuck loading never ran its app', async () => {
    const { diagnosePage } = require('../engines/camoufox');
    const page = fakePlaywrightPage();
    const diagnosis = await diagnosePage(page);
    assert.equal(diagnosis.readyState, 'complete');
    assert.equal(typeof diagnosis.textLength, 'number');
    assert.equal(diagnosis.spinnerish, 0);
});

test('the geolocation can be derived from the proxy IP so the fingerprint matches it', async () => {
    const original = process.env.PYROCK_GEOIP;
    const originalProxy = process.env.PYROCK_PROXY;
    process.env.PYROCK_GEOIP = '1';
    process.env.PYROCK_PROXY = 'socks5://user:pass@gw.example:824';
    try {
        let received = null;
        const engine = createCamoufoxEngine({ loader: async () => ({ Camoufox: async options => { received = options; return { newContext: async () => ({}) }; } }) });
        await engine.launch();
        assert.equal(received.proxy, 'socks5://user:pass@gw.example:824');
        assert.equal(received.geoip, true);
    } finally {
        if (original === undefined) delete process.env.PYROCK_GEOIP;
        else process.env.PYROCK_GEOIP = original;
        if (originalProxy === undefined) delete process.env.PYROCK_PROXY;
        else process.env.PYROCK_PROXY = originalProxy;
    }
});

test('the diagnosis names the requests that never finished, the usual cause of a blank page', async () => {
    const { diagnosePage } = require('../engines/camoufox');
    const page = fakePlaywrightPage();
    page.pendingRequests = () => ['https://cdn.example/challenge.js'];
    const diagnosis = await diagnosePage(page);
    assert.deepEqual(diagnosis.pending, ['https://cdn.example/challenge.js']);
});

test('ad and consent networks can be blocked, so a page waiting on one still loads', async () => {
    const original = process.env.PYROCK_BLOCK_ADS;
    process.env.PYROCK_BLOCK_ADS = '1';
    try {
        const routed = [];
        const pages = [];
        const browser = {
            newContext: async () => ({
                newPage: async () => { const p = fakePlaywrightPage(); p.route = async (pattern, handler) => { routed.push({ pattern, handler }); }; pages.push(p); return p; },
                close: async () => {}
            }),
            close: async () => {}
        };
        const engine = createCamoufoxEngine({ loader: async () => ({ Camoufox: async () => browser }) });
        await engine.openPage(await engine.launch());
        assert.equal(routed.length, 1, 'the request filter is installed');
        const blocked = [];
        const continued = [];
        const fakeRoute = (url) => ({ request: () => ({ url: () => url }), abort: async () => blocked.push(url), continue: async () => continued.push(url) });
        await routed[0].handler(fakeRoute('https://securepubads.g.doubleclick.net/tag/js/gpt.js'));
        await routed[0].handler(fakeRoute('https://browser.lol/es/create'));
        assert.equal(blocked.length, 1, 'the ad network is blocked');
        assert.equal(continued.length, 1, 'the page itself is not');
    } finally {
        if (original === undefined) delete process.env.PYROCK_BLOCK_ADS;
        else process.env.PYROCK_BLOCK_ADS = original;
    }
});

test('only a tab of the same site is followed: an ad popup must not take over the preview', async () => {
    const adopted = [];
    const pages = [];
    const context = new (require('node:events').EventEmitter)();
    context.newPage = async () => { const p = fakePlaywrightPage(); p.url = () => 'https://browser.lol/es/create'; pages.push(p); return p; };
    context.close = async () => {};
    const browser = { newContext: async () => context, close: async () => {} };
    const engine = createCamoufoxEngine({ loader: async () => ({ Camoufox: async () => browser }) });
    await engine.openPage(await engine.launch(), { onPopup: page => adopted.push(page) });

    const thirdParty = fakePlaywrightPage();
    thirdParty.url = () => 'https://ads.example/promo';
    context.emit('page', thirdParty);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(adopted.length, 0, 'a third-party popup is not followed');

    const sameSite = fakePlaywrightPage();
    sameSite.url = () => 'https://browser.lol/en/s?LINK_ID';
    context.emit('page', sameSite);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(adopted.length, 1, 'a tab of the same site is followed');
});

test('the engine reports which preview path it took: screencast or polling', async () => {
    const withScreencast = fakePlaywrightPage({ withScreencast: true });
    const session = await wrapPage(withScreencast).createCDPSession();
    await session.send('Page.startScreencast', {});
    assert.equal(session.previewMode(), 'screencast');
    const withoutScreencast = fakePlaywrightPage({ withScreencast: false });
    const polling = await wrapPage(withoutScreencast, {
        timers: { setInterval: () => ({ unref() {} }), clearInterval: () => {} }
    }).createCDPSession();
    await polling.send('Page.startScreencast', {});
    assert.equal(polling.previewMode(), 'poll');
});

test('the page exposes its current url, so the panel can show where the section really is', () => {
    const page = fakePlaywrightPage();
    page.url = () => 'https://browser.lol/es/viewer';
    const wrapped = wrapPage(page);
    assert.equal(wrapped.currentUrl(), 'https://browser.lol/es/viewer');
});

test('the browser is told to decode H.264 with the system ffmpeg and to use host ICE addresses', async () => {
    let received = null;
    const engine = createCamoufoxEngine({ loader: async () => ({ Camoufox: async options => { received = options; return { newContext: async () => ({}) }; } }) });
    await engine.launch();
    const prefs = received.firefox_user_prefs || {};
    assert.equal(prefs['media.ffmpeg.use-system-libavcodec'], true, 'H.264 needs the system libavcodec');
    assert.equal(prefs['media.ice.default_address_only'], true, 'mDNS candidates do not resolve inside a container');
});

test('each section gets its own sticky proxy port, so every section has a stable exit IP', async () => {
    const original = process.env.PYROCK_PROXY;
    const originalBase = process.env.PYROCK_PROXY_STICKY_BASE;
    process.env.PYROCK_PROXY = 'http://user:pass@gw.example:823';
    process.env.PYROCK_PROXY_STICKY_BASE = '10000';
    try {
        const contexts = [];
        const browser = {
            newContext: async options => { contexts.push(options); return { newPage: async () => fakePlaywrightPage(), close: async () => {} }; },
            close: async () => {}
        };
        const engine = createCamoufoxEngine({ loader: async () => ({ Camoufox: async () => browser }) });
        const launched = await engine.launch();
        await engine.openPage(launched, { section: { id: 's1' } });
        await engine.openPage(launched, { section: { id: 's2' } });
        assert.equal(contexts.length, 2);
        assert.deepEqual(contexts[0].proxy, { server: 'http://gw.example:10001', username: 'user', password: 'pass' });
        assert.deepEqual(contexts[1].proxy, { server: 'http://gw.example:10002', username: 'user', password: 'pass' });
    } finally {
        if (original === undefined) delete process.env.PYROCK_PROXY;
        else process.env.PYROCK_PROXY = original;
        if (originalBase === undefined) delete process.env.PYROCK_PROXY_STICKY_BASE;
        else process.env.PYROCK_PROXY_STICKY_BASE = originalBase;
    }
});

test('without a sticky base every section shares the configured proxy as it is', async () => {
    const original = process.env.PYROCK_PROXY;
    const originalBase = process.env.PYROCK_PROXY_STICKY_BASE;
    process.env.PYROCK_PROXY = 'http://user:pass@gw.example:823';
    delete process.env.PYROCK_PROXY_STICKY_BASE;
    try {
        const contexts = [];
        const browser = {
            newContext: async options => { contexts.push(options); return { newPage: async () => fakePlaywrightPage(), close: async () => {} }; },
            close: async () => {}
        };
        const engine = createCamoufoxEngine({ loader: async () => ({ Camoufox: async () => browser }) });
        const launched = await engine.launch();
        await engine.openPage(launched, { section: { id: 's1' } });
        assert.ok(!contexts[0] || contexts[0].proxy === undefined, 'no per-context proxy when no sticky base is set');
    } finally {
        if (original === undefined) delete process.env.PYROCK_PROXY;
        else process.env.PYROCK_PROXY = original;
        if (originalBase === undefined) delete process.env.PYROCK_PROXY_STICKY_BASE;
        else process.env.PYROCK_PROXY_STICKY_BASE = originalBase;
    }
});
