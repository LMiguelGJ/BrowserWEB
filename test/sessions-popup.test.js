'use strict';
// A site that opens a link in a new tab (a session link, a popup) must be
// followed by the section: the preview has to show where the site went.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('a tab opened by the site becomes the section page', async t => {
    const fixture = require('./fixtures/fake-camoufox');
    const originalConfig = globalThis.__pyrockCamoufoxConfig;
    const originalModule = process.env.PYROCK_CAMOUFOX_MODULE;
    globalThis.__pyrockCamoufoxConfig = undefined;
    process.env.PYROCK_CAMOUFOX_MODULE = path.join(__dirname, 'fixtures', 'fake-camoufox.js');
    const state = fixture.reset();
    const { server, startServer, stopServer } = require('../server');
    t.after(async () => {
        await stopServer();
        globalThis.__pyrockCamoufoxConfig = originalConfig;
        if (originalModule === undefined) delete process.env.PYROCK_CAMOUFOX_MODULE;
        else process.env.PYROCK_CAMOUFOX_MODULE = originalModule;
    });
    await startServer({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${server.address().port}`;

    const capture = async () => (await fetch(`${base}/api/screenshot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    const before = await capture();
    assert.equal(before.screenshot, `data:image/jpeg;base64,${Buffer.from('shot').toString('base64')}`);

    // The site opens the session in a new tab.
    await state.contexts[0].openPopup('session-tab');
    await new Promise(resolve => setImmediate(resolve));

    const after = await capture();
    assert.equal(after.screenshot, `data:image/jpeg;base64,${Buffer.from('session-tab').toString('base64')}`, 'the section previews the new tab');

    const listing = await (await fetch(`${base}/api/sessions`)).json();
    assert.equal(listing.sessions[0].state, 'ready');

    // Closing the tab the site replaced must not take the section down.
    state.pages[0].emit('close');
    const stillReady = await (await fetch(`${base}/api/sessions`)).json();
    assert.equal(stillReady.sessions[0].state, 'ready', 'the replaced page closing does not break the section');
});
