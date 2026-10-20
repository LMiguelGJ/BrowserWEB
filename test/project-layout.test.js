'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('backend modules and examples have dedicated directories', () => {
    for (const file of ['server.js', 'sessions.js', 'screencast.js', 'humanize.js', 'network-ip.js', 'engines/camoufox.js']) {
        assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', file)), `src/${file}`);
    }
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'examples', 'simple_script.txt')));
});

test('the root entry preserves importability and the public web assets', async () => {
    process.env.PYROCK_CAMOUFOX_MODULE = path.join(__dirname, 'fixtures', 'fake-camoufox.js');
    process.env.PYROCK_PROXY = '';
    process.env.PYROCK_PROXY_STICKY_BASE = '';
    const entry = require('../server');
    assert.equal(entry, require('../src/server'));
    assert.equal(entry.server.listening, false, 'importing must not start a browser/server');
    try {
        await entry.startServer({ host: '127.0.0.1', port: 0 });
        const base = `http://127.0.0.1:${entry.server.address().port}`;
        const index = await fetch(base);
        assert.equal(index.status, 200);
        assert.match(await index.text(), /PyRock/);
        for (const file of ['script.js', 'styles.css', 'PyRockHTTP.js']) {
            const response = await fetch(`${base}/${file}`);
            assert.equal(response.status, 200, `${file} stays at its public URL`);
        }
    } finally { await entry.stopServer(); }
});
