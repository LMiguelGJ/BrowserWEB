'use strict';
// Core of the hybrid network: free proxies from the pool first, DataImpulse
// only when the free search ends without a usable and distinct exit.
const test = require('node:test');
const assert = require('node:assert/strict');
const { isPublicIp, normalizeIp } = require('../src/network/ip');
const { createReservations } = require('../src/network/reservations');
const { createPoolClient } = require('../src/network/proxy-pool');
const { fallbackCandidates } = require('../src/network/proxy-fallback');
const { createAssigner } = require('../src/network/assigner');

test('only public addresses are accepted as an exit', () => {
    for (const ip of ['8.8.8.8', '203.0.113.7', '2001:4860:4860::8888']) assert.equal(isPublicIp(ip), true, ip);
    for (const ip of ['10.0.0.1', '127.0.0.1', '192.168.1.5', '172.16.5.5', '169.254.1.1', '100.64.0.1',
        '0.0.0.0', '224.0.0.1', '198.18.0.1', '::1', 'fe80::1', 'fc00::1', 'not an ip', '', null]) {
        assert.equal(isPublicIp(ip), false, String(ip));
    }
    assert.equal(normalizeIp('::ffff:8.8.8.8'), '8.8.8.8');
    assert.equal(normalizeIp('2001:DB8::1'), '2001:db8::1');
});

test('an exit belongs to one section at a time and is free again when released', () => {
    const reservations = createReservations();
    assert.equal(reservations.reserve('8.8.8.8', 's1', { provider: 'free' }), true);
    assert.equal(reservations.reserve('8.8.8.8', 's2', { provider: 'free' }), false, 'a second section cannot take it');
    assert.equal(reservations.reserve('8.8.8.8', 's1', { provider: 'free' }), true, 'the owner keeps it');
    assert.equal(reservations.holder('8.8.8.8'), 's1');
    reservations.release('s1');
    assert.equal(reservations.holder('8.8.8.8'), null);
    assert.equal(reservations.reserve('8.8.8.8', 's2', { provider: 'free' }), true);
    assert.equal(reservations.reserve('::ffff:1.1.1.1', 's3', {}), true);
    assert.equal(reservations.reserve('1.1.1.1', 's4', {}), false, 'the same address in another notation is the same exit');
});

