'use strict';
// Regresión del panel "Red" con proxy rotativa (sin puerto sticky).
// Esa rama —la que usa la proxy compartida— nunca se ejercitaba en los tests
// y llegó a producción con una función sin exportar: el panel respondía 500.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('the panel answers with a rotating proxy and no sticky port', async () => {
    const fixture = require('./fixtures/fake-camoufox');
    const originalModule = process.env.PYROCK_CAMOUFOX_MODULE;
    const originalProxy = process.env.PYROCK_PROXY;
    const originalBase = process.env.PYROCK_PROXY_STICKY_BASE;
    process.env.PYROCK_CAMOUFOX_MODULE = path.join(__dirname, 'fixtures', 'fake-camoufox.js');
    process.env.PYROCK_PROXY = 'http://user:secret@gw.example:823';
    // Cadena vacía y no "delete": dotenv no sobreescribe una variable ya
    // presente, y el .env local traería un puerto sticky.
    process.env.PYROCK_PROXY_STICKY_BASE = '';
    fixture.reset();
    const { server, startServer, stopServer } = require('../server');
    try {
        await startServer({ host: '127.0.0.1', port: 0 });
        const base = `http://127.0.0.1:${server.address().port}`;

        const response = await fetch(`${base}/api/network`);
        assert.equal(response.status, 200, 'the panel must not answer a 500 with a rotating proxy');
        const body = await response.json();
        assert.equal(body.mode, 'rotating');
        assert.equal(body.stickyBase, null);
        assert.ok(body.sections.length >= 1);
        assert.match(body.sections[0].proxy, /:823$/, 'every section goes out through the shared proxy');
        assert.equal(body.sections[0].port, 823, 'and the panel says which port that is');
    } finally {
        await stopServer();
        for (const [key, value] of [['PYROCK_CAMOUFOX_MODULE', originalModule], ['PYROCK_PROXY', originalProxy], ['PYROCK_PROXY_STICKY_BASE', originalBase]]) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
