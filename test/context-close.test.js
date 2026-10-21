'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createContextCloser } = require('../src/network/close-context');

test('a probe context that fails to close is retried once and the failure is recorded', async () => {
    const attempts = [];
    const warnings = [];
    const closer = createContextCloser({
        close: async context => { attempts.push(context); throw new Error('EACCES: context busy'); },
        logger: { info() {}, warn: message => warnings.push(message) }
    });
    const outcome = await closer.closeOnce('probe-1', 'sondeo');
    assert.deepEqual(attempts, ['probe-1', 'probe-1'], 'the close is attempted twice');
    assert.equal(outcome.closed, false);
    const failures = closer.failures();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].owner, 'sondeo');
    assert.match(failures[0].message, /EACCES/);
    assert.ok(warnings.some(line => /sondeo/.test(line)), 'the failure is logged, not swallowed');
});

test('a context the browser already closed is released without a recorded failure', async () => {
    const warnings = [];
    const closer = createContextCloser({
        close: async () => { throw new Error('Target page, context or browser has been closed'); },
        logger: { info() {}, warn: message => warnings.push(message) }
    });
    const outcome = await closer.closeOnce('probe-2', 'sondeo');
    assert.equal(outcome.closed, true);
    assert.equal(outcome.alreadyClosed, true);
    assert.deepEqual(closer.failures(), []);
    assert.deepEqual(warnings, []);
});

test('the recorded failures are bounded and the latest is kept', async () => {
    const closer = createContextCloser({ close: async () => { throw new Error('EACCES: busy'); }, maxFailures: 3 });
    for (let index = 0; index < 6; index++) await closer.closeOnce(`probe-${index}`, `sondeo ${index}`);
    const failures = closer.failures();
    assert.equal(failures.length, 3, 'the registry never grows without a bound');
    assert.deepEqual(failures.map(entry => entry.owner), ['sondeo 3', 'sondeo 4', 'sondeo 5'], 'the newest failures are the ones kept');
});
