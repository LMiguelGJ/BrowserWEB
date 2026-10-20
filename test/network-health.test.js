'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProxyHealth, isProxyTransportFailure } = require('../src/network/proxy-health');

function fakeClock() {
    let now = 0, next = 1;
    const timers = new Map();
    return {
        now: () => now,
        setTimeout(fn, ms) { const id = next++; timers.set(id, { fn, at: now + ms }); return id; },
        clearTimeout(id) { timers.delete(id); },
        async advance(ms) {
            now += ms;
            while (true) {
                const due = [...timers].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                timers.delete(due[0]); due[1].fn(); await Promise.resolve(); await Promise.resolve();
            }
        },
        get count() { return timers.size; }
    };
}

test('only clear proxy-tunnel failures trigger immediate recovery', () => {
    for (const message of ['net::ERR_PROXY_CONNECTION_FAILED', 'net::ERR_TUNNEL_CONNECTION_FAILED', 'NS_ERROR_PROXY_CONNECTION_REFUSED']) {
        assert.equal(isProxyTransportFailure(message), true, message);
    }
    for (const message of ['HTTP 403', 'HTTP 429', 'net::ERR_CONNECTION_RESET', 'Navigation timeout']) {
        assert.equal(isProxyTransportFailure(message), false, message);
    }
});

test('health checks stagger, deduplicate, and require two consecutive failures', async () => {
    const clock = fakeClock();
    const checks = [], recoveries = [];
    let answer = false, release;
    const health = createProxyHealth({
        intervalMs: 120, jitterMs: 15, random: () => 0.5,
        setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        sections: () => [{ id: 's1', state: 'connected', provider: 'free' }],
        check: async id => { checks.push(id); if (release) await new Promise(resolve => { release = resolve; }); return answer ? '8.8.4.4' : null; },
        recover: async id => recoveries.push(id)
    });
    health.start();
    assert.equal(clock.count, 1);
    await clock.advance(120);
    assert.deepEqual(checks, ['s1']);
    assert.deepEqual(recoveries, [], 'one failed probe is not enough');
    await clock.advance(120);
    assert.deepEqual(recoveries, ['s1'], 'the second consecutive failure starts one recovery');
    await health.checkNow('s1');
    assert.deepEqual(recoveries, ['s1'], 'concurrent checks/recovery do not fan out');
    answer = true;
    health.stop();
    assert.equal(clock.count, 0);
});

test('healthy paid exits are checked but never searched for a free replacement', async () => {
    const calls = [];
    const health = createProxyHealth({
        intervalMs: 1000, jitterMs: 0, random: () => 0,
        sections: () => [{ id: 's3', state: 'connected', provider: 'dataimpulse' }],
        check: async id => { calls.push(['check', id]); return '8.8.4.4'; },
        recover: async id => calls.push(['recover', id])
    });
    await health.checkNow('s3');
    assert.deepEqual(calls, [['check', 's3']]);
    health.stop();
});

 test('stopping health cancels the scheduled sweep', () => {
    const clock = fakeClock();
    const health = createProxyHealth({
        intervalMs: 1000, jitterMs: 0, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        sections: () => [], check: async () => null, recover: async () => {}
    });
    health.start();
    assert.equal(clock.count, 1);
    health.stop();
    assert.equal(clock.count, 0);
});
