const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('public/PyRockHTTP.js', 'utf8');
const scriptSource = fs.readFileSync('public/script.js', 'utf8');

function createHarness(serverUrl = 'http://localhost:3000') {
    const requests = [];
    const sockets = [];
    const timeouts = [];
    const intervals = [];
    const window = {};
    class FakeWebSocket {
        static OPEN = 1;
        constructor(url) {
            this.url = url;
            this.readyState = 0;
            this.sent = [];
            sockets.push(this);
        }
        send(value) { this.sent.push(JSON.parse(value)); }
        open() { this.readyState = 1; this.onopen?.(); }
        message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
        close() {
            if (this.readyState === 3) return;
            this.readyState = 3;
            this.onclose?.({ wasClean: true });
        }
        fail() { this.onerror?.(new Error('socket failure')); this.close(); }
    }
    const context = {
        window,
        WebSocket: FakeWebSocket,
        console: { log() {}, error() {} },
        fetch: async (url, options = {}) => {
            requests.push({ url, options });
            if (url.endsWith('/api/status')) {
                return { ok: true, json: async () => ({ success: true, browser: 'connected' }) };
            }
            if (url.endsWith('/api/screenshot')) {
                return { ok: true, json: async () => ({ success: true, screenshot: 'manual-image' }) };
            }
            return { ok: true, json: async () => ({ success: true }) };
        },
        setTimeout(fn, delay) { const timer = { fn, delay, cancelled: false }; timeouts.push(timer); return timer; },
        clearTimeout(timer) { if (timer) timer.cancelled = true; },
        setInterval(fn, delay) { const timer = { fn, delay, cancelled: false }; intervals.push(timer); return timer; },
        clearInterval(timer) { if (timer) timer.cancelled = true; },
        setImmediate,
        Date,
        URL,
    };
    vm.runInNewContext(source, context, { filename: 'public/PyRockHTTP.js' });
    const client = new window.PyRockHTTP({ serverUrl, maxRetries: 0, statusPollIntervalMs: 50 });
    return { client, requests, sockets, timeouts, intervals };
}

test('derives ws and wss preview URLs from configured HTTP URL', async () => {
    for (const [base, expected] of [
        ['http://example.test:3000/base', 'ws://example.test:3000/ws/preview'],
        ['https://example.test/base', 'wss://example.test/ws/preview'],
    ]) {
        const { client, sockets } = createHarness(base);
        assert.equal(await client.connect(), true);
        assert.equal(sockets[0].url, expected);
        client.disconnect();
    }
});

test('does not automatically fetch screenshots, including after REST actions', async () => {
    const { client, requests, timeouts } = createHarness();
    await client.connect();
    assert.equal(requests.some(request => request.url.endsWith('/api/screenshot')), false);
    await client.navigate('https://example.test');
    await client.click(4, 5);
    await client.type('hello');
    await client.pressKey('Enter');
    assert.equal(timeouts.some(timer => !timer.cancelled && timer.delay !== 50), false);
    assert.equal(requests.filter(request => request.url.endsWith('/api/screenshot')).length, 0);
    client.disconnect();
});

test('manual capture remains explicit and updates the image callback', async () => {
    const { client, requests } = createHarness();
    const images = [];
    client.onScreenshotUpdate = image => images.push(image);
    await client.connect();
    await client.takeScreenshot();
    assert.equal(requests.filter(request => request.url.endsWith('/api/screenshot')).length, 1);
    assert.deepEqual(images, ['manual-image']);
    client.disconnect();
});

test('status polling self-schedules independently of preview frames', async () => {
    const { client, requests, timeouts, intervals } = createHarness();
    await client.connect();
    assert.equal(intervals.length, 0);
    const statusTimer = timeouts.find(timer => timer.delay === 50 && !timer.cancelled);
    assert.ok(statusTimer, 'status check timer is scheduled');
    assert.equal(requests.filter(request => request.url.endsWith('/api/status')).length, 1);
    client.disconnect();
    assert.equal(statusTimer.cancelled, true);
});

