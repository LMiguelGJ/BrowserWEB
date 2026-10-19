'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createScreencastController } = require('../screencast');
const tick = () => new Promise(resolve => setImmediate(resolve));

class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.sent = []; }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; this.emit('close'); }
}

class CDP extends EventEmitter {
    constructor(fail = false) { super(); this.fail = fail; this.calls = []; this.detached = false; }
    async send(method, params) {
        this.calls.push({ method, params });
        if (this.fail && method === 'Page.startScreencast') throw new Error('injected start failure');
    }
    async detach() { this.detached = true; }
}

test('failed CDP start is visible, detaches, and later public setPage restores frames', async t => {
    const failed = new CDP(true);
    const good = new CDP();
    const first = { createCDPSession: async () => failed, isClosed: () => false };
    const controller = createScreencastController({ getPage: () => first });
    t.after(() => controller.close());
    const viewer = new Socket();
    controller.addViewer(viewer);
    await tick();
    assert.ok(viewer.sent.some(message => message.type === 'error' && /injected start failure/.test(message.message)));
    assert.equal(failed.detached, true);
    await controller.setUnavailable('Browser disconnected');
    await controller.setPage({ createCDPSession: async () => good, isClosed: () => false });
    good.emit('Page.screencastFrame', { sessionId: 1, data: 'recovered' });
    await tick();
    assert.ok(viewer.sent.some(message => message.type === 'frame' && message.data.endsWith('recovered')));
});

test('buffered viewer recovers newest static frame when transport drains', async t => {
    const callbacks = new Map();
    let timer = 0;
    const cdp = new CDP();
    const page = { createCDPSession: async () => cdp, isClosed: () => false };
    const controller = createScreencastController({
        getPage: () => page,
        timers: {
            setTimeout(fn) { callbacks.set(++timer, fn); return timer; },
            clearTimeout(id) { callbacks.delete(id); }
        }
    });
    t.after(() => controller.close());
    const viewer = new Socket();
    controller.addViewer(viewer);
    await tick();
    viewer.bufferedAmount = 1_048_577;
    cdp.emit('Page.screencastFrame', { sessionId: 1, data: 'latest-static' });
    await tick();
    assert.equal(viewer.sent.filter(message => message.type === 'frame').length, 0);
    viewer.bufferedAmount = 0;
    for (const callback of [...callbacks.values()]) callback();
    await tick();
    await tick();
    assert.equal(viewer.sent.filter(message => message.type === 'frame').length, 1,
        'drained socket must receive retained frame without another CDP event');
});

test('buffered retry timer is cleared when viewer closes, errors, page resets, or controller shuts down', async () => {
    for (const lifecycle of ['close', 'error', 'reset', 'shutdown']) {
        const callbacks = new Map();
        let nextTimer = 0;
        const cdp = new CDP();
        const page = { createCDPSession: async () => cdp, isClosed: () => false };
        const controller = createScreencastController({
            getPage: () => page,
            timers: {
                setTimeout(fn) { callbacks.set(++nextTimer, fn); return nextTimer; },
                clearTimeout(id) { callbacks.delete(id); }
            }
        });
        const viewer = new Socket();
        controller.addViewer(viewer);
        await tick();
        viewer.bufferedAmount = 1_048_577;
        cdp.emit('Page.screencastFrame', { sessionId: 1, data: lifecycle });
        assert.equal(callbacks.size, 1, `${lifecycle}: expected one bounded retry timer`);
        if (lifecycle === 'close') viewer.close();
        else if (lifecycle === 'error') viewer.emit('error', new Error('socket error'));
        else if (lifecycle === 'reset') await controller.setUnavailable('reset');
        else await controller.close();
        await tick();
        assert.equal(callbacks.size, 0, `${lifecycle}: buffered retry timer leaked`);
        await controller.close();
    }
});

test('shutdown overlapping public HTTP init must close the replacement browser', async t => {
    const path = require('node:path');
    const fixture = require('./fixtures/fake-camoufox');
    const originalConfig = globalThis.__pyrockCamoufoxConfig;
    const originalModule = process.env.PYROCK_CAMOUFOX_MODULE;
    let releaseLaunch;
    let enteredLaunch;
    const entered = new Promise(resolve => { enteredLaunch = resolve; });
    const gate = new Promise(resolve => { releaseLaunch = resolve; });

    // The second launch (the replacement browser of /api/init) blocks, so the
    // shutdown can race with it.
    globalThis.__pyrockCamoufoxConfig = {
        beforeLaunch: async index => {
            if (index === 1) { enteredLaunch(); await gate; }
        }
    };
    process.env.PYROCK_CAMOUFOX_MODULE = path.join(__dirname, 'fixtures', 'fake-camoufox.js');
    const state = fixture.reset();
    const { browsers } = state;
    const { server, startServer, stopServer } = require('../server');
    t.after(async () => {
        releaseLaunch();
        await stopServer();
        for (const browser of browsers) if (!browser.closeCount) await browser.close();
        globalThis.__pyrockCamoufoxConfig = originalConfig;
        if (originalModule === undefined) delete process.env.PYROCK_CAMOUFOX_MODULE;
        else process.env.PYROCK_CAMOUFOX_MODULE = originalModule;
    });

    await startServer({ host: '127.0.0.1', port: 0 });
    const resetting = fetch(`http://127.0.0.1:${server.address().port}/api/init`, { method: 'POST' });
    await entered;
    const stopping = stopServer();
    await tick();
    await tick();
    const rejectedInit = await (await fetch(`http://127.0.0.1:${server.address().port}/api/init`, { method: 'POST' })).json();
    assert.equal(rejectedInit.success, false, 'new init is rejected after shutdown begins');
    assert.equal(browsers.length, 1, 'shutdown must prevent another browser launch');
    await assert.rejects(startServer({ host: '127.0.0.1', port: 0 }), /shutting down/);
    releaseLaunch();
    const result = await (await resetting).json();
    await stopping;
    assert.equal(typeof result.success, 'boolean');
    assert.equal(browsers.at(-1).closeCount, 1, 'replacement browser must be closed before stopServer resolves');
    assert.equal(server.listening, false);
});
