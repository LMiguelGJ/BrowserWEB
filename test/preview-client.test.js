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
    const clicks = [];
    const presses = [];
    let clientInstance;
    let clientOptions;
    function makeElement() {
        const eventListeners = new Map();
        return {
            style: {}, children: [], textContent: '', value: '', naturalWidth: 0, naturalHeight: 0,
            complete: false, rect: { left: 0, top: 0, width: 0, height: 0 }, clientLeft: 0, clientTop: 0,
            getBoundingClientRect() { return this.rect; },
            addEventListener(type, listener, options = {}) {
                const entries = eventListeners.get(type) || [];
                entries.push({ listener, once: options.once === true });
                eventListeners.set(type, entries);
            },
            removeEventListener(type, listener) {
                eventListeners.set(type, (eventListeners.get(type) || []).filter(entry => entry.listener !== listener));
            },
            listenerCount(type) { return (eventListeners.get(type) || []).length; },
            dispatch(type, extra = {}) {
                const entries = [...(eventListeners.get(type) || [])];
                for (const entry of entries) {
                    entry.listener({ type, target: this, ...extra });
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
        querySelector: selector => (selector === '.preview-container'
            ? document.getElementById('.preview-container') : makeElement()),
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
        constructor(options) { clientOptions = options; clientInstance = this; this.isConnected = false; }
        async click(x, y) { clicks.push({ x, y }); return { success: true }; }
        async pressKey(key) { presses.push(key); return { success: true }; }
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
        elements, window, timers, clicks, presses, context,
        get client() { return clientInstance; },
        async load() { await window.dispatch('load'); return clientOptions; },
    };
}

// Geometry fixture: a 1000x500 remote screen drawn with object-fit: contain into a
// 500x400 element at (10, 20), i.e. scale 0.5 with 75px letterbox bands above and below.
async function createClickHarness({ rect = { left: 10, top: 20, width: 500, height: 400 },
    natural = { width: 1000, height: 500 }, connected = true } = {}) {
    const harness = createScriptHarness();
    await harness.load();
    harness.client.isConnected = connected;
    const preview = harness.elements.get('preview');
    preview.naturalWidth = natural.width;
    preview.naturalHeight = natural.height;
    preview.rect = rect;
    const container = harness.context.document.querySelector('.preview-container');
    container.rect = { left: 5, top: 10, width: 600, height: 500 };
    container.clientLeft = 2;
    container.clientTop = 2;
    const field = id => harness.context.document.getElementById(id);
    return {
        ...harness, preview, container, field,
        click(clientX, clientY) { preview.dispatch('click', { clientX, clientY }); },
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

test('preview click converts contained-image points to remote coordinates', async () => {
    // Content box: x 10..510, y 95..345; scale 0.5.
    const cases = [
        { at: [260, 220], expected: { x: 500, y: 250 }, label: 'center' },
        { at: [10, 95], expected: { x: 0, y: 0 }, label: 'top-left pixel' },
        { at: [509.9, 344.9], expected: { x: 999, y: 499 }, label: 'bottom-right pixel stays in range' },
        { at: [13.9, 98.9], expected: { x: 7, y: 7 }, label: 'floor, not round' },
    ];
    for (const { at, expected, label } of cases) {
        const harness = await createClickHarness();
        harness.click(...at);
        assert.deepEqual(harness.clicks, [expected], label);
        assert.equal(harness.field('clickX').value, String(expected.x), `${label}: X field`);
        assert.equal(harness.field('clickY').value, String(expected.y), `${label}: Y field`);
    }
    // Vertical fit: 500x1000 screen in the same box leaves 75px side bands, scale 0.5.
    const tall = await createClickHarness({ natural: { width: 500, height: 1000 }, rect: { left: 10, top: 20, width: 400, height: 500 } });
    tall.click(10 + 75 + 50, 20 + 100);
    assert.deepEqual(tall.clicks, [{ x: 100, y: 200 }]);
    // Upscaled preview (scale 5) and a page that is scrolled away from the origin.
    const small = await createClickHarness({ natural: { width: 100, height: 50 }, rect: { left: 300, top: -40, width: 500, height: 400 } });
    small.click(300 + 5 * 7 + 1, -40 + 75 + 5 * 3 + 1);
    assert.deepEqual(small.clicks, [{ x: 7, y: 3 }]);
});

test('preview click recomputes geometry from the current rendered rectangle', async () => {
    const harness = await createClickHarness();
    harness.click(260, 220);
    // Hover zoom (scale 1.02 around the center) and a resize change the rectangle between clicks.
    harness.preview.rect = { left: 7.5, top: 12, width: 510, height: 408 };
    harness.click(7.5 + 255, 12 + 204);
    harness.preview.rect = { left: 0, top: 0, width: 1000, height: 500 };
    harness.click(500, 250);
    assert.deepEqual(harness.clicks, [{ x: 500, y: 250 }, { x: 500, y: 250 }, { x: 500, y: 250 }]);
});

test('preview click ignores letterbox margins, outer edges and an unready image', async () => {
    const margins = [[260, 94], [260, 345], [9, 220], [510, 220], [260, 20], [Number.NaN, 220]];
    for (const point of margins) {
        const harness = await createClickHarness();
        harness.field('clickX').value = '11';
        harness.field('clickY').value = '12';
        harness.click(...point);
        assert.deepEqual(harness.clicks, [], `no send for ${point}`);
        assert.equal(harness.field('clickX').value, '11');
        assert.equal(harness.field('clickY').value, '12');
        assert.equal(harness.container.children.length, 0, 'no indicator');
    }
    const unready = await createClickHarness({ natural: { width: 0, height: 0 } });
    unready.click(260, 220);
    const hidden = await createClickHarness({ rect: { left: 0, top: 0, width: 0, height: 0 } });
    hidden.click(0, 0);
    for (const harness of [unready, hidden]) {
        assert.deepEqual(harness.clicks, []);
        assert.equal(harness.container.children.length, 0);
    }
});

test('one preview click sends one REST click and draws one correctly placed indicator', async () => {
    const harness = await createClickHarness();
    harness.click(260, 220);
    assert.equal(harness.clicks.length, 1);
    assert.equal(harness.container.children.length, 1);
    // Viewport point (260, 220) minus the container origin (5, 10) and its 2px border.
    assert.deepEqual(
        { left: harness.container.children[0].style.left, top: harness.container.children[0].style.top },
        { left: '253px', top: '208px' });
});

test('direct click updates the fields even when REST is disconnected, without sending', async () => {
    const harness = await createClickHarness({ connected: false });
    harness.click(260, 220);
    assert.equal(harness.field('clickX').value, '500');
    assert.equal(harness.field('clickY').value, '250');
    assert.deepEqual(harness.clicks, []);
});

test('zero coordinates are preserved by direct clicks and the manual button', async () => {
    const direct = await createClickHarness();
    direct.click(10, 95);
    assert.deepEqual(direct.clicks, [{ x: 0, y: 0 }]);

    const manual = await createClickHarness();
    manual.field('clickX').value = '0';
    manual.field('clickY').value = '0';
    await manual.context.sendClick();
    assert.deepEqual(manual.clicks, [{ x: 0, y: 0 }]);

    const mixed = await createClickHarness();
    mixed.field('clickX').value = '0';
    mixed.field('clickY').value = '40';
    await mixed.context.sendClick();
    assert.deepEqual(mixed.clicks, [{ x: 0, y: 40 }]);
});

test('manual coordinate button keeps old defaults for empty values and needs a connection', async () => {
    for (const invalid of ['', 'abc']) {
        const harness = await createClickHarness();
        harness.field('clickX').value = invalid;
        harness.field('clickY').value = invalid;
        await harness.context.sendClick();
        assert.deepEqual(harness.clicks, [{ x: 600, y: 620 }], `defaults for '${invalid}'`);
    }
    const offline = await createClickHarness({ connected: false });
    offline.field('clickX').value = '5';
    offline.field('clickY').value = '6';
    await offline.context.sendClick();
    assert.deepEqual(offline.clicks, []);
});

test('indicator helper projects a remote point into container coordinates and tolerates missing geometry', async () => {
    const harness = await createClickHarness();
    const position = harness.context.getIndicatorPosition(harness.preview, 500, 250);
    assert.deepEqual({ x: position.x, y: position.y }, { x: 253, y: 208 });
    harness.preview.rect = { left: 0, top: 0, width: 0, height: 0 };
    const missing = harness.context.getIndicatorPosition(harness.preview, 500, 250);
    assert.equal(Number.isFinite(missing.x) || Number.isFinite(missing.y), false);
    harness.context.showClickIndicator(missing.x, missing.y);
    assert.equal(harness.container.children.length, 0, 'non-finite positions draw nothing');
});

test('preview tooltip explains the direct click', () => {
    const html = fs.readFileSync('public/index.html', 'utf8');
    assert.match(html, /<img id="preview"[^>]*title="Haz clic sobre la imagen para enviar el clic y actualizar X\/Y\."/);
});

const ARROWS = [
    { key: 'ArrowUp', label: 'Flecha arriba', glyph: '↑' },
    { key: 'ArrowLeft', label: 'Flecha izquierda', glyph: '←' },
    { key: 'ArrowDown', label: 'Flecha abajo', glyph: '↓' },
    { key: 'ArrowRight', label: 'Flecha derecha', glyph: '→' },
];

test('keyboard group offers four labelled arrow buttons that send the matching key', () => {
    const html = fs.readFileSync('public/index.html', 'utf8');
    const group = html.slice(html.indexOf('Control de Teclado'), html.indexOf('Sistema</h3>'));
    for (const { key, label, glyph } of ARROWS) {
        const button = new RegExp(String.raw`<button[^>]*onclick="sendKey\('${key}'\)"[^>]*>\s*${glyph}\s*</button>`).exec(group);
        assert.ok(button, `${key} button exists in the keyboard group`);
        assert.match(button[0], new RegExp(`aria-label="${label}"`), `${key} has an accessible name`);
        assert.match(button[0], new RegExp(`title="${label}"`), `${key} has a tooltip`);
    }
    assert.equal((group.match(/class="[^"]*arrow-/g) || []).length >= 4, true, 'arrow buttons are positioned by dedicated classes');
    for (const key of ['Enter', 'Tab', 'Escape']) assert.ok(group.includes(`sendKey('${key}')`), `${key} is kept`);
});

test('removed controls are gone from the interface', () => {
    const html = fs.readFileSync('public/index.html', 'utf8');
    assert.doesNotMatch(html, /apponfly/i);
    assert.doesNotMatch(html, /getStatus\(\)|Estado del Sistema/);
    assert.match(html, /initBrowser\(\)/, 'restart button is kept');
});

test('each arrow sends exactly its key through REST and needs a connection', async () => {
    const harness = createScriptHarness();
    await harness.load();
    for (const { key } of ARROWS) await harness.context.sendKey(key);
    assert.deepEqual(harness.presses, ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight']);
    const offline = createScriptHarness();
    await offline.load();
    offline.client.isConnected = false;
    await offline.context.sendKey('ArrowUp');
    assert.deepEqual(offline.presses, []);
});

test('arrow pad is laid out as a cross', () => {
    const css = fs.readFileSync('public/styles.css', 'utf8');
    assert.match(css, /\.arrow-pad\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(3,\s*1fr\)/);
    assert.match(css, /\.arrow-up\s*\{[^}]*grid-column:\s*2[^}]*grid-row:\s*1/);
    for (const [name, column] of [['left', 1], ['down', 2], ['right', 3]]) {
        assert.match(css, new RegExp(String.raw`\.arrow-${name}\s*\{[^}]*grid-column:\s*${column}[^}]*grid-row:\s*2`));
    }
});
