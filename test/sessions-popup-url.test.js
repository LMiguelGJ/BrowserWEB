'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('after following a tab, the section reports where it really is', async () => {
    const path = require('node:path');
    const fixture = require('./fixtures/fake-camoufox');
    const originalModule = process.env.PYROCK_CAMOUFOX_MODULE;
    process.env.PYROCK_CAMOUFOX_MODULE = path.join(__dirname, 'fixtures', 'fake-camoufox.js');
    const state = fixture.reset();
    const { server, startServer, stopServer } = require('../server');
    try {
        await startServer({ host: '127.0.0.1', port: 0 });
        const base = `http://127.0.0.1:${server.address().port}`;
        await state.contexts[0].openPopup('session-tab', 'https://example.test/session');
        await new Promise(resolve => setImmediate(resolve));
        const listing = await (await fetch(`${base}/api/sessions`)).json();
        assert.equal(listing.sessions[0].url, 'https://example.test/session', 'the section reports the tab it is on');
    } finally {
        await stopServer();
        if (originalModule === undefined) delete process.env.PYROCK_CAMOUFOX_MODULE;
        else process.env.PYROCK_CAMOUFOX_MODULE = originalModule;
    }
});