test('render load and error completion each ACK a frame once', async () => {
    const { client, sockets } = createHarness();
    const rendered = [];
    client.onScreenshotUpdate = (data, done) => rendered.push({ data, done });
    await client.connect();
    const socket = sockets[0]; socket.open();
    socket.message({ type: 'frame', id: 11, data: 'data:image/jpeg;base64,AA==' });
    assert.equal(rendered.length, 1);
    assert.deepEqual(socket.sent, []);
    rendered[0].done(); rendered[0].done();
    assert.deepEqual(socket.sent, [{ type: 'ack', id: 11 }]);
    client.retryIndex = 2;
    socket.message({ type: 'frame', id: 12, data: 'bad-image' });
    rendered[1].done(new Error('decode')); rendered[1].done();
    assert.deepEqual(socket.sent, [{ type: 'ack', id: 11 }, { type: 'ack', id: 12 }]);
    assert.equal(client.retryIndex, 2, 'render failure ACKs without resetting reconnect backoff');
    client.disconnect();
});

test('render callback exceptions ACK without reporting live or resetting reconnect backoff', async () => {
    const { client, sockets } = createHarness();
    const states = [];
    client.onPreviewStatus = state => states.push(state);
    client.onScreenshotUpdate = () => { throw new Error('renderer failed'); };
    await client.connect();
    const socket = sockets[0]; socket.open();
    client.retryIndex = 3;
    socket.message({ type: 'frame', id: 20, data: 'frame' });
    assert.deepEqual(socket.sent, [{ type: 'ack', id: 20 }]);
    assert.equal(client.retryIndex, 3);
    assert.equal(states.includes('live'), false);
    client.disconnect();
});

function createScriptHarness() {
    const elements = new Map();
    const windowListeners = new Map();
    const timers = [];
    let clientOptions;
    function makeElement() {
        const eventListeners = new Map();
        return {
            style: {}, children: [], textContent: '', value: '', naturalWidth: 0, naturalHeight: 0,
            complete: false,
            addEventListener(type, listener, options = {}) {
                const entries = eventListeners.get(type) || [];
                entries.push({ listener, once: options.once === true });
                eventListeners.set(type, entries);
            },
            removeEventListener(type, listener) {
                eventListeners.set(type, (eventListeners.get(type) || []).filter(entry => entry.listener !== listener));
            },
            listenerCount(type) { return (eventListeners.get(type) || []).length; },
            dispatch(type) {
                const entries = [...(eventListeners.get(type) || [])];
                for (const entry of entries) {
                    entry.listener({ type, target: this });
                    if (entry.once) this.removeEventListener(type, entry.listener);
                }
            },
            appendChild(child) { this.children.push(child); child.parentNode = this; },
            removeChild(child) { this.children = this.children.filter(item => item !== child); },
            scrollHeight: 0,
            click() {},
        };
    }
    const document = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, makeElement());
            return elements.get(id);
        },
        createElement: makeElement,
        querySelector: () => makeElement(),
    };
    const window = {
        PyRockConfig: { serverUrl: 'http://localhost:3000' },
        addEventListener(type, listener) {
            const entries = windowListeners.get(type) || [];
            entries.push(listener);
            windowListeners.set(type, entries);
        },
        async dispatch(type) {
            for (const listener of windowListeners.get(type) || []) await listener();
        }
    };
    class FakeClient {
        constructor(options) { clientOptions = options; this.isConnected = false; }
        async connect() { this.isConnected = true; return true; }
        async getStatus() { return { browser: 'connected' }; }
        disconnect() { this.isConnected = false; }
    }
    class FakeScriptParser { constructor() {} }
    const context = {
        document, window, PyRockHTTP: FakeClient, PyRockScriptParser: FakeScriptParser,
        console: { log() {}, error() {} }, Date,
        setTimeout(fn, delay) { const timer = { fn, delay, cancelled: false }; timers.push(timer); return timer; },
        clearTimeout(timer) { if (timer) timer.cancelled = true; },
    };
    vm.runInNewContext(scriptSource, context, { filename: 'public/script.js' });
    return {
        elements, window, timers,
        async load() { await window.dispatch('load'); return clientOptions; },
    };
}

