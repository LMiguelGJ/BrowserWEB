'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('the diagnostics endpoint reports real memory without exposing credentials', async t => {
    const fixture = require('./fixtures/fake-camoufox');
    process.env.PYROCK_CAMOUFOX_MODULE = path.join(__dirname, 'fixtures', 'fake-camoufox.js');
    process.env.PYROCK_PROXY = 'http://secret-user:secret-pass@gw.example:823';
    process.env.PYROCK_PROXY_STICKY_BASE = '10000';
    fixture.reset();
    const { server, startServer, stopServer } = require('../src/server');
    t.after(async () => {
        await stopServer();
        delete process.env.PYROCK_PROXY;
        delete process.env.PYROCK_PROXY_STICKY_BASE;
    });

    await startServer({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/diagnostics`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.node.rss > 0, 'the node process reports its own memory');
    assert.ok(Number.isInteger(body.node.heapUsed));
    assert.equal(Array.isArray(body.processes) || body.processes === null, true, 'child processes are listed when /proc exists');
    assert.ok(body.sections.total >= 1, 'the open sections are counted');
    assert.ok(body.sections.contexts >= 1, 'the live browser contexts are counted');
    assert.deepEqual(body.probes, { created: body.probes.created, closed: body.probes.closed, failed: body.probes.failed });
    assert.equal(Number.isInteger(body.probes.created), true);
    assert.ok(Array.isArray(body.sections.closeFailures));
    const raw = JSON.stringify(body);
    assert.equal(raw.includes('secret-pass'), false, 'no credential is exposed');
    assert.equal(raw.includes('secret-user'), false, 'no credential user is exposed');
});
