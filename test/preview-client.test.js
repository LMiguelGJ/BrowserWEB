const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHarness, createScriptHarness } = require('./helpers/client-harness');

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

// ---- Side tabs and slide-over panels ----------------------------------------------------

const indexHtml = fs.readFileSync('public/index.html', 'utf8');
const stylesCss = fs.readFileSync('public/styles.css', 'utf8');
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The opening tag that carries id="<id>", from "<" to the first ">".
function tagFor(html, id) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at >= 0, `#${id} exists`);
    return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

// The declaration block of the rule whose selector is exactly `selector`.
function ruleBody(css, selector) {
    const match = new RegExp(String.raw`(?:^|\})\s*${escapeRegExp(selector)}\s*\{([^}]*)\}`).exec(css);
    assert.ok(match, `CSS rule ${selector} exists`);
    return match[1];
}

const PANELS = [
    { panel: 'logPanel', tab: 'tabLog', close: 'logPanelClose', label: 'Registro de actividad' },
    { panel: 'scriptPanel', tab: 'tabScripts', close: 'scriptPanelClose', label: 'Control de scripts' },
];

async function createPanelHarness() {
    const harness = createScriptHarness();
    await harness.load();
    const el = id => harness.context.document.getElementById(id);
    el('logBadge').hidden = true; // index.html ships the badge hidden
    return { ...harness, el, document: harness.context.document };
}

test('the bottom section is replaced by two closed side panels with labelled tabs', () => {
    assert.doesNotMatch(indexHtml, /bottom-section|class="log-section"|class="script-section"/);
    for (const { panel, tab, close, label } of PANELS) {
        const tabTag = tagFor(indexHtml, tab);
        assert.match(tabTag, /^<button/);
        for (const fragment of ['type="button"', 'class="side-tab"', 'aria-expanded="false"',
            `aria-controls="${panel}"`, `aria-label="${label}"`, `title="${label}"`,
            `onclick="togglePanel('${panel}')"`]) {
            assert.ok(tabTag.includes(fragment), `${tab} has ${fragment}`);
        }
        const panelTag = tagFor(indexHtml, panel);
        assert.match(panelTag, /^<aside/);
        assert.ok(panelTag.includes('class="side-panel"') && panelTag.includes('aria-hidden="true"'),
            `${panel} starts closed`);
        const closeTag = tagFor(indexHtml, close);
        for (const fragment of ['type="button"', 'onclick="closePanel()"', 'aria-label="Cerrar panel"']) {
            assert.ok(closeTag.includes(fragment), `${close} has ${fragment}`);
        }
    }
});

test('the log and script controls live inside their panels and keep their ids', () => {
    const at = id => indexHtml.indexOf(`id="${id}"`);
    assert.ok(at('logPanel') < at('logContainer') && at('logContainer') < at('scriptPanel'));
    for (const id of ['scriptEditor', 'scriptFileInput', 'executeBtn', 'stopBtn', 'scriptStatus', 'scriptProgress']) {
        assert.ok(at(id) > at('scriptPanel'), `#${id} is inside the script panel`);
    }
    assert.match(tagFor(indexHtml, 'stopBtn'), /\bdisabled\b/, 'stop stays disabled until a script runs');
    const logTab = indexHtml.slice(indexHtml.indexOf('id="tabLog"'), indexHtml.indexOf('</button>', indexHtml.indexOf('id="tabLog"')));
    assert.ok(logTab.includes('id="logBadge"'), 'the error badge sits on the log tab');
    assert.match(tagFor(indexHtml, 'logBadge'), /\bhidden\b/);
});