function jsonResponse(status, body) {
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

test('the pool client asks for HTTP proxies with verified TLS and sends the password', async () => {
    const calls = [];
    const pool = createPoolClient({
        baseUrl: 'http://127.0.0.1:8899', password: 'secret',
        fetchImpl: async (url, options) => {
            calls.push({ url, headers: options.headers });
            return jsonResponse(200, { proxy: '8.8.4.4:3128', url: 'http://8.8.4.4:3128', type: 'http', https: true });
        }
    });
    const answer = await pool.pop();
    assert.equal(answer.status, 'ok');
    assert.deepEqual(answer.proxy, { endpoint: '8.8.4.4:3128', server: 'http://8.8.4.4:3128' });
    assert.equal(calls[0].url, 'http://127.0.0.1:8899/pop?protocol=http&https=1');
    assert.equal(calls[0].headers.authorization, `Basic ${Buffer.from('any:secret').toString('base64')}`);
});

test('the pool client tells an empty pool from an unavailable one', async () => {
    const make = fetchImpl => createPoolClient({ baseUrl: 'http://127.0.0.1:8899', password: 'x', fetchImpl });
    assert.equal((await make(async () => jsonResponse(404, { code: 0, src: 'no proxy' })).pop()).status, 'empty');
    const unauthorized = await make(async () => jsonResponse(401, {})).pop();
    assert.deepEqual([unauthorized.status, unauthorized.reason], ['unavailable', 'unauthorized']);
    assert.equal((await make(async () => { throw new Error('ECONNREFUSED'); }).pop()).status, 'unavailable');
    assert.equal((await make(async () => jsonResponse(500, {})).pop()).status, 'unavailable');
});

test('the pool client rejects what a section must never use', async () => {
    const pop = body => createPoolClient({
        baseUrl: 'http://127.0.0.1:8899', password: 'x', fetchImpl: async () => jsonResponse(200, body)
    }).pop();
    for (const [name, body, reason] of [
        ['socks', { proxy: '8.8.4.4:1080', url: 'socks5://8.8.4.4:1080', type: 'socks5' }, 'not_http'],
        ['private address', { proxy: '10.0.0.5:3128', url: 'http://10.0.0.5:3128', type: 'http' }, 'not_public'],
        ['loopback', { proxy: '127.0.0.1:3128', url: 'http://127.0.0.1:3128', type: 'http' }, 'not_public'],
        ['credentials', { proxy: '8.8.4.4:3128', url: 'http://user:pw@8.8.4.4:3128', type: 'http' }, 'credentials'],
        ['bad port', { proxy: '8.8.4.4:99999', url: 'http://8.8.4.4:99999', type: 'http' }, 'malformed'],
        ['no url', { proxy: '8.8.4.4:3128' }, 'malformed']
    ]) {
        const answer = await pop(body);
        assert.deepEqual([name, answer.status, answer.reason], [name, 'invalid', reason]);
    }
});

test('a failure is reported to the pool and never throws', async () => {
    const urls = [];
    const pool = createPoolClient({
        baseUrl: 'http://127.0.0.1:8899', password: 'x',
        fetchImpl: async url => { urls.push(url); return jsonResponse(200, {}); }
    });
    assert.equal(await pool.report('8.8.4.4:3128', false), true);
    assert.equal(urls[0], 'http://127.0.0.1:8899/report?proxy=8.8.4.4%3A3128&ok=0');
    const broken = createPoolClient({ baseUrl: 'http://127.0.0.1:8899', password: 'x', fetchImpl: async () => { throw new Error('down'); } });
    assert.equal(await broken.report('8.8.4.4:3128', false), false);
});

test('DataImpulse candidates use sticky ports of the section and never the rotating port', () => {
    const env = { PYROCK_PROXY: 'http://user:p%40ss@gw.example:823', PYROCK_PROXY_STICKY_BASE: '10000' };
    const candidates = fallbackCandidates('s3', env);
    assert.deepEqual(candidates.map(item => item.server), [
        'http://gw.example:10003', 'http://gw.example:10053', 'http://gw.example:10103'
    ]);
    assert.deepEqual([candidates[0].username, candidates[0].password], ['user', 'p@ss']);
    assert.equal(candidates.some(item => item.server.endsWith(':823')), false);
    assert.equal(fallbackCandidates('s1', { ...env, PYROCK_PROXY_STICKY_BASE: '' }), null, 'no sticky base, no fallback');
    assert.equal(fallbackCandidates('s1', { ...env, PYROCK_PROXY_STICKY_BASE: '9000' }), null, 'a base outside the sticky range');
    assert.equal(fallbackCandidates('s1', { PYROCK_PROXY_STICKY_BASE: '10000' }), null, 'no credentials, no fallback');
    assert.equal(fallbackCandidates('s1', { ...env, PYROCK_PROXY: 'not a url' }), null);
});

// ---- the assigner -------------------------------------------------------

function okItem(host, port = 3128) {
    return { status: 'ok', proxy: { endpoint: `${host}:${port}`, server: `http://${host}:${port}` } };
}

function makeKit({ items = [], exits = {}, fallbackEnv = null, clock = null, options = {} } = {}) {
    const queue = [...items];
    const kit = { reported: [], probed: [], fallbackProbes: 0, concurrent: 0, peak: 0 };
    kit.pool = {
        async pop() { return queue.shift() || { status: 'empty' }; },
        async report(endpoint, ok) { kit.reported.push([endpoint, ok]); return true; }
    };
    kit.reservations = createReservations();
    kit.assigner = createAssigner({
        pool: kit.pool,
        reservations: kit.reservations,
        fallback: { candidates: sectionId => (fallbackEnv ? fallbackCandidates(sectionId, fallbackEnv) : null) },
        now: clock || Date.now,
        probe: async (proxy, { timeoutMs }) => {
            kit.concurrent++; kit.peak = Math.max(kit.peak, kit.concurrent);
            try {
                kit.probed.push(proxy.server);
                if (proxy.username) kit.fallbackProbes++;
                const outcome = typeof exits === 'function' ? await exits(proxy, timeoutMs) : exits[proxy.server];
                if (outcome instanceof Error || outcome === undefined) throw outcome || new Error('no answer');
                return outcome;
            } finally { kit.concurrent--; }
        },
        ...options
    });
    return kit;
}

const PAID = { PYROCK_PROXY: 'http://user:pw@gw.example:823', PYROCK_PROXY_STICKY_BASE: '10000' };

test('a verified free proxy is used and DataImpulse is never touched', async () => {
    const kit = makeKit({ items: [okItem('8.8.4.4')], exits: { 'http://8.8.4.4:3128': '8.8.4.4' }, fallbackEnv: PAID });
    const result = await kit.assigner.assign('s1');
    assert.equal(result.provider, 'free');
    assert.equal(result.ip, '8.8.4.4');
    assert.deepEqual(result.proxy, { server: 'http://8.8.4.4:3128' });
    assert.equal(kit.fallbackProbes, 0, 'not a single paid probe');
    assert.equal(kit.reservations.holder('8.8.4.4'), 's1');
});

test('a proxy that fails the browser measurement is reported and the next one is tried', async () => {
    const kit = makeKit({
        items: [okItem('8.8.4.4'), okItem('1.1.1.1')],
        exits: { 'http://8.8.4.4:3128': new Error('timeout'), 'http://1.1.1.1:3128': '1.1.1.1' }
    });
    const result = await kit.assigner.assign('s1');
    assert.equal(result.provider, 'free');
    assert.equal(result.ip, '1.1.1.1');
    assert.deepEqual(kit.reported, [['8.8.4.4:3128', false]]);
});

test('a second section never publishes the exit of the first one', async () => {
    const kit = makeKit({
        items: [okItem('8.8.4.4'), okItem('9.9.9.9'), okItem('1.1.1.1')],
        exits: { 'http://8.8.4.4:3128': '8.8.4.4', 'http://9.9.9.9:3128': '8.8.4.4', 'http://1.1.1.1:3128': '1.1.1.1' }
    });
    assert.equal((await kit.assigner.assign('s1')).ip, '8.8.4.4');
    const second = await kit.assigner.assign('s2');
    assert.equal(second.ip, '1.1.1.1', 'the duplicate exit was skipped');
    assert.equal(kit.reservations.holder('8.8.4.4'), 's1');
    assert.deepEqual(kit.reported, [], 'a working proxy that merely duplicates an exit is not reported as broken');
});

test('an invalid candidate is reported and skipped', async () => {
    const kit = makeKit({
        items: [{ status: 'invalid', reason: 'not_http', endpoint: '8.8.4.4:1080' }, okItem('1.1.1.1')],
        exits: { 'http://1.1.1.1:3128': '1.1.1.1' }
    });
    const result = await kit.assigner.assign('s1');
    assert.equal(result.provider, 'free');
    assert.deepEqual(kit.reported, [['8.8.4.4:1080', false]]);
});

test('an empty pool falls back to DataImpulse with its sticky port', async () => {
    const kit = makeKit({ items: [], exits: { 'http://gw.example:10001': '5.5.5.5' }, fallbackEnv: PAID });
    const result = await kit.assigner.assign('s1');
    assert.equal(result.provider, 'dataimpulse');
    assert.equal(result.reason, 'pool_empty');
    assert.deepEqual(result.proxy, { server: 'http://gw.example:10001', username: 'user', password: 'pw' });
    assert.equal(result.ip, '5.5.5.5');
});

test('an unavailable pool falls back and says why', async () => {
    const kit = makeKit({ exits: { 'http://gw.example:10001': '5.5.5.5' }, fallbackEnv: PAID });
    kit.pool.pop = async () => ({ status: 'unavailable', reason: 'unauthorized' });
    const result = await kit.assigner.assign('s1');
    assert.deepEqual([result.provider, result.reason], ['dataimpulse', 'pool_unavailable']);
});

test('when every candidate failed the reason is candidates_exhausted', async () => {
    const kit = makeKit({
        items: [okItem('8.8.4.4'), okItem('1.1.1.1')],
        exits: { 'http://gw.example:10001': '5.5.5.5' }, fallbackEnv: PAID
    });
    const result = await kit.assigner.assign('s1');
    assert.deepEqual([result.provider, result.reason], ['dataimpulse', 'candidates_exhausted']);
    assert.equal(kit.reported.length, 2);
});

test('a deadline is not described as an exhausted pool', async () => {
    let time = 0;
    const kit = makeKit({
        items: [okItem('8.8.4.4'), okItem('1.1.1.1'), okItem('9.9.9.9'), okItem('4.4.4.4')],
        exits: async () => { time += 30000; throw new Error('slow'); },
        clock: () => time, fallbackEnv: PAID, options: { freeDeadlineMs: 60000 }
    });
    kit.assigner = createAssigner({
        pool: kit.pool, reservations: kit.reservations, now: () => time, freeDeadlineMs: 60000,
        fallback: { candidates: sectionId => fallbackCandidates(sectionId, PAID) },
        probe: async proxy => {
            kit.probed.push(proxy.server);
            if (proxy.username) return '5.5.5.5';
            time += 30000; throw new Error('slow');
        }
    });
    const result = await kit.assigner.assign('s1');
    assert.equal(result.provider, 'dataimpulse');
    assert.equal(result.reason, 'deadline_exceeded');
    assert.equal(kit.probed.filter(server => server.includes(':3128')).length, 2, 'candidates were left untested');
});

test('without a DataImpulse configuration the section waits and nothing leaves directly', async () => {
    const kit = makeKit({ items: [], fallbackEnv: null });
    const result = await kit.assigner.assign('s1');
    assert.deepEqual([result.provider, result.reason, result.freeReason], [null, 'fallback_unavailable', 'pool_empty']);
    assert.deepEqual(kit.probed, [], 'no probe without a proxy');
});

test('duplicate paid exits move to the next sticky port and give up after three', async () => {
    const kit = makeKit({ exits: {}, fallbackEnv: PAID });
    kit.reservations.reserve('5.5.5.5', 's9', {});
    kit.assigner = createAssigner({
        pool: kit.pool, reservations: kit.reservations,
        fallback: { candidates: sectionId => fallbackCandidates(sectionId, PAID) },
        probe: async proxy => {
            kit.probed.push(proxy.server);
            return proxy.server.endsWith(':10051') ? '6.6.6.6' : '5.5.5.5';
        }
    });
    const first = await kit.assigner.assign('s1');
    assert.equal(first.provider, 'dataimpulse');
    assert.equal(first.proxy.server, 'http://gw.example:10051');
    kit.probed.length = 0;
    const stuck = createAssigner({
        pool: kit.pool, reservations: kit.reservations,
        fallback: { candidates: sectionId => fallbackCandidates(sectionId, PAID) },
        probe: async proxy => { kit.probed.push(proxy.server); return '5.5.5.5'; }
    });
    const failed = await stuck.assign('s2');
    assert.deepEqual([failed.provider, failed.reason], [null, 'fallback_failed']);
    assert.equal(kit.probed.length, 3, 'no fourth attempt');
});

test('releasing a section frees its exit and assigning again drops the old one', async () => {
    const kit = makeKit({
        items: [okItem('8.8.4.4'), okItem('1.1.1.1')],
        exits: { 'http://8.8.4.4:3128': '8.8.4.4', 'http://1.1.1.1:3128': '1.1.1.1' }
    });
    await kit.assigner.assign('s1');
    const again = await kit.assigner.assign('s1');
    assert.equal(again.ip, '1.1.1.1');
    assert.equal(kit.reservations.holder('8.8.4.4'), null, 'the previous exit was released');
    kit.assigner.release('s1');
    assert.equal(kit.reservations.holder('1.1.1.1'), null);
});

test('a cancelled section keeps no reservation', async () => {
    const kit = makeKit({ items: [okItem('8.8.4.4')], exits: { 'http://8.8.4.4:3128': '8.8.4.4' } });
    let cancelled = false;
    kit.assigner = createAssigner({
        pool: kit.pool, reservations: kit.reservations, fallback: { candidates: () => null },
        probe: async () => { cancelled = true; return '8.8.4.4'; }
    });
    const result = await kit.assigner.assign('s1', { isCancelled: () => cancelled });
    assert.deepEqual([result.provider, result.reason], [null, 'cancelled']);
    assert.equal(kit.reservations.holder('8.8.4.4'), null);
});

test('at most two probes run at the same time across sections', async () => {
    const release = [];
    const kit = makeKit({
        items: ['8.8.4.4', '1.1.1.1', '9.9.9.9', '4.4.4.4'].map(host => okItem(host)),
        exits: proxy => new Promise(resolve => release.push(() => resolve(proxy.server.split('//')[1].split(':')[0])))
    });
    const jobs = ['s1', 's2', 's3', 's4'].map(id => kit.assigner.assign(id));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(kit.peak, 2, 'a third probe waits its turn');
    while (release.length || kit.concurrent) {
        release.splice(0).forEach(fn => fn());
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    const results = await Promise.all(jobs);
    assert.equal(new Set(results.map(item => item.ip)).size, 4);
    assert.equal(kit.peak, 2);
});
