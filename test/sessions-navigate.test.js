'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('the navigation answer says whether the page is really visible, and how the preview runs', async () => {
    const path = require('node:path');
    const fixture = require('./fixtures/fake-camoufox');
    const originalModule = process.env.PYROCK_CAMOUFOX_MODULE;
    const originalSettle = process.env.PYROCK_SETTLE_TIMEOUT_MS;
    process.env.PYROCK_CAMOUFOX_MODULE = path.join(__dirname, 'fixtures', 'fake-camoufox.js');
    process.env.PYROCK_SETTLE_TIMEOUT_MS = '0';
    fixture.reset();
    const { server, startServer, stopServer } = require('../server');
    try {
        await startServer({ host: '127.0.0.1', port: 0 });
        const base = `http://127.0.0.1:${server.address().port}`;
        const answer = await (await fetch(`${base}/api/navigate`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.test/' })
        })).json();
        assert.equal(answer.success, true);
        assert.equal(answer.settled, true, 'the page has content, so it is visible');
        assert.equal(answer.diagnosis.readyState, 'complete');
        assert.ok(answer.diagnosis.textLength > 0);
        assert.ok('previewMode' in answer, 'the answer says how the preview runs');

        const listing = await (await fetch(`${base}/api/sessions`)).json();
        assert.ok('previewMode' in listing.sessions[0], 'the section exposes its preview mode');
    } finally {
        await stopServer();
        if (originalModule === undefined) delete process.env.PYROCK_CAMOUFOX_MODULE;
        else process.env.PYROCK_CAMOUFOX_MODULE = originalModule;
        if (originalSettle === undefined) delete process.env.PYROCK_SETTLE_TIMEOUT_MS;
        else process.env.PYROCK_SETTLE_TIMEOUT_MS = originalSettle;
    }
});