test('side panel styles: fixed tabs, off-screen closed panel, slide transition, reduced motion', () => {
    const tabs = ruleBody(stylesCss, '.side-tabs');
    assert.match(tabs, /position:\s*fixed/);
    assert.match(tabs, /right:\s*0/);
    const closed = ruleBody(stylesCss, '.side-panel');
    assert.match(closed, /position:\s*fixed/);
    assert.match(closed, /width:\s*min\(/);
    assert.match(closed, /transform:\s*translateX\(calc\(100%\s*\+\s*64px\)\)/);
    assert.match(closed, /visibility:\s*hidden/, 'a closed panel is not focusable');
    assert.match(closed, /transition:[^;]*transform[^;]*visibility/);
    const open = ruleBody(stylesCss, '.side-panel.open');
    assert.match(open, /transform:\s*translateX\(0\)/);
    assert.match(open, /visibility:\s*visible/);
    for (const rule of [closed, tabs]) assert.ok(Number(/z-index:\s*(\d+)/.exec(rule)?.[1]) > 1000, 'above the click indicator');
    assert.match(ruleBody(stylesCss, '.tab-badge[hidden]'), /display:\s*none/);
    assert.match(stylesCss, /@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.side-panel[^{]*\{[^}]*transition:\s*none/);
    assert.doesNotMatch(stylesCss, /bottom-section|\.log-section|\.script-section/);
});

test('the preview uses the height freed by the bottom section', () => {
    const body = ruleBody(stylesCss, '.preview-container');
    assert.match(body, /height:\s*calc\(100vh\s*-\s*\d+px\)/);
    assert.doesNotMatch(body, /70vh/);
});

test('a tab opens its panel, exposes the state, moves focus in, and the same tab closes it', async () => {
    const h = await createPanelHarness();
    h.context.togglePanel('logPanel');
    assert.equal(h.el('logPanel').classList.contains('open'), true);
    assert.equal(h.el('logPanel').getAttribute('aria-hidden'), 'false');
    assert.equal(h.el('tabLog').getAttribute('aria-expanded'), 'true');
    assert.equal(h.el('tabLog').classList.contains('active'), true);
    assert.equal(h.el('scriptPanel').classList.contains('open'), false);
    assert.equal(h.document.activeElement, h.el('logPanelClose'));
    h.context.togglePanel('logPanel');
    assert.equal(h.el('logPanel').classList.contains('open'), false);
    assert.equal(h.el('logPanel').getAttribute('aria-hidden'), 'true');
    assert.equal(h.el('tabLog').getAttribute('aria-expanded'), 'false');
    assert.equal(h.document.activeElement, h.el('tabLog'), 'focus returns to the tab that opened it');
});

test('only one panel is open at a time', async () => {
    const h = await createPanelHarness();
    h.context.togglePanel('logPanel');
    h.context.togglePanel('scriptPanel');
    assert.equal(h.el('logPanel').classList.contains('open'), false);
    assert.equal(h.el('logPanel').getAttribute('aria-hidden'), 'true');
    assert.equal(h.el('tabLog').getAttribute('aria-expanded'), 'false');
    assert.equal(h.el('scriptPanel').classList.contains('open'), true);
    assert.equal(h.el('tabScripts').getAttribute('aria-expanded'), 'true');
    assert.equal(h.document.activeElement, h.el('scriptPanelClose'));
});

test('Escape and the close button close the open panel; otherwise they do nothing', async () => {
    const h = await createPanelHarness();
    h.document.dispatch('keydown', { key: 'Escape' });
    assert.equal(h.document.activeElement, null, 'Escape with nothing open leaves focus alone');
    h.context.closePanel();
    assert.equal(h.document.activeElement, null, 'close with nothing open is a no-op');
    h.context.togglePanel('scriptPanel');
    h.document.dispatch('keydown', { key: 'a' });
    assert.equal(h.el('scriptPanel').classList.contains('open'), true, 'other keys keep it open');
    h.document.dispatch('keydown', { key: 'Escape' });
    assert.equal(h.el('scriptPanel').classList.contains('open'), false);
    assert.equal(h.document.activeElement, h.el('tabScripts'));
    h.context.togglePanel('logPanel');
    h.context.closePanel();
    assert.equal(h.el('logPanel').classList.contains('open'), false);
    assert.equal(h.document.activeElement, h.el('tabLog'));
    h.context.togglePanel('nope');
    assert.equal(h.el('logPanel').classList.contains('open'), false);
    assert.equal(h.el('scriptPanel').classList.contains('open'), false);
});

test('errors logged while the log is closed light the badge; opening the log clears it', async () => {
    const h = await createPanelHarness();
    const badge = h.el('logBadge');
    h.context.addLog('all good', 'info');
    h.context.addLog('fine', 'success');
    assert.equal(badge.hidden, true, 'non-errors never light the badge');
    h.context.addLog('boom', 'error');
    assert.equal(badge.hidden, false);
    h.context.togglePanel('scriptPanel');
    assert.equal(badge.hidden, false, 'the script panel does not clear it');
    h.context.togglePanel('logPanel');
    assert.equal(badge.hidden, true);
    h.context.addLog('boom while watching', 'error');
    assert.equal(badge.hidden, true, 'no badge while the log is open');
    h.context.closePanel();
    h.context.addLog('boom after closing', 'error');
    assert.equal(badge.hidden, false);
});

test('opening the log scrolls to the newest entry and closing keeps every entry and the editor text', async () => {
    const h = await createPanelHarness();
    h.el('logContainer').scrollHeight = 480;
    h.el('scriptEditor').value = 'Sleep(100)';
    const entries = h.el('logContainer').children.length;
    h.context.togglePanel('logPanel');
    assert.equal(h.el('logContainer').scrollTop, 480);
    h.context.togglePanel('scriptPanel');
    h.context.closePanel();
    assert.equal(h.el('logContainer').children.length, entries);
    assert.equal(h.el('scriptEditor').value, 'Sleep(100)');
});

test('narrow viewports reserve room on the right so the tabs never cover the controls', () => {
    const block = /@media \(max-width: 1500px\)\s*\{([^@]*?)\n\}/.exec(stylesCss);
    assert.ok(block, 'a max-width: 1500px media query exists');
    const padding = /\.container\s*\{[^}]*padding-right:\s*(\d+)px/.exec(block[1]);
    assert.ok(padding, '.container gets a right padding');
    assert.ok(Number(padding[1]) >= 68, 'wider than the 48px tabs plus a gap');
});
