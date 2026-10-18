'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createScreencastController } = require('../screencast');

class FakeCDP extends EventEmitter {
    constructor() { super(); this.calls = []; }
    async send(method, params) {
        this.calls.push({ method, params });
        if (method === 'Page.startScreencast') this.started = true;
        return {};
    }
    async detach() { this.detached = true; }
}

class FakePage extends EventEmitter {
    constructor() { super(); this.cdp = new FakeCDP(); this.sessions = 0; }
    async createCDPSession() { this.sessions += 1; return this.cdp; }
    isClosed() { return false; }
}

class FakeSocket extends EventEmitter {
    constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.sent = []; }
    send(message) { this.sent.push(JSON.parse(message)); }
    close(code, reason) { this.closed = { code, reason }; this.readyState = 3; this.emit('close'); }
    messages(type) { return this.sent.filter(message => message.type === type); }
}

const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(options = {}) {
    const page = new FakePage();
    const controller = createScreencastController({
        getPage: () => page,
        ackTimeoutMs: options.ackTimeoutMs ?? 10_000,
        timers: options.timers
    });
    return { page, controller };
}

function frame(page, id, data = `jpeg-${id}`) {
    page.cdp.emit('Page.screencastFrame', { sessionId: id, data, metadata: {} });
}

test('first viewer starts one shared producer; last viewer stops and detaches idempotently', async () => {
    const { page, controller } = setup();
    const a = new FakeSocket();
    const b = new FakeSocket();
    controller.addViewer(a);
    await tick();
    controller.addViewer(b);
    await tick();
    assert.equal(page.sessions, 1);
    assert.equal(page.cdp.calls.filter(call => call.method === 'Page.startScreencast').length, 1);
    assert.deepEqual(page.cdp.calls.find(call => call.method === 'Page.startScreencast').params, {
        format: 'jpeg', quality: 60, maxWidth: 1366, maxHeight: 768, everyNthFrame: 1
    });
    a.close();
    assert.equal(page.cdp.calls.filter(call => call.method === 'Page.stopScreencast').length, 0);
    b.close();
    await controller.close();
    await controller.close();
    assert.equal(page.cdp.calls.filter(call => call.method === 'Page.stopScreencast').length, 1);
    assert.equal(page.cdp.detached, true);
});

test('every CDP frame is acknowledged and viewers receive only latest pending frame after render ACK', async () => {
    const { page, controller } = setup();
    const slow = new FakeSocket();
    const fast = new FakeSocket();
    controller.addViewer(slow);
    controller.addViewer(fast);
    await tick();
    frame(page, 1, 'one');
    await tick();
    assert.deepEqual(slow.messages('frame').map(item => item.data), ['data:image/jpeg;base64,one']);
    frame(page, 2, 'two');
    frame(page, 3, 'three');
    await tick();
    assert.deepEqual(page.cdp.calls.filter(call => call.method === 'Page.screencastFrameAck').map(call => call.params.sessionId), [1, 2, 3]);
    assert.deepEqual(slow.messages('frame').map(item => item.data), ['data:image/jpeg;base64,one']);
    slow.emit('message', JSON.stringify({ type: 'ack', id: slow.messages('frame')[0].id }));
    fast.emit('message', JSON.stringify({ type: 'ack', id: fast.messages('frame')[0].id }));
    await tick();
    assert.deepEqual(slow.messages('frame').map(item => item.data), ['data:image/jpeg;base64,one', 'data:image/jpeg;base64,three']);
    await controller.close();
});

test('render ACK does not resend the same frame on a static page; new CDP frame advances viewer', async () => {
    const { page, controller } = setup();
    const viewer = new FakeSocket();
    controller.addViewer(viewer);
    await tick();
    frame(page, 1, 'still');
    await tick();
    const delivered = viewer.messages('frame')[0];
    viewer.emit('message', JSON.stringify({ type: 'ack', id: delivered.id }));
    await tick();
    assert.equal(viewer.messages('frame').length, 1, 'ACK must not re-send an already-rendered frame');
    frame(page, 2, 'changed');
    await tick();
    assert.deepEqual(viewer.messages('frame').map(item => item.data), [
        'data:image/jpeg;base64,still', 'data:image/jpeg;base64,changed'
    ]);
    await controller.close();
});

test('adding a viewer to a live producer immediately offers the latest static frame', async () => {
    const { page, controller } = setup();
    const first = new FakeSocket();
    controller.addViewer(first);
    await tick();
    frame(page, 1, 'still');
    await tick();
    const second = new FakeSocket();
    controller.addViewer(second);
    await tick();
    assert.deepEqual(second.messages('frame').map(item => item.data), ['data:image/jpeg;base64,still']);
    await controller.close();
});

