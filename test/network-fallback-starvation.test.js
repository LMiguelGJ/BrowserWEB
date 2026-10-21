const test = require('node:test');
const assert = require('node:assert/strict');
const { createAssigner } = require('../src/network/assigner');
const { createReservations } = require('../src/network/reservations');
const { fallbackCandidates } = require('../src/network/proxy-fallback');

const PAID = { PYROCK_PROXY: 'http://user:pw@gw.example:823', PYROCK_PROXY_STICKY_BASE: '10000' };

function stuckFreeItem(index) {
    return { status: 'ok', proxy: { endpoint: `9.9.9.${index}:3128`, server: `http://9.9.9.${index}:3128` } };
}

// Free searches of other sections keep every measurement slot busy for as long
// as their candidates take to answer. The paid exit is a short list of known
// sticky ports: it must not wait in line behind that.
test('the paid fallback is measured even while free searches hold every measurement slot', async () => {
    const stuck = [stuckFreeItem(1), stuckFreeItem(2)];
    const release = [];
    const pool = {
        async pop() { return stuck.shift() || { status: 'empty' }; },
        async report() { return true; }
    };
    const assigner = createAssigner({
        pool, reservations: createReservations(), maxConcurrentProbes: 2,
        fallback: { candidates: sectionId => fallbackCandidates(sectionId, PAID) },
        probe: async proxy => {
            if (proxy.username) return `84.225.169.${proxy.server.slice(-2)}`;
            await new Promise(resolve => release.push(resolve)); // a free candidate that never answers
            throw new Error('NS_ERROR_PROXY_CONNECTION_REFUSED');
        }
    });

    const hogs = [assigner.assign('s1'), assigner.assign('s2')];
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(release.length, 2, 'both slots are held by free candidates');

    const outcome = await Promise.race([
        assigner.assign('s3'),
        new Promise(resolve => setTimeout(() => resolve('starved'), 500))
    ]);
    release.forEach(resolve => resolve());
    await Promise.allSettled(hogs);
    assert.notEqual(outcome, 'starved', 'the paid fallback waited behind the free probes');
    assert.equal(outcome.provider, 'dataimpulse');
    assert.match(outcome.proxy.server, /^http:\/\/gw\.example:100\d\d$/);
});

test('the time waiting for a measurement slot is not taken from the paid probe', async () => {
    // The paid probe gets its own budget: a long queue elsewhere never leaves it
    // with a zero timeout.
    const timeouts = [];
    const assigner = createAssigner({
        pool: { async pop() { return { status: 'empty' }; }, async report() { return true; } },
        reservations: createReservations(),
        fallback: { candidates: sectionId => fallbackCandidates(sectionId, PAID) },
        probe: async (proxy, { timeoutMs }) => { timeouts.push(timeoutMs); return '84.225.169.5'; }
    });
    const outcome = await assigner.assign('s5');
    assert.equal(outcome.provider, 'dataimpulse');
    assert.ok(timeouts[0] >= 10000, `the residential exit is slower to open in a browser: got ${timeouts[0]} ms`);
});
