'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionManager } = require('../sessions');
const { EventEmitter } = require('node:events');

test('public sessions API lists default and creates isolated sections', async t => {
    const puppeteer = require('puppeteer');
    const originalLaunch = puppeteer.launch;
    const contexts = [];
    const pages = [];
    const browsers = [];
    let blockedPageCreation = null;
    class Browser extends EventEmitter {
        constructor() { super(); this.closeCount = 0; browsers.push(this); }
        async close() { this.closeCount++; this.emit('disconnected'); }
        async createBrowserContext() {
            const context = {
                closed: false,
                async newPage() {
                    if (blockedPageCreation) {
                        const gate = blockedPageCreation;
                        gate.enteredResolve();
                        await gate.released;
                        blockedPageCreation = null;
                    }
                    const page = new EventEmitter();
                    page.calls = [];
                    pages.push(page);
                    page.url = () => 'about:blank';
                    page.setViewport = page.setUserAgent = page.setExtraHTTPHeaders = page.evaluateOnNewDocument = async () => {};
                    page.screenshot = async () => Buffer.from('shot');
                    page.mouse = { click: async (...args) => page.calls.push(['click', ...args]) };
                    page.keyboard = { type: async value => page.calls.push(['type', value]), press: async value => page.calls.push(['key', value]) };
                    page.goto = async value => { page.calls.push(['navigate', value]); return null; };
                    return page;
                },
                async close() { this.closed = true; }
            };
            contexts.push(context);
            return context;
        }
    }
    puppeteer.launch = async () => new Browser();
    const { server, startServer, stopServer } = require('../server');
    t.after(async () => { await stopServer(); puppeteer.launch = originalLaunch; });
    await startServer({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${server.address().port}`;
    const listing = await fetch(`${base}/api/sessions`);
    assert.equal(listing.status, 200);
    const first = await listing.json();
    assert.deepEqual({ default: first.default, max: first.max, ids: first.sessions.map(s => s.id) }, { default: 's1', max: 5, ids: ['s1'] });
    const badName = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '   ' }) });
    assert.equal(badName.status, 400);
    const created = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '  Cuenta  ' }) });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).session.name, 'Cuenta');
    assert.equal(contexts.length, 2);
    const second = (await (await fetch(`${base}/api/sessions`)).json()).sessions[1];
    const WebSocket = require('ws');
    const previewResult = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws/preview?session=missing`, { headers: { Origin: base } });
        const messages = [];
        ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
        ws.on('error', reject);
        ws.on('close', (code) => resolve({ code, messages }));
    });
    assert.equal(previewResult.code, 4404);
    assert.deepEqual(previewResult.messages, [{ type: 'status', state: 'unavailable', message: 'Sección no encontrada' }]);
    const unknown = await fetch(`${base}/api/click`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 1, y: 2, session: 'missing' }) });
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { success: false, error: 'Sección no encontrada' });
    const click = await fetch(`${base}/api/click`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 3, y: 4, session: second.id }) });
    assert.equal(click.status, 200);
    assert.deepEqual(pages[1].calls, [['click', 3, 4]]);
    await fetch(`${base}/api/click`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 8, y: 9 }) });
    await fetch(`${base}/api/type`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hello', session: second.id }) });
    await fetch(`${base}/api/key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'Enter', session: second.id }) });
    await fetch(`${base}/api/navigate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.test/', session: second.id }) });
    assert.deepEqual(pages[0].calls, [['click', 8, 9]], 'omitted session routes to the default section');
    assert.deepEqual(pages[1].calls, [['click', 3, 4], ...Array.from('hello', (ch) => ['type', ch]), ['key', 'Enter'], ['navigate', 'https://example.test/']], 'humanized typing reaches the page per character, in order');
    const capture = await fetch(`${base}/api/screenshot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: second.id }) });
    assert.equal((await capture.json()).success, true);
    assert.equal((await (await fetch(`${base}/api/screenshot?session=${second.id}`)).json()).screenshot, 'data:image/jpeg;base64,shot');
    const restarted = await fetch(`${base}/api/init`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: second.id }) });
    assert.equal((await restarted.json()).success, true);
    assert.equal((await (await fetch(`${base}/api/sessions`)).json()).sessions[1].name, 'Cuenta');
    const allRestarted = await fetch(`${base}/api/init`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await allRestarted.json()).success, true);
    const afterRestart = (await (await fetch(`${base}/api/sessions`)).json()).sessions;
    assert.deepEqual(afterRestart.map(item => item.id), ['s1', second.id]);
    assert.equal(afterRestart[1].name, 'Cuenta');
    browsers.at(-1).emit('disconnected');
    const unavailable = (await (await fetch(`${base}/api/sessions`)).json()).sessions;
    assert.deepEqual(unavailable.map(item => item.state), ['unavailable', 'unavailable']);
    const lastClose = await fetch(`${base}/api/sessions/s1`, { method: 'DELETE' });
    assert.equal(lastClose.status, 200);
    const refuseLast = await fetch(`${base}/api/sessions/${second.id}`, { method: 'DELETE' });
    assert.equal(refuseLast.status, 409);

    let enteredResolve;
    let releaseResolve;
    const gate = {
        entered: new Promise(resolve => { enteredResolve = resolve; }),
        enteredResolve: () => enteredResolve(),
        released: new Promise(resolve => { releaseResolve = resolve; }),
        release: () => releaseResolve()
    };
    blockedPageCreation = gate;
    const pendingCreate = fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'InFlight' }) });
    await gate.entered;
    let createSettled = false;
    pendingCreate.then(() => { createSettled = true; });
    const stopping = stopServer();
    assert.equal(createSettled, false, 'the create request must remain pending while newPage is blocked');
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200, 'the HTTP server remains available while shutdown drains the in-flight create');
    const during = await (await fetch(`${base}/api/sessions`)).json();
    assert.ok(during.sessions.every(session => session.name !== 'InFlight'), 'a section is not registered before page setup finishes');
    gate.release();
    const rejectedCreate = await (await pendingCreate).json();
    assert.equal(rejectedCreate.success, false, 'in-flight create must not be reported as created');
    assert.equal(rejectedCreate.session, undefined, 'failed in-flight creation must not leak a session in its response');
    await stopping;
    assert.ok(contexts.every(context => context.closed), 'all contexts, including the blocked one, must be closed');
    assert.equal(browsers.at(-1).closeCount, 1, 'the active browser must be closed before shutdown resolves');
});

test('session manager creates ordered isolated sections and chooses oldest remaining default', async () => {
    const closed = [];
    let serial = 0;
    const manager = createSessionManager({
        maxSessions: 2,
        openPage: async () => ({ context: `context-${++serial}`, page: `page-${serial}` }),
        closeContext: async context => closed.push(context),
        createController: () => ({ close: async () => {} })
    });
    const first = await manager.create();
    const second = await manager.create({ name: '  Trabajo  ' });
    assert.deepEqual(manager.list().map(({ id, name, state }) => ({ id, name, state })), [
        { id: 's1', name: 'Sección 1', state: 'ready' },
        { id: 's2', name: 'Trabajo', state: 'ready' }
    ]);
    assert.equal(manager.getDefault(), first);
    await assert.rejects(manager.create(), { status: 409 });
    await manager.close('s1');
    assert.equal(manager.getDefault(), second);
    assert.deepEqual(closed, ['context-1']);
    await assert.rejects(manager.close('s2'), { status: 409 });
    await manager.closeAll();
});

test('closing a replacement page marks its section unavailable', async () => {
    const pages = [];
    const manager = createSessionManager({
        openPage: async () => {
            const page = new EventEmitter();
            page.url = () => 'about:blank';
            pages.push(page);
            return { context: { close: async () => {} }, page };
        },
        closeContext: async () => {},
        createController: () => ({ close: async () => {}, setUnavailable: async () => {}, setPage: async () => {} })
    });
    const section = await manager.create();
    const originalPage = pages[0];
    await manager.restart(section.id);
    originalPage.emit('close');
    assert.equal(manager.list()[0].state, 'ready', 'a stale close event must not affect the replacement page');
    pages[1].emit('close');
    assert.equal(manager.list()[0].state, 'unavailable');
    await manager.closeAll();
});

test('rejected controller teardown still closes context and removes closed section', async () => {
    let contextClosed = false;
    const teardownError = new Error('controller teardown failed');
    const manager = createSessionManager({
        openPage: async () => ({ context: {}, page: {} }),
        closeContext: async () => { contextClosed = true; },
        createController: section => ({ close: async () => { if (section.id === 's1') throw teardownError; } })
    });
    const section = await manager.create();
    await manager.create();
    await assert.rejects(manager.close(section.id), error => error === teardownError);
    assert.equal(contextClosed, true);
    assert.equal(manager.get(section.id), null);
    await manager.closeAll();
});

test('closeAll attempts every context when a controller teardown rejects', async () => {
    const closedContexts = [];
    const teardownError = new Error('controller teardown failed');
    const manager = createSessionManager({
        openPage: async section => ({ context: section.id, page: {} }),
        closeContext: async context => { closedContexts.push(context); },
        createController: section => ({ close: async () => { if (section.id === 's1') throw teardownError; } })
    });
    await manager.create();
    await manager.create();

    await assert.rejects(manager.closeAll(), error => error === teardownError);
    assert.deepEqual(closedContexts, ['s1', 's2']);
    assert.deepEqual(manager.list(), []);
});

test('session manager validates names and preserves identity across restart', async () => {
    let serial = 0;
    const manager = createSessionManager({
        maxSessions: 5,
        openPage: async () => ({ context: `context-${++serial}`, page: `page-${serial}` }),
        closeContext: async () => {},
        createController: () => ({ close: async () => {} })
    });
    await assert.rejects(manager.create({ name: '   ' }), { status: 400 });
    await assert.rejects(manager.create({ name: 'x'.repeat(25) }), { status: 400 });
    const original = await manager.create({ name: 'Cuenta' });
    const originalPage = original.page;
    const restarted = await manager.restart(original.id);
    assert.equal(restarted.id, original.id);
    assert.equal(restarted.name, original.name);
    assert.notEqual(restarted.page, originalPage);
    await manager.closeAll();
});
