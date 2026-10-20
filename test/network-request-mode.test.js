'use strict';
// Outside the hybrid mode there is no free pool to ask, so the manual
// request is refused instead of pretending to look for an exit.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { postJson } = require('./helpers/fake-pool');

test('the request is refused when the hybrid mode is not active', async t => {
    const fixture = require('./fixtures/fake-camoufox');
    const originalModule = process.env.PYROCK_CAMOUFOX_MODULE;
    const originalMode = process.env.PYROCK_PROXY_MODE;
    process.env.PYROCK_CAMOUFOX_MODULE = path.join(__dirname, 'fixtures', 'fake-camoufox.js');
    delete process.env.PYROCK_PROXY_MODE;
    fixture.reset();
    const { server, startServer, stopServer } = require('../src/server');
    t.after(async () => {
        await stopServer();
        for (const [key, value] of [['PYROCK_CAMOUFOX_MODULE', originalModule], ['PYROCK_PROXY_MODE', originalMode]]) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    });

    await startServer({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await postJson(base, '/api/network/request', { session: 's1' });
    assert.equal(response.status, 400, 'without the hybrid mode there is no free pool to ask');
    const body = await response.json();
    assert.match(body.error, /modo híbrido/);
});
