/*
 * Humanized input for PyRock — the Camoufox lesson.
 *
 * Camoufox (daijro/camoufox) replaced its own Bezier cursor generator with
 * Cursory (cursory-js, LGPL): a Bezier sampled at a fixed cadence has velocity
 * and jerk profiles that separate cleanly from a human hand. Cursory replays
 * one of 2356 movements recorded from real people, morphed onto the requested
 * endpoints, keeping the recording's own timing — pauses and hesitations
 * included.
 *
 * This module adapts that same generator for Puppeteer's CDP mouse:
 *   - 60Hz sampling (what a page observes from a real cursor on a 60Hz display)
 *   - whole pixels; zero-displacement steps dropped, their time folded forward
 *   - the destination is not a step; the caller lands on it exactly
 *   - timing scaled into [0, 1500ms] without truncating the deceleration
 *   - same seed → same path (reproducible in tests)
 *
 * `typeDelays` gives typing the same treatment: jittered per-keypress delays
 * instead of a constant cadence.
 */

'use strict';

let cursory = null;
let cursoryLoadAttempted = false;

function loadCursory() {
    if (!cursoryLoadAttempted) {
        cursoryLoadAttempted = true;
        try {
            // Optional dependency: the synthetic fallback keeps the feature
            // alive if the package is missing at runtime.
            cursory = require('cursory-js');
        } catch {
            cursory = null;
        }
    }
    return cursory;
}

const FREQUENCY_HZ = 60;
const MAX_MOVE_MS = 1500;
const TYPE_DELAY_MIN_MS = 20;
const TYPE_DELAY_MAX_MS = 180;

function seededRandom(seed) {
    // Small deterministic PRNG (mulberry32) for the fallback walk and typing.
    let a = seed >>> 0;
    return function next() {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Synthetic fallback: multi-segment eased walk with positional noise and
// variable cadence. Not as good as a recorded hand (Camoufox's own reason for
// dropping curves), but strictly better than a teleport.
function fallbackSteps(fromX, fromY, toX, toY, rand) {
    const distance = Math.hypot(toX - fromX, toY - fromY);
    const stepCount = Math.max(4, Math.min(40, Math.round(distance / 15)));
    const steps = [];
    let dispatchedMs = 0;
    for (let i = 1; i <= stepCount; i++) {
        const t = i / stepCount;
        const eased = 1 - Math.pow(1 - t, 3); // ease-out
        const wobble = (rand() - 0.5) * Math.min(12, distance / 12);
        const perp = (rand() - 0.5) * Math.min(10, distance / 15);
        const dx = toX - fromX, dy = toY - fromY;
        const len = distance || 1;
        const x = Math.round(fromX + dx * eased - (dy / len) * wobble * (1 - t));
        const y = Math.round(fromY + dy * eased + (dx / len) * wobble * (1 - t) + perp * (1 - t));
        const delayMs = Math.max(1, Math.round(8 + rand() * 24));
        steps.push({ x, y, delayMs: dispatchedMs === 0 ? 0 : delayMs });
        dispatchedMs += delayMs;
    }
    return { steps, totalMs: Math.max(dispatchedMs, Math.round(distance)) };
}

function generateHumanPath(from, to, { seed, allowFallback = true, engine = 'auto' } = {}) {
    // Las posiciones van como pares [x, y] (el formato de cursory y del CDP).
    const [fromX, fromY] = Array.isArray(from) ? from : [NaN, NaN];
    const [toX, toY] = Array.isArray(to) ? to : [NaN, NaN];
    // An untracked cursor position has no path to walk: the caller moves
    // straight to its destination (Camoufox parks the cursor for the same
    // reason).
    if (!Number.isFinite(fromX) || !Number.isFinite(fromY) ||
        !Number.isFinite(toX) || !Number.isFinite(toY)) {
        return { steps: [], totalMs: 0 };
    }

    seed = seed === undefined ? Math.floor(Math.random() * 0xffffffff) : seed;
    const destinationX = Math.round(toX);
    const destinationY = Math.round(toY);

    const cursoryLib = engine === 'fallback' ? null : loadCursory();
    if (!cursoryLib) {
        if (!allowFallback) return { steps: [], totalMs: 0 };
        return fallbackSteps(Math.round(fromX), Math.round(fromY), destinationX, destinationY, seededRandom(seed));
    }

    const rand = seededRandom(seed);
    const pick = () => Math.floor(rand() * 0xfffffff);
    const firstSeed = typeof seed === 'number' ? seed : pick();

    let { points, timings } = cursoryLib.generateTrajectory(
        [fromX, fromY], [destinationX, destinationY], { frequency: FREQUENCY_HZ, seed: firstSeed });

    // Scale the whole recording's timing into bounds rather than truncating:
    // truncation would drop the deceleration onto the target — the most
    // recognizably human part. Re-run with the adjusted frequency so the
    // sample count lands at 60Hz once scaled (same seed → same recording).
    const recordedMs = timings[timings.length - 1] || 0;
    const scale = recordedMs > 0 ? Math.min(Math.max(recordedMs, 0), MAX_MOVE_MS) / recordedMs : 0;
    if (scale > 0 && scale !== 1) {
        ({ points, timings } = cursoryLib.generateTrajectory(
            [fromX, fromY], [destinationX, destinationY],
            { frequency: Math.max(1, FREQUENCY_HZ * scale), seed: firstSeed }));
    }

    const steps = [];
    let previousX = Math.round(fromX);
    let previousY = Math.round(fromY);
    let dispatchedMs = 0;

    for (let i = 1; i < points.length - 1; i++) {
        const x = Math.round(points[i][0]);
        const y = Math.round(points[i][1]);
        if (x === previousX && y === previousY) continue;
        if (x === destinationX && y === destinationY) continue;
        const elapsedMs = Math.round((timings[i] || 0) * scale);
        steps.push({ x, y, delayMs: Math.max(0, elapsedMs - dispatchedMs) });
        dispatchedMs = elapsedMs;
        previousX = x;
        previousY = y;
    }

    const totalMs = Math.round(recordedMs * scale);
    return { steps, totalMs: totalMs || Math.max(0, dispatchedMs) };
}

function typeDelays(text, { humanize = true, seed } = {}) {
    if (!humanize) {
        return Array.from(text, () => 0);
    }
    const rand = seededRandom(seed === undefined ? Math.floor(Math.random() * 0xffffffff) : seed);
    return Array.from(text, () => Math.round(TYPE_DELAY_MIN_MS + rand() * (TYPE_DELAY_MAX_MS - TYPE_DELAY_MIN_MS)));
}

module.exports = { generateHumanPath, typeDelays, MAX_MOVE_MS, TYPE_DELAY_MIN_MS, TYPE_DELAY_MAX_MS };