test('stale generation ACKs on its owning CDP session but never publishes', async () => {
    const first = new FakePage();
    const second = new FakePage();
    let page = first;
    const controller = createScreencastController({ getPage: () => page });
    const viewer = new FakeSocket();
    controller.addViewer(viewer);
    await tick();
    const staleListener = first.cdp.listeners('Page.screencastFrame')[0];
    await controller.setUnavailable('reset');
    page = second;
    await controller.setPage(second);
    const countBefore = viewer.messages('frame').length;
    staleListener({ sessionId: 'old-session-frame', data: 'stale' });
    await tick();
    assert.ok(first.cdp.calls.some(call => call.method === 'Page.screencastFrameAck' && call.params.sessionId === 'old-session-frame'));
    assert.equal(second.cdp.calls.some(call => call.method === 'Page.screencastFrameAck'), false);
    assert.equal(viewer.messages('frame').length, countBefore);
    await controller.close();
});

test('stop failure still removes listener and detaches while preserving unrelated error', async () => {
    const { page, controller } = setup();
    const viewer = new FakeSocket();
    controller.addViewer(viewer);
    await tick();
    const listener = page.cdp.listeners('Page.screencastFrame')[0];
    page.cdp.send = async (method, params) => {
        page.cdp.calls.push({ method, params });
        if (method === 'Page.stopScreencast') throw new Error('unexpected stop failure');
    };
    await assert.rejects(controller.setUnavailable('test teardown'), /unexpected stop failure/);
    assert.equal(page.cdp.listenerCount('Page.screencastFrame'), 0);
    assert.equal(page.cdp.detached, true);
    assert.equal(page.cdp.listeners('Page.screencastFrame').includes(listener), false);
});

test('unresponsive viewer is closed at the ACK deadline and healthy viewer continues', async () => {
    const callbacks = new Map();
    let nextTimer = 0;
    const timers = {
        setTimeout(fn) { const id = ++nextTimer; callbacks.set(id, fn); return { id, unref() {} }; },
        clearTimeout(timer) { callbacks.delete(timer.id); }
    };
    const { page, controller } = setup({ timers });
    const slow = new FakeSocket();
    const healthy = new FakeSocket();
    controller.addViewer(slow);
    controller.addViewer(healthy);
    await tick();
    frame(page, 1);
    await tick();
    callbacks.get(1)();
    assert.equal(slow.readyState, 3);
    healthy.emit('message', JSON.stringify({ type: 'ack', id: healthy.messages('frame')[0].id }));
    frame(page, 2);
    await tick();
    assert.equal(healthy.messages('frame').length, 2);
    await controller.close();
});

test('page replacement serializes producer teardown and resumes remaining viewers', async () => {
    const first = new FakePage();
    const second = new FakePage();
    let page = first;
    const controller = createScreencastController({ getPage: () => page });
    const viewer = new FakeSocket();
    controller.addViewer(viewer);
    await tick();
    await controller.setUnavailable('Browser restarting');
    page = second;
    await controller.setPage(second);
    await tick();
    assert.equal(first.cdp.detached, true);
    assert.equal(second.cdp.calls.filter(call => call.method === 'Page.startScreencast').length, 1);
    assert.ok(viewer.messages('status').some(item => item.state === 'unavailable'));
    await controller.close();
});

test('malformed viewer messages do not issue CDP commands and unknown ACKs are ignored', async () => {
    const { page, controller } = setup();
    const viewer = new FakeSocket();
    controller.addViewer(viewer);
    await tick();
    viewer.emit('message', '{');
    viewer.emit('message', JSON.stringify({ type: 'ack', id: 999 }));
    await tick();
    assert.deepEqual(page.cdp.calls.map(call => call.method), ['Page.startScreencast']);
    await controller.close();
});

test('server exports lifecycle API and rejects missing, malformed, cross-host, and wrong-path upgrades', async () => {
    const { startServer, stopServer, app, server, previewUpgradeAllowed } = require('../server');
    assert.equal(typeof startServer, 'function');
    assert.equal(typeof stopServer, 'function');
    assert.ok(app);
    assert.ok(server);
    const host = '127.0.0.1:3000';
    assert.equal(previewUpgradeAllowed({ url: '/ws/preview', headers: { host, origin: `http://${host}` } }), true);
    assert.equal(previewUpgradeAllowed({ url: '/ws/preview', headers: { host } }), false);
    assert.equal(previewUpgradeAllowed({ url: '/ws/preview', headers: { host, origin: 'invalid' } }), false);
    assert.equal(previewUpgradeAllowed({ url: '/ws/preview', headers: { host, origin: `http://${host}/not-an-origin` } }), false);
    assert.equal(previewUpgradeAllowed({ url: '/ws/preview', headers: { host, origin: 'http://evil.example' } }), false);
    assert.equal(previewUpgradeAllowed({ url: '/elsewhere', headers: { host, origin: `http://${host}` } }), false);
    await stopServer();
    await stopServer();
});
