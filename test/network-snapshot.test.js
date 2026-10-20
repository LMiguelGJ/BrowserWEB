'use strict';
// What a section keeps when its exit is replaced: cookies, local and session
// storage and the page it was on. Never persisted, never logged.
const test = require('node:test');
const assert = require('node:assert/strict');
const { captureSnapshot, mergeSnapshots, restoreSnapshot } = require('../src/network/snapshot');

function sectionWith({ url = 'https://example.test/cart', state = { cookies: [{ name: 'a' }], origins: [] },
    storage = { origin: 'https://example.test', items: { step: '2' } } } = {}) {
    const calls = { goto: [], init: [] };
    return {
        calls,
        page: {
            currentUrl: () => url,
            evaluate: async () => storage,
            goto: async (target, options) => { calls.goto.push([target, options.waitUntil]); return {}; }
        },
        context: {
            storageState: async () => state,
            addInitScript: async (fn, arg) => { calls.init.push(arg); }
        }
    };
}

test('a snapshot keeps the url, the browser state and the session storage of the page', async () => {
    const snapshot = await captureSnapshot(sectionWith());
    assert.equal(snapshot.url, 'https://example.test/cart');
    assert.deepEqual(snapshot.storageState.cookies, [{ name: 'a' }]);
    assert.deepEqual(snapshot.sessionStorage, { origin: 'https://example.test', items: { step: '2' } });
    assert.ok(snapshot.capturedAt);
});

test('only a web page is kept as the place to return to', async () => {
    for (const url of ['about:blank', 'chrome://settings', 'file:///etc/passwd', 'javascript:alert(1)', '', null]) {
        assert.equal((await captureSnapshot(sectionWith({ url }))).url, null, String(url));
    }
});

test('a page that does not answer cannot block the capture', async () => {
    const section = sectionWith();
    section.page.evaluate = () => new Promise(() => {});
    section.context.storageState = () => new Promise(() => {});
    const started = Date.now();
    const snapshot = await captureSnapshot(section, { timeoutMs: 30 });
    assert.ok(Date.now() - started < 1000, 'bounded by its own timeout');
    assert.equal(snapshot.url, 'https://example.test/cart', 'what could be read is kept');
    assert.deepEqual([snapshot.storageState, snapshot.sessionStorage], [null, null]);
});

test('a fresh capture only replaces what it could read', async () => {
    const last = { url: 'https://a.test/', storageState: { cookies: [1] }, sessionStorage: { origin: 'https://a.test', items: { k: 'v' } }, capturedAt: 'old' };
    const fresh = { url: 'https://b.test/', storageState: null, sessionStorage: null, capturedAt: 'new' };
    assert.deepEqual(mergeSnapshots(fresh, last), {
        url: 'https://b.test/', storageState: { cookies: [1] }, sessionStorage: last.sessionStorage, capturedAt: 'new'
    });
    assert.equal(mergeSnapshots(null, last), last);
    assert.equal(mergeSnapshots(fresh, null), fresh);
});

test('restoring opens the old page with a plain GET and puts the session storage back first', async () => {
    const section = sectionWith();
    const snapshot = await captureSnapshot(section);
    const target = sectionWith();
    const result = await restoreSnapshot(target, snapshot);
    assert.deepEqual(result, { navigated: true, sessionStorage: true });
    assert.deepEqual(target.calls.goto, [['https://example.test/cart', 'domcontentloaded']]);
    assert.deepEqual(target.calls.init, [{ origin: 'https://example.test', items: { step: '2' } }]);
});

test('a failing restore never throws and nothing is replayed', async () => {
    const target = sectionWith();
    target.page.goto = async () => { throw new Error('net::ERR_PROXY_CONNECTION_FAILED'); };
    const result = await restoreSnapshot(target, { url: 'https://example.test/cart', sessionStorage: null });
    assert.deepEqual(result, { navigated: false, sessionStorage: false });
    assert.deepEqual(await restoreSnapshot(target, null), { navigated: false, sessionStorage: false });
});
