'use strict';
// The port has to answer while the browser is still starting: a slow start
// page must not leave the app without an answer, because the proxy in front
// answers 502 when the upstream is not listening yet.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('the port answers while the browser is still starting', { timeout: 30000 }, async t => {
    const fixture = require('./fixtures/fake-camoufox');
    const originalModule = process.env.PYROCK_CAMOUFOX_MODULE;
    const originalConfig = globalThis.__pyrockCamoufoxConfig;
    process.env.PYROCK_CAMOUFOX_MODULE = path.join(__dirname, 'fixtures', 'fake-camoufox.js');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    // The first page never finishes loading until the test says so.
    globalThis.__pyrockCamoufoxConfig = { beforeNewPage: async () => { await gate; } };
    fixture.reset();
    const { server, startServer, stopServer } = require('../server');
    t.after(async () => {
        release();
        await stopServer();
        globalThis.__pyrockCamoufoxConfig = originalConfig;
        if (originalModule === undefined) delete process.env.PYROCK_CAMOUFOX_MODULE;
        else process.env.PYROCK_CAMOUFOX_MODULE = originalModule;
    });

    const starting = startServer({ host: '127.0.0.1', port: 0 });
    const deadline = Date.now() + 8000;
    while (!server.address() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(server.address(), 'the port is open while the browser starts');
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200, 'the app answers while the browser is starting');
    const body = await health.json();
    assert.equal(body.status, 'ok', 'and the app reports itself healthy');
    release();
    await starting;
});
