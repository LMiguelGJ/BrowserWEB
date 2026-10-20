'use strict';
// There is no limit on sections: each one is a browser context and what
// bounds them is the memory of the machine, not the code.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('sections are not capped: the operator can open as many as needed', async t => {
    const fixture = require('./fixtures/fake-camoufox');
    const originalModule = process.env.PYROCK_CAMOUFOX_MODULE;
    process.env.PYROCK_CAMOUFOX_MODULE = path.join(__dirname, 'fixtures', 'fake-camoufox.js');
    fixture.reset();
    const { server, startServer, stopServer } = require('../server');
    t.after(async () => {
        await stopServer();
        if (originalModule === undefined) delete process.env.PYROCK_CAMOUFOX_MODULE;
        else process.env.PYROCK_CAMOUFOX_MODULE = originalModule;
    });

    await startServer({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${server.address().port}`;
    const listing = await (await fetch(`${base}/api/sessions`)).json();
    assert.equal(listing.max, 0, 'zero means no limit');

    for (let index = 2; index <= 8; index++) {
        const created = await fetch(`${base}/api/sessions`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: `Sección ${index}` })
        });
        assert.equal(created.status, 201, `la sección ${index} se puede crear`);
    }
    const after = await (await fetch(`${base}/api/sessions`)).json();
    assert.equal(after.sessions.length, 8, 'all the sections are open at the same time');
});
