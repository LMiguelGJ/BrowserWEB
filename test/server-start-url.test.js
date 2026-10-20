'use strict';
// A new section opens on the start page instead of about:blank, and the start
// page can be chosen with an environment variable.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startUrl, DEFAULT_START_URL } = require('../src/start-url');

test('the start page is browser.lol unless another http page is chosen', () => {
    assert.equal(startUrl({}), DEFAULT_START_URL);
    assert.equal(startUrl({ PYROCK_START_URL: 'https://example.test/panel' }), 'https://example.test/panel');
    assert.equal(startUrl({ PYROCK_START_URL: '  ' }), DEFAULT_START_URL, 'a blank value is the default');
    assert.equal(startUrl({ PYROCK_START_URL: 'javascript:alert(1)' }), DEFAULT_START_URL, 'only a page can be opened');
    assert.equal(startUrl({ PYROCK_START_URL: 'file:///etc/passwd' }), DEFAULT_START_URL, 'not a local file');
    assert.equal(startUrl({ PYROCK_START_URL: 'not a url' }), DEFAULT_START_URL);
    assert.equal(startUrl({ PYROCK_START_URL: 'off' }), null, '"off" means no start page at all');
    assert.equal(startUrl({ PYROCK_START_URL: 'OFF' }), null);
    assert.equal(DEFAULT_START_URL, 'https://browser.lol/');
});

test('a new section opens on the start page instead of about:blank', async t => {
    const fixture = require('./fixtures/fake-camoufox');
    const originalModule = process.env.PYROCK_CAMOUFOX_MODULE;
    const originalStart = process.env.PYROCK_START_URL;
    process.env.PYROCK_CAMOUFOX_MODULE = path.join(__dirname, 'fixtures', 'fake-camoufox.js');
    delete process.env.PYROCK_START_URL;
    fixture.reset();
    const { server, startServer, stopServer } = require('../src/server');
    t.after(async () => {
        await stopServer();
        for (const [key, value] of [['PYROCK_CAMOUFOX_MODULE', originalModule], ['PYROCK_START_URL', originalStart]]) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    });

    await startServer({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${server.address().port}`;
    const sessions = await (await fetch(`${base}/api/sessions`)).json();
    assert.equal(sessions.sessions.length, 1);
    const state = fixture.currentState();
    const navigations = state.pages.flatMap(page => page.calls.filter(call => call[0] === 'navigate').map(call => call[1]));
    assert.ok(navigations.includes('https://browser.lol/'), 'the section opened on the start page');
    assert.equal(navigations.includes('about:blank'), false, 'the page is not left blank');
});
