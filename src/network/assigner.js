'use strict';

const { isPublicIp, normalizeIp } = require('./ip');

const MAX_EXAMINED = 200;

// A slot is handed to the next waiter instead of released, so the limit holds
// even when a waiter wakes up while another run is starting.
function createLimiter(max) {
    let active = 0;
    const queue = [];
    return async function run(task) {
        if (active >= max) await new Promise(resolve => queue.push(resolve));
        else active++;
        try { return await task(); }
        finally {
            const next = queue.shift();
            if (next) next(); else active--;
        }
    };
}

// Gets an exit for one section: free proxies from the pool first, DataImpulse
// only when that search ends without a usable and distinct exit. It never
// returns a direct connection: with nothing usable the section waits.
function createAssigner({
    pool, fallback, reservations, probe,
    now = Date.now, freeDeadlineMs = 60000, fallbackDeadlineMs = 30000,
    probeTimeoutMs = 8000, poolTimeoutMs = 5000, maxConcurrentProbes = 2
}) {
    const limit = createLimiter(maxConcurrentProbes);

    async function measure(proxy, timeoutMs) {
        return limit(async () => {
            const ip = await probe(proxy, { timeoutMs });
            return typeof ip === 'string' ? ip.trim() : '';
        });
    }

    async function searchFree(sectionId, isCancelled, summary) {
        const deadline = now() + freeDeadlineMs;
        while (summary.examined < MAX_EXAMINED) {
            if (isCancelled()) return { cancelled: true };
            const remaining = deadline - now();
            if (remaining <= 0) return { reason: 'deadline_exceeded' };
            const popped = await pool.pop({ timeoutMs: Math.min(poolTimeoutMs, remaining) });
            if (popped.status === 'unavailable') return { reason: 'pool_unavailable' };
            if (popped.status === 'empty') return { reason: summary.examined ? 'candidates_exhausted' : 'pool_empty' };
            summary.examined++;
            if (popped.status === 'invalid') {
                if (popped.endpoint) await pool.report(popped.endpoint, false);
                continue;
            }
            const server = popped.proxy.server;
            let ip;
            try { ip = await measure({ server }, Math.min(probeTimeoutMs, Math.max(1, deadline - now()))); }
            catch { await pool.report(popped.proxy.endpoint, false); continue; }
            if (isCancelled()) return { cancelled: true };
            if (!isPublicIp(ip)) { await pool.report(popped.proxy.endpoint, false); continue; }
            // A working proxy that duplicates another section's exit is not broken: it is just not usable here.
            if (!reservations.reserve(ip, sectionId, { provider: 'free', endpoint: popped.proxy.endpoint })) continue;
            return { provider: 'free', proxy: { server }, ip: normalizeIp(ip) };
        }
        return { reason: 'deadline_exceeded' };
    }

    async function useFallback(sectionId, isCancelled) {
        const candidates = fallback.candidates(sectionId);
        if (!candidates || !candidates.length) return { reason: 'fallback_unavailable' };
        const deadline = now() + fallbackDeadlineMs;
        for (const candidate of candidates) {
            if (isCancelled()) return { cancelled: true };
            const remaining = deadline - now();
            if (remaining <= 0) break;
            let ip;
            try { ip = await measure(candidate, Math.min(probeTimeoutMs, remaining)); }
            catch { continue; }
            if (isCancelled()) return { cancelled: true };
            if (!isPublicIp(ip)) continue;
            if (!reservations.reserve(ip, sectionId, { provider: 'dataimpulse', endpoint: candidate.server })) continue;
            return { provider: 'dataimpulse', proxy: candidate, ip: normalizeIp(ip) };
        }
        return { reason: 'fallback_failed' };
    }

    return {
        async assign(sectionId, { isCancelled = () => false, freeOnly = false, keepCurrent = false } = {}) {
            const startedAt = now();
            // A section holds one exit: asking for a new one frees the previous.
            // A request that must keep the current exit (the operator asked for
            // another one) holds it until a new one is actually secured.
            if (!keepCurrent) reservations.release(sectionId);
            const summary = { examined: 0 };
            const free = await searchFree(sectionId, isCancelled, summary);
            const done = result => ({ ...result, freeSearch: { ...summary, reason: free.reason || null, durationMs: now() - startedAt } });
            if (free.cancelled) { if (!keepCurrent) reservations.release(sectionId); return done({ provider: null, reason: 'cancelled' }); }
            if (free.provider) return done({ ...free, reason: null });
            // A request for a free exit stops here: it never reaches the paid one.
            if (freeOnly) return done({ provider: null, reason: free.reason, freeReason: free.reason });
            const paid = await useFallback(sectionId, isCancelled);
            if (paid.cancelled) { if (!keepCurrent) reservations.release(sectionId); return done({ provider: null, reason: 'cancelled' }); }
            if (paid.provider) return done({ ...paid, reason: free.reason });
            return done({ provider: null, reason: paid.reason, freeReason: free.reason });
        },
        release(sectionId) { return reservations.release(sectionId); }
    };
}

module.exports = { createAssigner, createLimiter };
