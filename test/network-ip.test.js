'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { measureExitIp } = require('../src/network-ip');

function probeContext(responses) {
    const calls = [];
    let closed = 0;
    return {
        calls,
        get closed() { return closed; },
        async newPage() {
            return {
                async goto(url) {
                    calls.push(url);
                    const value = responses.shift();
                    if (value instanceof Error) throw value;
                    return { ok: () => true, text: async () => value };
                },
                async close() { closed++; }
            };
        }
    };
}

test('IP navigation rejects invalid bodies, falls back and closes its own tab', async () => {
    const context = probeContext(['not an IP', new Error('unavailable'), '2001:db8::7']);
    assert.equal(await measureExitIp(context, { services: ['https://a/', 'https://b/', 'https://c/'] }), '2001:db8::7');
    assert.deepEqual(context.calls, ['https://a/', 'https://b/', 'https://c/']);
    assert.equal(context.closed, 1);
});

test('a timeout closes the probe even when navigation never resolves', async () => {
    let closed = 0;
    const context = { newPage: async () => ({
        goto: () => new Promise(() => {}),
        close: async () => { closed++; }
    }) };
    await assert.rejects(measureExitIp(context, { timeoutMs: 20 }), /timed out/);
    assert.equal(closed, 1);
});

test('a probe created after the deadline is closed rather than navigated', async () => {
    let resolvePage;
    let closed = 0;
    const context = { newPage: () => new Promise(resolve => { resolvePage = resolve; }) };
    await assert.rejects(measureExitIp(context, { timeoutMs: 20 }), /timed out/);
    resolvePage({ close: async () => { closed++; }, goto: () => assert.fail('late probe must not navigate') });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, 1);
});

test('an internal probe never replaces the preview, even on the same origin', async () => {
    const fixture = require('./fixtures/fake-camoufox');
    const { createCamoufoxEngine } = require('../src/engines/camoufox');
    let adopted = 0;
    const browser = fixture.makeBrowser();
    const engine = createCamoufoxEngine();
    const { context, page: active } = await engine.openPage(browser, { onPopup: async () => { adopted++; } });
    let url = 'about:blank';
    let closed = false;
    context.newPage = async () => {
        const probe = {
            url: () => url,
            isClosed: () => closed,
            goto: async destination => { url = destination; return { ok: () => true, text: async () => '203.0.113.7' }; },
            close: async () => { closed = true; }
        };
        context.emit('page', probe);
        return probe;
    };
    assert.equal(await measureExitIp(context, { services: ['https://example.test/ip'] }), '203.0.113.7');
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(adopted, 0);
    assert.equal(active.currentUrl(), 'https://example.test/');
    assert.equal(closed, true);
    await context.close();
});

test('a timed out measurement aborts its navigation and does not try the next service', async () => {
    const calls = [];
    let closed = 0;
    let aborted = false;
    const context = { newPage: async () => ({
        goto(url, options = {}) {
            calls.push(url);
            return new Promise((_, reject) => {
                const fail = () => { aborted = true; reject(new Error('Navigation aborted')); };
                if (options.signal?.aborted) return fail();
                options.signal?.addEventListener?.('abort', fail, { once: true });
            });
        },
        close: async () => { closed++; }
    }) };
    await assert.rejects(
        measureExitIp(context, { services: ['https://a/', 'https://b/'], timeoutMs: 20, abortGraceMs: 200 }),
        /timed out/
    );
    assert.equal(aborted, true, 'the navigation is aborted instead of left running');
    assert.deepEqual(calls, ['https://a/'], 'the measurement stops at the aborted service');
    assert.equal(closed, 1, 'the probe page is closed');
});

test('a measurement that ignores the abort still releases the caller', async () => {
    let closed = 0;
    const context = { newPage: async () => ({ goto: () => new Promise(() => {}), close: async () => { closed++; } }) };
    const started = Date.now();
    await assert.rejects(measureExitIp(context, { timeoutMs: 20, abortGraceMs: 50 }), /timed out/);
    assert.ok(Date.now() - started < 2000, 'the caller is not held by an unresponsive navigation');
    assert.equal(closed, 1, 'the probe page is closed anyway');
});
