'use strict';
// A section that runs out of HTTP proxies takes a SOCKS5 one: the pool is
// asked for SOCKS only after the HTTP supply is empty, the browser gets the
// scheme it needs, and the exit is measured as a public address of its own.
// The pool is a local fake and Camoufox is the fixture: nothing here touches
// the internet.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startPool, postJson, waitFor } = require('./helpers/fake-pool');

test('a section takes a SOCKS5 exit when the pool has no HTTP proxies left', { timeout: 60000 }, async t => {
    const fixture = require('./fixtures/fake-camoufox');
    const pool = await startPool(['8.8.4.4:3128', 'socks5://1.1.1.1:1080']);
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
    const state = fixture.currentState();

    // The first section takes the only HTTP proxy.
    assert.deepEqual([networkControl.view('s1').provider, networkControl.view('s1').ip], ['free', '8.8.4.4']);
    assert.equal(networkControl.view('s1').proxy, 'http://8.8.4.4:3128');

    // The second one finds the HTTP supply empty and takes the SOCKS proxy.
    const created = await postJson(base, '/api/sessions', { name: 'Socks' });
    assert.equal(created.status, 201);
    const view = networkControl.view('s2');
    assert.deepEqual([view.provider, view.ip], ['free', '1.1.1.1'], 'the SOCKS exit was measured as a public address');
    assert.equal(view.proxy, 'socks5://1.1.1.1:1080', 'the scheme travels to the browser');
    assert.equal(view.endpoint, '1.1.1.1:1080', 'the pool entry is known without credentials');

    // The browser context of that section really uses the SOCKS proxy.
    const context = state.contexts.find(item => !item.closed && item.options?.proxy?.server === 'socks5://1.1.1.1:1080');
    assert.ok(context, 'the section opened its context through the SOCKS proxy');
    assert.equal(context.options.proxy.username, undefined, 'no credentials are invented for a free proxy');

    // Both exits are public and different, one per section.
    const ips = [networkControl.view('s1').ip, networkControl.view('s2').ip];
    assert.equal(new Set(ips).size, 2, 'each section keeps its own exit');
    assert.equal(pool.unauthorized, 0, 'every request to the pool carried the password');
});
