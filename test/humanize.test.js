const test = require('node:test');
const assert = require('node:assert');

const { generateHumanPath, typeDelays } = require('../humanize');

test('generateHumanPath walks intermediate points with real timing before the destination', () => {
    const { steps, totalMs } = generateHumanPath([100, 100], [600, 400]);
    assert.ok(steps.length >= 5, 'multiple intermediate moves, not a teleport');
    assert.ok(totalMs > 0 && totalMs <= 1600, `total timing is bounded, got ${totalMs}ms`);
    let x = 100, y = 100;
    for (const step of steps) {
        assert.ok(step.delayMs >= 0, 'each step carries a non-negative delay');
        assert.ok(Math.hypot(step.x - x, step.y - y) > 0, 'cursor actually moves between steps');
        x = step.x; y = step.y;
    }
    const last = steps[steps.length - 1];
    assert.ok(Math.hypot(last.x - 600, last.y - 400) < 3, 'path ends at the destination');
    // No two consecutive steps land at constant cadence: a real hand hesitates.
    const cadences = new Set(steps.map(s => s.delayMs));
    assert.ok(cadences.size > 2, 'timing is not a fixed cadence');
});

test('generateHumanPath is seeded: same seed, same path', () => {
    const a = generateHumanPath([0, 0], [300, 200], { seed: 42 });
    const b = generateHumanPath([0, 0], [300, 200], { seed: 42 });
    assert.deepEqual(a, b);
});

test('generateHumanPath works from an unknown cursor position (no start point)', () => {
    const { steps } = generateHumanPath(null, [300, 200]);
    assert.equal(steps.length, 0, 'no path from an untracked position');
});

test('typeDelays returns jittered per-key delays when humanizing, zeros when off', () => {
    const text = 'hola mundo 123';
    const on = typeDelays(text, { humanize: true, seed: 7 });
    assert.equal(on.length, text.length);
    assert.ok(on.every(d => d >= 20 && d <= 180), 'each keystroke delay is humanly bounded');
    assert.ok(new Set(on).size > 3, 'delays jitter, not a fixed cadence');
    const off = typeDelays(text, { humanize: false });
    assert.deepEqual(off, Array.from(text, () => 0), 'humanize:false keeps instant typing');
});

test('generateHumanPath falls back to a synthetic walk if cursory is unavailable', () => {
    const { generateHumanPath: fallbackPath } = require('../humanize');
    const { steps, totalMs } = fallbackPath([0, 0], [150, 150], { seed: 1, engine: 'fallback' });
    assert.ok(steps.length >= 3, 'fallback still walks, not teleports');
    assert.ok(totalMs > 0);
});
