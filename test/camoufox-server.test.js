'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('sections run on the Camoufox engine through the public API', async t => {
    const originalModule = process.env.PYROCK_CAMOUFOX_MODULE;
    const originalConfig = globalThis.__pyrockCamoufoxConfig;
    process.env.PYROCK_CAMOUFOX_MODULE = path.join(__dirname, 'fixtures', 'fake-camoufox.js');
    globalThis.__pyrockCamoufoxConfig = undefined;
    const fake = require('./fixtures/fake-camoufox');
    const state = fake.reset();
    const { server, startServer, stopServer } = require('../server');
    t.after(async () => {
        await stopServer();
        globalThis.__pyrockCamoufoxConfig = originalConfig;
        if (originalModule === undefined) delete process.env.PYROCK_CAMOUFOX_MODULE;
        else process.env.PYROCK_CAMOUFOX_MODULE = originalModule;
    });
    await startServer({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    assert.equal(state.launches.length, 1, 'one Camoufox browser process');
    assert.equal(state.launches[0].headless, true);
    assert.equal(state.launches[0].humanize, false, 'Camoufox humanization is launch-time only; PyRock humanizes per request');
    assert.ok(state.launches[0].os, 'the fingerprint picks an operating system');
    assert.ok(state.launches[0].locale, 'the fingerprint sets a locale');

    const listing = await (await fetch(`${base}/api/sessions`)).json();
    assert.deepEqual(listing.sessions.map(s => s.id), ['s1']);
    assert.equal(state.contexts.length, 1);

    const created = await post('/api/sessions', { name: 'Cuenta' });
    assert.equal(created.status, 201);
    assert.equal(state.contexts.length, 2, 'one isolated context per section');

    const click = await (await post('/api/click', { x: 30, y: 40 })).json();
    assert.equal(click.success, true, JSON.stringify(click));
    const firstPage = state.pages[0];
    assert.deepEqual(firstPage.calls.filter(c => c[0] === 'click'), [['click', 30, 40]]);
    assert.ok(firstPage.calls.some(c => c[0] === 'move'), 'PyRock walks the cursor to the target before clicking');
    assert.ok(firstPage.calls.findIndex(c => c[0] === 'move') < firstPage.calls.findIndex(c => c[0] === 'click'), 'the click lands after the walk');

    const instant = await (await post('/api/click', { x: 50, y: 60, humanize: false })).json();
    assert.equal(instant.success, true);
    const secondPage = state.pages[1];
    assert.deepEqual(secondPage.calls.filter(c => c[0] === 'move'), [], 'humanize:false clicks without walking');

    const typed = await (await post('/api/type', { text: 'hi' })).json();
    assert.equal(typed.success, true);
    assert.deepEqual(firstPage.calls.filter(c => c[0] === 'type').map(c => c[1]).join(''), 'hi');

    const shot = await (await post('/api/screenshot', {})).json();
    assert.equal(shot.screenshot, `data:image/jpeg;base64,${Buffer.from('shot').toString('base64')}`);

    const nav = await (await post('/api/navigate', { url: 'https://example.test/' })).json();
    assert.equal(nav.success, true);
    assert.ok(firstPage.calls.some(c => c[0] === 'navigate' && c[1] === 'https://example.test/'));
});
