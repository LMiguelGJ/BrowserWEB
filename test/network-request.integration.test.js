'use strict';
// The operator asks the hybrid flow to start again for one section: the
// search runs again, the section keeps its identity and its state, and the
// proxy that was working is not reported to the pool as broken.
// The pool is a local fake and Camoufox is the fixture: nothing here touches
// the internet.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startPool, postJson, waitFor } = require('./helpers/fake-pool');

test('the operator can ask again for an exit for a section, and the old proxy is not reported as broken', { timeout: 60000 }, async t => {
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
    const originalConfig = globalThis.__pyrockCamoufoxConfig;
    globalThis.__pyrockCamoufoxConfig = {
        ipFor: options => {
            const server = options?.proxy?.server;
            if (!server) throw new Error('direct traffic must never happen');
            return new URL(server).hostname;
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
    assert.deepEqual([networkControl.view('s1').provider, networkControl.view('s1').ip], ['free', '8.8.4.4']);

    // The operator asks again: the search starts over for that section.
    const popsBefore = pool.pops;
    const response = await postJson(base, '/api/network/request', { session: 's1' });
    assert.equal(response.status, 200, 'the request is accepted');
    await waitFor(() => pool.pops > popsBefore, 'the request never asked the pool for another exit');
    await waitFor(() => networkControl.view('s1').ip === '1.1.1.1', 'the section never took the new free exit');
    assert.deepEqual([networkControl.view('s1').provider, networkControl.view('s1').ip], ['free', '1.1.1.1']);
    assert.equal(
        pool.reports.some(report => report.startsWith('8.8.4.4:3128')),
        false,
        'a deliberate change is not a failure of the proxy that was working'
    );
    const state = fixture.currentState();
    const open = state.contexts.filter(context => !context.closed);
    assert.equal(open.length, 1, 'the section kept a single context, now on the new exit');
    assert.equal(open[0].options.proxy.server, 'http://1.1.1.1:3128');

    // A section that does not exist is refused, and so is a request without one.
    assert.equal((await postJson(base, '/api/network/request', { session: 'nope' })).status, 404);
    assert.equal((await postJson(base, '/api/network/request', {})).status, 400);
});
