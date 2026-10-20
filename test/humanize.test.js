const test = require('node:test');
const assert = require('node:assert');

const { generateHumanPath, typeDelays } = require('../src/humanize');

test('generateHumanPath walks intermediate points with real timing before the destination', () => {
    const { steps, totalMs } = generateHumanPath([100, 100], [600, 400], { seed: 12345 });
    assert.ok(steps.length >= 5, 'multiple intermediate moves, not a teleport');
    assert.ok(totalMs > 0 && totalMs <= 1600, `total timing is bounded, got ${totalMs}ms`);
    let x = 100, y = 100;
    for (const step of steps) {
        assert.ok(step.delayMs >= 0, 'each step carries a non-negative delay');
        assert.ok(Number.isFinite(step.x) && Number.isFinite(step.y), 'coordinates are finite');
        assert.ok(Math.hypot(step.x - x, step.y - y) > 0, 'cursor actually moves between steps');
        x = step.x; y = step.y;
    }
    // The destination is not a step: the caller dispatches it, so the last step may sit short of it,
    // and that gap carries its own recorded delay (see the trailing-delay test).
    const cadences = new Set(steps.map(s => s.delayMs));
    assert.ok(cadences.size > 2, 'timing is not a fixed cadence');
});

test('the walk plus the trailing delay add up to the movement duration, so the caller never double-waits', () => {
    for (let seed = 1; seed <= 200; seed++) {
        const { steps, trailingDelayMs, totalMs } = generateHumanPath([100, 100], [600, 400], { seed });
        const walked = steps.reduce((sum, step) => sum + step.delayMs, 0);
        assert.ok(trailingDelayMs >= 0, `seed ${seed}: trailing delay is non-negative`);
        assert.ok(trailingDelayMs <= totalMs, `seed ${seed}: trailing delay never exceeds the whole movement`);
        assert.ok(Math.abs(walked + trailingDelayMs - totalMs) <= 2, `seed ${seed}: walked ${walked} + trailing ${trailingDelayMs} should equal total ${totalMs}`);
        assert.ok(totalMs <= 1600, `seed ${seed}: total ${totalMs}ms stays within the 1.5s cap`);
    }
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
    const { generateHumanPath: fallbackPath } = require('../src/humanize');
    const { steps, totalMs } = fallbackPath([0, 0], [150, 150], { seed: 1, engine: 'fallback' });
    assert.ok(steps.length >= 3, 'fallback still walks, not teleports');
    assert.ok(totalMs > 0);
});
