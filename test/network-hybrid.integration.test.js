'use strict';
// The hybrid mode end to end: two sections with distinct free exits, a section
// that recovers its state on another exit, a section that waits when nothing is
// available, and the paid fallback. The pool is a local fake; Camoufox is the
// fixture, so nothing here touches the internet.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

async function startPool(initial) {
    const state = { queue: [...initial], reports: [], pops: 0, gate: null, unauthorized: 0 };
    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        const expected = `Basic ${Buffer.from('any:pw').toString('base64')}`;
        if (request.headers.authorization !== expected) { state.unauthorized++; response.writeHead(401).end(); return; }
        if (url.pathname === '/pop') {
            state.pops++;
            if (state.gate) await state.gate;
            const next = state.queue.shift();
            if (!next) { response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 0, src: 'no proxy' })); return; }
            response.writeHead(200, { 'content-type': 'application/json' })
                .end(JSON.stringify({ proxy: next, url: `http://${next}`, type: 'http', https: true }));
            return;
        }
        state.reports.push(`${url.searchParams.get('proxy')}:${url.searchParams.get('ok')}`);
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"code":0}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    state.url = `http://127.0.0.1:${server.address().port}`;
    state.close = () => new Promise(resolve => server.close(resolve));
    return state;
}

const postJson = (base, route, body = {}) => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
});
const waitFor = async (predicate, message, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(message);
};

