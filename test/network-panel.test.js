'use strict';
// The "Red" panel: what the browser exits through, and which IP each section
// is using right now.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('the network answer says how the browser exits and which IP each section uses', async t => {
    const fixture = require('./fixtures/fake-camoufox');
    const originalModule = process.env.PYROCK_CAMOUFOX_MODULE;
    const originalProxy = process.env.PYROCK_PROXY;
    const originalBase = process.env.PYROCK_PROXY_STICKY_BASE;
    process.env.PYROCK_CAMOUFOX_MODULE = path.join(__dirname, 'fixtures', 'fake-camoufox.js');
    process.env.PYROCK_PROXY = 'http://user:secret@gw.example:823';
    process.env.PYROCK_PROXY_STICKY_BASE = '10000';
    fixture.reset();
    const { server, startServer, stopServer } = require('../server');
    try {
        await startServer({ host: '127.0.0.1', port: 0 });
        const base = `http://127.0.0.1:${server.address().port}`;

        const before = await (await fetch(`${base}/api/network`)).json();
        assert.equal(before.configured, true);
        assert.equal(before.host, 'gw.example');
        assert.equal(before.mode, 'sticky', 'each section keeps its own exit IP');
        assert.equal(before.credentials, 'user:••••••••', 'the password is never shown');
        assert.ok(before.sections.length >= 1);
        assert.match(before.sections[0].proxy, /:10001$/, 'the first section uses the first sticky port');
        assert.equal(before.sections[0].port, 10001, 'the section reports its own port');

        const measured = await (await fetch(`${base}/api/network/measure`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
        })).json();
        assert.equal(measured.sections.length, before.sections.length);
        assert.ok(measured.sections.every(section => section.ip), 'every section reports an IP');
        assert.ok(measured.sections.every(section => section.measuredAt), 'and says when it was measured');
        assert.equal(measured.sections[0].ipCount, 1, 'one IP seen so far in this section');

        const after = await (await fetch(`${base}/api/network`)).json();
        assert.ok(after.sections.every(section => section.ip), 'the last measurement is kept');
    } finally {
        await stopServer();
        for (const [key, value] of [['PYROCK_CAMOUFOX_MODULE', originalModule], ['PYROCK_PROXY', originalProxy], ['PYROCK_PROXY_STICKY_BASE', originalBase]]) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