test('image render completion removes both listeners after every load and error', async () => {
    const harness = createScriptHarness();
    const options = await harness.load();
    const preview = harness.elements.get('preview');
    for (const eventType of ['load', 'error', 'load', 'error']) {
        let completions = 0;
        options.onScreenshotUpdate('frame-data', () => { completions++; });
        assert.equal(preview.listenerCount('load'), 1);
        assert.equal(preview.listenerCount('error'), 1);
        preview.dispatch(eventType);
        assert.equal(preview.listenerCount('load'), 0, 'no leftover load handler');
        assert.equal(preview.listenerCount('error'), 0, 'no leftover error handler');
        assert.equal(completions, 1);
    }
});

test('window load does not schedule a redundant delayed status request', async () => {
    const harness = createScriptHarness();
    await harness.load();
    assert.deepEqual(harness.timers.map(timer => timer.delay), []);
});

test('malformed preview messages are ignored safely', async () => {
    const { client, sockets } = createHarness();
    const updates = [];
    client.onScreenshotUpdate = data => updates.push(data);
    await client.connect();
    sockets[0].open();
    for (const data of ['{', JSON.stringify({ type: 'other' }), JSON.stringify({ type: 'frame', id: 'x', data: 4 })]) {
        sockets[0].onmessage({ data });
    }
    assert.deepEqual(updates, []);
    client.disconnect();
});

test('preview outage preserves REST connectivity and retries with capped backoff', async () => {
    const { client, sockets, timeouts } = createHarness();
    const states = [];
    client.onPreviewStatus = state => states.push(state);
    await client.connect();
    const socket = sockets[0]; socket.fail();
    assert.equal(client.isConnected, true);
    assert.deepEqual(states.slice(-1), ['reconnecting']);
    assert.ok(timeouts.some(t => !t.cancelled && t.delay === 1000));
    await client.navigate('https://example.test');
    client.disconnect();
    assert.ok(timeouts.every(timer => timer.cancelled || timer.delay !== 1000));
    assert.equal(sockets.length, 1);
});

test('reconnect delays progress through the 10-second cap', async () => {
    const { client, sockets, timeouts } = createHarness();
    await client.connect();
    const expected = [1000, 2000, 4000, 8000, 10000, 10000];
    for (const [index, delay] of expected.entries()) {
        const current = sockets[sockets.length - 1];
        current.fail();
        const retry = timeouts.find(timer => !timer.cancelled && timer.delay === delay);
        assert.ok(retry, `retry delay ${delay}ms is scheduled`);
        retry.cancelled = true;
        retry.fn();
        assert.equal(sockets.length, index + 2);
    }
    client.disconnect();
});

test('rendered frame resets retry delay and intentional disconnect prevents stale reconnect', async () => {
    const { client, sockets, timeouts } = createHarness();
    client.onScreenshotUpdate = (_data, done) => done();
    await client.connect();
    sockets[0].fail();
    const retry = timeouts.find(t => t.delay === 1000);
    retry.fn();
    assert.equal(sockets.length, 2);
    sockets[1].open();
    sockets[1].message({ type: 'frame', id: 1, data: 'frame' });
    sockets[1].fail();
    assert.ok(timeouts.some(t => t.delay === 1000 && !t.cancelled));
    const pending = timeouts.filter(t => !t.cancelled);
    client.disconnect();
    for (const timer of pending) timer.fn();
    assert.equal(sockets.length, 2);
});

test('repeated connect reuses the active preview socket and status timer', async () => {
    const { client, sockets, timeouts, requests } = createHarness();
    const [firstConnect, repeatedConnect] = await Promise.all([client.connect(), client.connect()]);
    assert.equal(firstConnect, true);
    assert.equal(repeatedConnect, true);
    const initialRequestCount = requests.length;
    const initialStatusTimers = timeouts.filter(timer => timer.delay === 50 && !timer.cancelled).length;
    assert.equal(await client.connect(), true);
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].readyState, 0);
    assert.equal(requests.length, initialRequestCount);
    assert.equal(timeouts.filter(timer => timer.delay === 50 && !timer.cancelled).length, initialStatusTimers);
    client.disconnect();
});

test('stale image completion after disconnect does not ACK', async () => {
    const { client, sockets } = createHarness();
    let complete;
    client.onScreenshotUpdate = (_data, done) => { complete = done; };
    await client.connect();
    sockets[0].open();
    sockets[0].message({ type: 'frame', id: 7, data: 'frame' });
    client.disconnect();
    complete();
    assert.deepEqual(sockets[0].sent, []);
});
