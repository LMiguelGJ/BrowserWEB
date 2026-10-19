'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('ENGINE=camoufox runs sections on the Camoufox engine through the public API', async t => {
    process.env.ENGINE = 'camoufox';
    process.env.PYROCK_CAMOUFOX_MODULE = path.join(__dirname, 'fixtures', 'fake-camoufox.js');
    const fake = require('./fixtures/fake-camoufox');
    const { server, startServer, stopServer } = require('../server');
    t.after(async () => {
        await stopServer();
        delete process.env.ENGINE;
        delete process.env.PYROCK_CAMOUFOX_MODULE;
    });
    await startServer({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    assert.equal(fake.state.launches.length, 1, 'one Camoufox browser process');
    assert.equal(fake.state.launches[0].humanize, true, 'the browser humanizes its own cursor');
    assert.equal(fake.state.launches[0].headless, true);

    const listing = await (await fetch(`${base}/api/sessions`)).json();
    assert.deepEqual(listing.sessions.map(s => s.id), ['s1']);
    assert.equal(fake.state.contexts.length, 1);

    const created = await post('/api/sessions', { name: 'Cuenta' });
    assert.equal(created.status, 201);
    assert.equal(fake.state.contexts.length, 2, 'one isolated context per section');

    const click = await (await post('/api/click', { x: 30, y: 40 })).json();
    assert.equal(click.success, true, JSON.stringify(click));
    const firstPage = fake.state.pages[0];
    assert.deepEqual(firstPage.calls.filter(c => c[0] === 'move'), [], 'PyRock does not stack its own cursor humanizer on Camoufox');
    assert.deepEqual(firstPage.calls.filter(c => c[0] === 'click'), [['click', 30, 40]]);

    const typed = await (await post('/api/type', { text: 'hi' })).json();
    assert.equal(typed.success, true);
    assert.deepEqual(firstPage.calls.filter(c => c[0] === 'type').map(c => c[1]).join(''), 'hi');

    const shot = await (await post('/api/screenshot', {})).json();
    assert.equal(shot.screenshot, `data:image/jpeg;base64,${Buffer.from('shot').toString('base64')}`);

    const nav = await (await post('/api/navigate', { url: 'https://example.test/' })).json();
    assert.equal(nav.success, true);
    assert.ok(firstPage.calls.some(c => c[0] === 'goto' && c[1] === 'https://example.test/'));
});