test('hybrid sections get distinct exits, keep their state when the exit changes and wait instead of leaving directly', { timeout: 60000 }, async t => {
    const fixture = require('./fixtures/fake-camoufox');
    const pool = await startPool(['8.8.4.4:3128', '1.1.1.1:3128']);
    const env = {
        PYROCK_CAMOUFOX_MODULE: path.join(__dirname, 'fixtures', 'fake-camoufox.js'),
        PYROCK_PROXY_MODE: 'hybrid', PYROCK_PROXY_POOL_URL: pool.url, PYROCK_PROXY_POOL_PASSWORD: 'pw',
        PYROCK_PROXY: '', PYROCK_PROXY_STICKY_BASE: '', PYROCK_GEOIP: '',
        PYROCK_NETWORK_RETRY_MS: '60', PYROCK_FREE_SEARCH_TIMEOUT_MS: '10000'
    };
    const saved = {};
    for (const [key, value] of Object.entries(env)) { saved[key] = process.env[key]; process.env[key] = value; }
    const dead = new Set();
    const originalConfig = globalThis.__pyrockCamoufoxConfig;
    globalThis.__pyrockCamoufoxConfig = {
        // A context "has" the address of its proxy host; a dead proxy throws; no proxy at all is direct traffic.
        ipFor: options => {
            const server = options?.proxy?.server;
            if (!server) throw new Error('direct traffic must never happen');
            if (dead.has(server)) throw new Error('net::ERR_PROXY_CONNECTION_FAILED');
            const host = new URL(server).hostname;
            return host === 'gw.example' ? '5.5.5.5' : host;
        }
    };
    fixture.reset();
    const { server, startServer, stopServer, networkControl } = require('../src/server');
    t.after(async () => {
        await stopServer();
        await pool.close();
        globalThis.__pyrockCamoufoxConfig = originalConfig;
        for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    });

    await startServer({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${server.address().port}`;
    const state = fixture.currentState();
    const active = () => state.contexts.filter(context => !context.closed && context.options?.proxy);
    const overviewResponse = await fetch(`${base}/api/network`);
    assert.equal(overviewResponse.status, 200);
    const overview = await overviewResponse.json();
    assert.equal(overview.mode, 'hybrid');
    assert.equal(overview.pool.status, 'ok', 'the last pool request succeeded');
    assert.deepEqual(overview.sections.map(item => [item.id, item.provider, item.state, item.ip]), [['s1', 'free', 'connected', '8.8.4.4']]);
    const healthResponse = await fetch(`${base}/health`);
    assert.equal(healthResponse.status, 200);
    assert.equal((await healthResponse.json()).network.pool.status, 'ok');
    const proxyOf = context => context.options.proxy.server;

    // 1. The first section takes a free exit, and the browser itself has no global proxy.
    assert.deepEqual([networkControl.view('s1').provider, networkControl.view('s1').ip], ['free', '8.8.4.4']);
    assert.equal(state.launches[0].proxy, undefined, 'no browser-wide proxy in the hybrid mode');
    assert.equal(pool.unauthorized, 0, 'every request to the pool carried the password');

    // 2. A second section gets a different one.
    const created = await postJson(base, '/api/sessions', { name: 'Segunda' });
    assert.equal(created.status, 201);
    assert.deepEqual([networkControl.view('s2').provider, networkControl.view('s2').ip], ['free', '1.1.1.1']);
    assert.deepEqual(active().map(proxyOf), ['http://8.8.4.4:3128', 'http://1.1.1.1:3128']);

    // 3. The exit of s1 dies: it recovers on another exit with its state, s2 is untouched.
    dead.add('http://8.8.4.4:3128');
    pool.queue.push('9.9.9.9:3128');
    const oldContext = active().find(context => proxyOf(context) === 'http://8.8.4.4:3128');
    const secondContext = active().find(context => proxyOf(context) === 'http://1.1.1.1:3128');
    const stored = { cookies: [{ name: 'sid', value: 'keep-me' }], origins: [] };
    oldContext.storageState = async () => stored;
    let release;
    pool.gate = new Promise(resolve => { release = resolve; });
    const popsBefore = pool.pops;
    const recovery = networkControl.recover('s1');
    await waitFor(() => pool.pops > popsBefore, 'the recovery never asked the pool for another exit');
    const blocked = await postJson(base, '/api/click', { x: 1, y: 2, session: 's1' });
    assert.equal(blocked.status, 503, 'commands wait while the section changes exit');
    assert.equal((await postJson(base, '/api/click', { x: 1, y: 2, session: 's2' })).status, 200, 'the other section keeps working');
    pool.gate = null; release();
    assert.equal(await recovery, true);
    const recovered = active().find(context => proxyOf(context) === 'http://9.9.9.9:3128');
    assert.ok(recovered, 'the section opened a new context on the new exit');
    assert.deepEqual(recovered.options.storageState, stored, 'its cookies came with it');
    assert.equal(oldContext.closed, true, 'the dead context was released');
    assert.equal(secondContext.closed, false, 'the other section was not restarted');
    assert.ok(pool.reports.includes('8.8.4.4:3128:0'), 'the failure went back to the pool');
    assert.deepEqual([networkControl.view('s1').ip, networkControl.view('s1').reconnects], ['9.9.9.9', 1]);
    const restoredPage = recovered.pages.at(-1);
    const reopened = restoredPage.calls.filter(call => call[0] === 'navigate');
    assert.deepEqual(reopened, [['navigate', 'https://example.test/']], 'it went back to its page with a plain GET');
    assert.equal(restoredPage.calls.some(call => call[0] === 'click' || call[0] === 'type'), false, 'nothing was replayed');
    assert.equal((await postJson(base, '/api/click', { x: 1, y: 2, session: 's1' })).status, 200, 'commands work again');

    // 4. Closing a section frees its exit.
    const reserved = networkControl.summary().reservations;
    assert.equal((await fetch(`${base}/api/sessions/s1`, { method: 'DELETE' })).status, 200);
    assert.equal(networkControl.summary().reservations, reserved - 1);

    // 5. With an empty pool and no paid fallback a new section is refused: it never opens direct.
    const contextsBefore = state.contexts.length;
    const refused = await postJson(base, '/api/sessions', { name: 'Sin salida' });
    assert.equal(refused.status, 503);
    const refusal = await refused.json();
    assert.match(refusal.error, /Sin salida de red disponible/);
    assert.match(refusal.error, /fallback_unavailable/);
    assert.equal(state.contexts.filter(context => !context.options?.proxy).length, 0, 'no context ever opened without a proxy');
    assert.equal(state.contexts.length, contextsBefore, 'a refused section creates no context');

    // 6. With the paid fallback configured the same request succeeds, and says so.
    process.env.PYROCK_PROXY = 'http://user:pw@gw.example:823';
    process.env.PYROCK_PROXY_STICKY_BASE = '10000';
    const paid = await postJson(base, '/api/sessions', { name: 'De pago' });
    assert.equal(paid.status, 201);
    const paidView = networkControl.view('s3');
    assert.deepEqual([paidView.provider, paidView.reason, paidView.ip], ['dataimpulse', 'pool_empty', '5.5.5.5']);
    const paidContext = active().find(context => context.options.proxy.server === 'http://gw.example:10003');
    assert.ok(paidContext, 'the paid section uses the sticky port of its number');
    assert.deepEqual([paidContext.options.proxy.username, paidContext.options.proxy.password], ['user', 'pw']);
    assert.doesNotMatch(JSON.stringify(networkControl.view('s3')), /user:|pw@/, 'no credentials in the visible state');

    // 7. A section that finds nothing waits, answers 503 and recovers by itself when an exit appears.
    process.env.PYROCK_PROXY = '';
    dead.add('http://1.1.1.1:3128');
    assert.equal(await networkControl.recover('s2'), false);
    assert.equal(networkControl.view('s2').state, 'waiting');
    assert.equal((await postJson(base, '/api/click', { x: 1, y: 2, session: 's2' })).status, 503);
    pool.queue.push('4.4.4.4:3128');
    await waitFor(() => networkControl.view('s2').state === 'connected', 'the waiting section never recovered by itself');
    assert.deepEqual([networkControl.view('s2').provider, networkControl.view('s2').ip], ['free', '4.4.4.4']);
    await networkControl.idle();
    assert.equal((await postJson(base, '/api/click', { x: 1, y: 2, session: 's2' })).status, 200);
});
