'use strict';
// A start page that cannot be opened must not leave the section unusable:
// the section is created, it is ready, and the operator can still navigate.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('a section is usable even when the start page cannot be opened', { timeout: 30000 }, async t => {
    const fixture = require('./fixtures/fake-camoufox');
    const originalModule = process.env.PYROCK_CAMOUFOX_MODULE;
    const originalConfig = globalThis.__pyrockCamoufoxConfig;
    process.env.PYROCK_CAMOUFOX_MODULE = path.join(__dirname, 'fixtures', 'fake-camoufox.js');
    // The start page never opens.
    globalThis.__pyrockCamoufoxConfig = { failGotoFor: 'browser.lol' };
    fixture.reset();
    const { server, startServer, stopServer } = require('../src/server');
    t.after(async () => {
        await stopServer();
        globalThis.__pyrockCamoufoxConfig = originalConfig;
        if (originalModule === undefined) delete process.env.PYROCK_CAMOUFOX_MODULE;
        else process.env.PYROCK_CAMOUFOX_MODULE = originalModule;
    });

    await startServer({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${server.address().port}`;
    const sessions = await (await fetch(`${base}/api/sessions`)).json();
    assert.equal(sessions.sessions.length, 1, 'the section exists even though the start page failed');
    assert.equal(sessions.sessions[0].state, 'ready', 'and it is ready to be used');
    // The operator can still navigate: their navigation is the one that counts.
    const navigated = await fetch(`${base}/api/navigate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.test/' })
    });
    assert.equal(navigated.status, 200, 'the section keeps working');
});
