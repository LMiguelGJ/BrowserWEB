'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const waitFor = async (predicate, message, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(message);
};

test('isolated sections keep cookies, actions and preview frames separate across restart and browser recovery', { timeout: 180_000 }, async t => {
    const path = require('node:path');
    const originalModule = process.env.PYROCK_CAMOUFOX_MODULE;
    // A real browser, launched through the same camoufox-js contract the server uses.
    // The Camoufox binary itself is not needed here: the engine path (Playwright
    // adapter, screencast bridge, context isolation, crash recovery) is what is tested.
    process.env.PYROCK_CAMOUFOX_MODULE = path.join(__dirname, 'fixtures', 'playwright-chromium-camoufox.js');
    const sockets = new Set();
    const observedCookies = new Map();
    const observedActions = [];

    const { app, server, startServer, stopServer } = require('../server');
    app.get('/__sessions/cookie/:value', (req, res) => {
        res.setHeader('Set-Cookie', `marker=${encodeURIComponent(req.params.value)}; Path=/`);
        res.type('html').send(`<!doctype html><html><body style="margin:0;background:${req.query.color}">
            <h1>${req.query.name}</h1><button id="action" style="position:absolute;left:20px;top:20px;width:120px;height:40px">Action</button>
            <input id="entry" autofocus style="position:absolute;left:20px;top:80px">
            <span id="counter">0</span><script>
            let count=0; setInterval(()=>document.querySelector('#counter').textContent=String(++count),150);
            fetch('/__sessions/cookie-observed?section='+encodeURIComponent(${JSON.stringify(req.query.name)})+'&cookies='+encodeURIComponent(document.cookie));
            document.querySelector('#action').addEventListener('click',()=>fetch('/__sessions/action?section='+encodeURIComponent(${JSON.stringify(req.query.name)})+'&kind=click'));
            document.querySelector('#entry').addEventListener('input',e=>fetch('/__sessions/action?section='+encodeURIComponent(${JSON.stringify(req.query.name)})+'&kind=type&value='+encodeURIComponent(e.target.value)));
            document.querySelector('#entry').addEventListener('keydown',e=>fetch('/__sessions/action?section='+encodeURIComponent(${JSON.stringify(req.query.name)})+'&kind=key&value='+encodeURIComponent(e.key)));
            </script></body></html>`);
    });
    app.get('/__sessions/cookie-observed', (req, res) => {
        observedCookies.set(req.query.section, req.query.cookies || '');
        res.sendStatus(204);
    });
    app.get('/__sessions/action', (req, res) => {
        observedActions.push({ section: req.query.section, kind: req.query.kind, value: req.query.value });
        res.sendStatus(204);
    });

    t.after(async () => {
        // Each cleanup step is isolated: one failure must not skip the rest, or the
        // browser process stays alive and the test never exits.
        for (const socket of sockets) { try { socket.terminate(); } catch { /* already closed */ } }
        try { await stopServer(); } catch { /* already stopped */ }
        try { await require('./fixtures/playwright-chromium-camoufox').stop(); } catch { /* already gone */ }
        if (originalModule === undefined) delete process.env.PYROCK_CAMOUFOX_MODULE;
        else process.env.PYROCK_CAMOUFOX_MODULE = originalModule;
    });

    await startServer({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (path, body) => {
        const response = await fetch(`${base}/api/${path}`, body === undefined ? {} : {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
        });
        const result = await response.json();
        assert.equal(response.ok, true, `${path}: ${JSON.stringify(result)}`);
        assert.equal(result.success, true, `${path}: ${JSON.stringify(result)}`);
        return result;
    };
    const navigate = (url, session) => request('navigate', { url, session });
    const observe = session => {
        const url = base.replace('http:', 'ws:') + `/ws/preview?session=${encodeURIComponent(session)}`;
        const socket = new (require('ws'))(url, { origin: base });
        sockets.add(socket);
        const frames = [];
        socket.on('message', raw => {
            const message = JSON.parse(raw.toString());
            if (message.type === 'frame') {
                frames.push(message);
                if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'ack', id: message.id }));
            }
        });
        return { socket, frames };
    };
    const first = 's1';
    const initial = await request('sessions');
    assert.deepEqual(initial.sessions.map(session => session.id), [first]);
    const createdResponse = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(createdResponse.status, 201);
    const second = (await createdResponse.json()).session.id;
    assert.equal(second, 's2');

    await navigate(`${base}/__sessions/cookie/alpha?name=alpha&color=%23ff4020`, first);
    await navigate(`${base}/__sessions/cookie/beta?name=beta&color=%232040ff`, second);
    await waitFor(() => observedCookies.has('alpha') && observedCookies.has('beta'), 'browser pages did not report their cookies');
    assert.match(observedCookies.get('alpha'), /marker=alpha/);
    assert.match(observedCookies.get('beta'), /marker=beta/);
    assert.doesNotMatch(observedCookies.get('alpha'), /marker=beta/);
    assert.doesNotMatch(observedCookies.get('beta'), /marker=alpha/);

    const alphaStream = observe(first);
    const betaStream = observe(second);
    await waitFor(() => alphaStream.frames.length > 0, 'first section preview did not emit a frame');
    await waitFor(() => betaStream.frames.length > 0, 'second section preview did not emit a frame');
    assert.notEqual(alphaStream.frames[0].data, betaStream.frames[0].data, 'each viewer receives its section page, not the other section frame');

    await request('click', { session: first, x: 60, y: 40 });
    await request('click', { session: second, x: 60, y: 40 });
    await request('click', { session: second, x: 60, y: 100 });
    await request('type', { session: second, text: 'typed-in-beta' });
    await request('key', { session: second, key: 'Enter' });
    await waitFor(() => observedActions.some(action => action.section === 'alpha' && action.kind === 'click') &&
        observedActions.some(action => action.section === 'beta' && action.kind === 'click') &&
        observedActions.some(action => action.section === 'beta' && action.kind === 'type' && action.value === 'typed-in-beta') &&
        observedActions.some(action => action.section === 'beta' && action.kind === 'key' && action.value === 'Enter'),
    `actions did not reach their addressed section: ${JSON.stringify(observedActions)}`);
    assert.equal(observedActions.some(action => action.section === 'alpha' && action.kind !== 'click'), false,
        'typing and keyboard actions addressed to beta must not affect alpha');

    const alphaLastId = alphaStream.frames.at(-1).id;
    const betaLastId = betaStream.frames.at(-1).id;
    await request('init', { session: first });
    const listingAfterRestart = (await request('sessions')).sessions;
    assert.deepEqual(listingAfterRestart.map(session => session.id), [first, second]);
    await waitFor(() => alphaStream.frames.some(frame => frame.id > alphaLastId), 'restarted first section preview did not resume');
    await waitFor(() => betaStream.frames.some(frame => frame.id > betaLastId), 'second section preview stopped during first-section restart');
    assert.equal(betaStream.socket.readyState, 1, 'restarting alpha must keep beta viewer connected');

    alphaStream.socket.close(); betaStream.socket.close();
    // The browser going away fires the same 'disconnected' event a crash fires,
    // which is the path the server has to survive.
    await waitFor(() => globalThis.__pyrockPlaywrightBrowser, 'server browser unavailable');
    await globalThis.__pyrockPlaywrightBrowser.close();
    await waitFor(async () => (await (await fetch(`${base}/api/sessions`)).json()).sessions.every(session => session.state === 'unavailable'),
        'sections were not marked unavailable after browser process exit');
    await request('init', {});
    const recovered = (await request('sessions')).sessions;
    assert.deepEqual(recovered.map(session => ({ id: session.id, name: session.name })), [
        { id: first, name: 'Sección 1' }, { id: second, name: 'Sección 2' }
    ]);
});
