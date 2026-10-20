'use strict';
// Hybrid network wiring: configuration, the per-section state kept by the
// manager, the session manager hooks and the engine rules (never direct).
const test = require('node:test');
const assert = require('node:assert/strict');
const { readNetworkConfig, isHybridMode } = require('../src/network/config');
const { createNetworkManager } = require('../src/network/manager');
const { createSessionManager } = require('../src/sessions');
const { createCamoufoxEngine } = require('../src/engines/camoufox');

async function withEnv(values, task) {
    const saved = {};
    for (const [key, value] of Object.entries(values)) {
        saved[key] = process.env[key];
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    try { return await task(); }
    finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
}

test('the hybrid mode is opt in and its settings are validated', () => {
    assert.deepEqual(readNetworkConfig({}), { enabled: false });
    assert.equal(isHybridMode({ PYROCK_PROXY_MODE: ' Hybrid ' }), true);
    assert.equal(isHybridMode({ PYROCK_PROXY_MODE: 'off' }), false);
    assert.deepEqual(readNetworkConfig({ PYROCK_PROXY_MODE: 'hybrid' }), {
        enabled: true, freeDeadlineMs: 120000, poolUrl: 'http://127.0.0.1:8899', poolPassword: ''
    });
    const custom = readNetworkConfig({
        PYROCK_PROXY_MODE: 'hybrid', PYROCK_FREE_SEARCH_TIMEOUT_MS: '15000',
        PYROCK_PROXY_POOL_URL: 'http://localhost:9000/', PYROCK_PROXY_POOL_PASSWORD: 'secret'
    });
    assert.deepEqual([custom.freeDeadlineMs, custom.poolUrl, custom.poolPassword], [15000, 'http://localhost:9000', 'secret']);
    for (const value of ['5000', '300001', 'abc', '1.5', '-1']) {
        assert.throws(() => readNetworkConfig({ PYROCK_PROXY_MODE: 'hybrid', PYROCK_FREE_SEARCH_TIMEOUT_MS: value }), RangeError, value);
    }
    for (const url of ['http://pool.example:8899', 'https://127.0.0.1:8899', 'not a url']) {
        assert.throws(() => readNetworkConfig({ PYROCK_PROXY_MODE: 'hybrid', PYROCK_PROXY_POOL_URL: url }), TypeError, url);
    }
});

function fakePool(proxies, { count = { total: 312, http: 150, socks5: 162 } } = {}) {
    const queue = [...proxies];
    const reports = [];
    const fetchImpl = async url => {
        const target = new URL(url);
        if (target.pathname === '/count') {
            return { ok: true, status: 200, json: async () => count };
        }
        if (target.pathname === '/pop') {
            const next = queue.shift();
            return next
                ? { ok: true, status: 200, json: async () => ({ proxy: next, url: `http://${next}`, type: 'http', https: true }) }
                : { ok: false, status: 404, json: async () => ({ code: 0, src: 'no proxy' }) };
        }
        reports.push(target.searchParams.get('proxy') + ':' + target.searchParams.get('ok'));
        return { ok: true, status: 200, json: async () => ({}) };
    };
    return { fetchImpl, reports };
}

const hybridEnv = { PYROCK_PROXY: 'http://user:pw@gw.example:823', PYROCK_PROXY_STICKY_BASE: '10000' };

test('the manager keeps a sanitized state per section and reports a lost free proxy', async () => {
    const pool = fakePool(['8.8.4.4:3128']);
    const manager = createNetworkManager({
        config: readNetworkConfig({ PYROCK_PROXY_MODE: 'hybrid' }), env: hybridEnv, fetchImpl: pool.fetchImpl,
        probe: async () => '8.8.4.4'
    });
    assert.equal(manager.view('s1').state, 'waiting');
    const result = await manager.assign('s1');
    assert.equal(result.provider, 'free');
    const view = manager.view('s1');
    assert.deepEqual([view.state, view.provider, view.ip], ['connected', 'free', '8.8.4.4']);
    assert.equal(view.proxy, 'http://8.8.4.4:3128');
    assert.ok(view.since);
    await manager.reportLoss('s1');
    assert.deepEqual(pool.reports, ['8.8.4.4:3128:0']);
    manager.release('s1');
    assert.equal(manager.view('s1').state, 'waiting');
});

test('a paid section never exposes its credentials and is not reported to the pool', async () => {
    const pool = fakePool([]);
    const manager = createNetworkManager({
        config: readNetworkConfig({ PYROCK_PROXY_MODE: 'hybrid' }), env: hybridEnv, fetchImpl: pool.fetchImpl,
        probe: async proxy => (proxy.username ? '5.5.5.5' : '')
    });
    const result = await manager.assign('s2');
    assert.equal(result.provider, 'dataimpulse');
    const view = manager.view('s2');
    assert.deepEqual([view.state, view.provider, view.reason], ['connected', 'dataimpulse', 'pool_empty']);
    assert.doesNotMatch(JSON.stringify(view), /user|pw|@/, 'no credentials in the view');
    await manager.reportLoss('s2');
    assert.deepEqual(pool.reports, [], 'a paid port is not a pool entry');
});

test('a section without any exit waits with its reason and the pool status is visible', async () => {
    const manager = createNetworkManager({
        config: readNetworkConfig({ PYROCK_PROXY_MODE: 'hybrid' }), env: {}, fetchImpl: fakePool([]).fetchImpl,
        probe: async () => { throw new Error('unused'); }
    });
    const result = await manager.assign('s1');
    assert.equal(result.provider, null);
    const view = manager.view('s1');
    assert.deepEqual([view.state, view.reason, view.freeReason], ['waiting', 'fallback_unavailable', 'pool_empty']);
    assert.equal(manager.summary().pool.status, 'empty');
    assert.equal(manager.summary().fallbackConfigured, false);
});

test('the manager publishes how many proxies the pool still has', async () => {
    const pool = fakePool(['8.8.4.4:3128']);
    const manager = createNetworkManager({
        config: readNetworkConfig({ PYROCK_PROXY_MODE: 'hybrid' }), env: hybridEnv, fetchImpl: pool.fetchImpl,
        probe: async () => '8.8.4.4'
    });
    await manager.assign('s1');
    const summary = manager.summary();
    assert.equal(summary.pool.status, 'ok');
    assert.equal(summary.pool.count.total, 312);
    assert.deepEqual(summary.pool.count.byType, { http: 150, socks5: 162 });
});

test('a pool that cannot be asked for its inventory publishes none', async () => {
    const manager = createNetworkManager({
        config: readNetworkConfig({ PYROCK_PROXY_MODE: 'hybrid' }), env: hybridEnv,
        fetchImpl: async url => {
            if (new URL(url).pathname === '/count') throw new Error('ECONNREFUSED');
            return { ok: true, status: 200, json: async () => ({ proxy: '8.8.4.4:3128', url: 'http://8.8.4.4:3128', type: 'http' }) };
        },
        probe: async () => '8.8.4.4'
    });
    await manager.assign('s1');
    assert.equal(manager.summary().pool.count, null, 'no inventory is better than a wrong one');
});

test('a recovery is counted as a reconnection', async () => {
    const pool = fakePool(['8.8.4.4:3128', '1.1.1.1:3128']);
    const ips = ['8.8.4.4', '1.1.1.1'];
    const manager = createNetworkManager({
        config: readNetworkConfig({ PYROCK_PROXY_MODE: 'hybrid' }), env: {}, fetchImpl: pool.fetchImpl,
        probe: async () => ips.shift()
    });
    await manager.assign('s1');
    await manager.assign('s1', { recovering: true });
    assert.equal(manager.view('s1').reconnects, 1);
    assert.equal(manager.view('s1').ip, '1.1.1.1');
});

// ---- sessions -----------------------------------------------------------

function sessionManager(extra = {}) {
    const closed = [];
    let serial = 0;
    const manager = createSessionManager({
        openPage: async () => ({ context: `c${++serial}`, page: `p${serial}` }),
        closeContext: async context => closed.push(context),
        createController: () => ({ close: async () => {}, setUnavailable: async () => {}, setPage: async () => {} }),
        ...extra
    });
    return { manager, closed };
}

test('suspend and resume keep the section while its exit is replaced', async () => {
    const { manager, closed } = sessionManager();
    assert.equal(manager.peekNextId(), 's1');
    const section = await manager.create({ name: 'Cuenta' });
    assert.equal(manager.peekNextId(), 's2', 'peeking does not consume an id');
    await manager.suspend('s1');
    assert.deepEqual([section.page, section.context, section.state], [null, null, 'unavailable']);
    assert.deepEqual(closed, ['c1'], 'the old context is closed at once');
    assert.equal(manager.get('s1'), section, 'the section is still there');
    await manager.resume('s1');
    assert.deepEqual([section.state, section.context, section.name], ['ready', 'c2', 'Cuenta']);
    await assert.rejects(manager.suspend('missing'), { status: 404 });
    await assert.rejects(manager.resume('missing'), { status: 404 });
});

test('a closed section is announced so its exit can be released', async () => {
    const seen = [];
    const { manager } = sessionManager({ onClosed: section => seen.push(section.id) });
    await manager.create();
    await manager.create();
    await manager.close('s1');
    assert.deepEqual(seen, ['s1']);
    await manager.closeAll();
    assert.deepEqual(seen, ['s1', 's2']);
});

// ---- engine -------------------------------------------------------------

function fakeBrowser() {
    const calls = [];
    const page = { on() {}, route: async () => {}, url: () => 'about:blank', isClosed: () => false };
    return {
        calls,
        newContext: async options => {
            calls.push(options);
            return { on() {}, newPage: async () => page, close: async () => {} };
        }
    };
}

test('hybrid launch sets no global proxy and closes the direct and WebRTC leaks', async () => {
    let received;
    const engine = createCamoufoxEngine({ loader: async () => ({ Camoufox: async options => { received = options; return {}; } }) });
    await withEnv({
        PYROCK_PROXY_MODE: 'hybrid', PYROCK_PROXY: 'http://user:pw@gw.example:823',
        PYROCK_PROXY_STICKY_BASE: '10000', PYROCK_GEOIP: '1'
    }, () => engine.launch());
    assert.equal(received.proxy, undefined, 'the paid proxy is not the browser-wide proxy');
    assert.equal(received.geoip, undefined, 'no geolocation derived from a paid exit');
    assert.equal(received.firefox_user_prefs['network.proxy.failover_direct'], false, 'a dead proxy never falls back to direct');
    assert.equal(received.firefox_user_prefs['media.peerconnection.ice.proxy_only_if_behind_proxy'], true);
    assert.equal(received.firefox_user_prefs['media.ffmpeg.use-system-libavcodec'], true, 'the codec preference is kept');
});

test('outside the hybrid mode the browser-wide proxy still works as before', async () => {
    let received;
    const engine = createCamoufoxEngine({ loader: async () => ({ Camoufox: async options => { received = options; return {}; } }) });
    await withEnv({ PYROCK_PROXY_MODE: undefined, PYROCK_PROXY: 'http://u:p@gw.example:823', PYROCK_PROXY_STICKY_BASE: undefined, PYROCK_GEOIP: undefined },
        () => engine.launch());
    assert.equal(received.proxy, 'http://u:p@gw.example:823');
    assert.equal(received.firefox_user_prefs['network.proxy.failover_direct'], undefined);
});

test('a hybrid section can only open with an assigned proxy and restores its state', async () => {
    const browser = fakeBrowser();
    const engine = createCamoufoxEngine();
    await withEnv({ PYROCK_PROXY_MODE: 'hybrid', PYROCK_PROXY: 'http://u:p@gw.example:823', PYROCK_PROXY_STICKY_BASE: '10000' }, async () => {
        await assert.rejects(engine.openPage(browser, { section: { id: 's1' } }), /proxy/i);
        assert.deepEqual(browser.calls, [], 'no context was created, so nothing could leave directly');
        const state = { cookies: [], origins: [] };
        await engine.openPage(browser, { section: { id: 's1' }, proxy: { server: 'http://8.8.4.4:3128' }, storageState: state });
        assert.deepEqual(browser.calls[0], { proxy: { server: 'http://8.8.4.4:3128' }, storageState: state },
            'the assigned proxy wins over the legacy sticky port');
    });
});

test('outside the hybrid mode a section opens exactly as before', async () => {
    const browser = fakeBrowser();
    const engine = createCamoufoxEngine();
    await withEnv({ PYROCK_PROXY_MODE: undefined, PYROCK_PROXY: undefined, PYROCK_PROXY_STICKY_BASE: undefined }, async () => {
        await engine.openPage(browser, { section: { id: 's1' } });
        assert.deepEqual(browser.calls, [undefined]);
    });
});
