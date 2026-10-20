'use strict';

const { createReservations } = require('./reservations');
const { createPoolClient } = require('./proxy-pool');
const { fallbackCandidates } = require('./proxy-fallback');
const { createAssigner } = require('./assigner');
const { normalizeIp, isPublicIp } = require('./ip');

const hostOf = server => { try { return new URL(server).host; } catch { return null; } };
const labelOf = server => { try { const url = new URL(server); return `${url.protocol}//${url.host}`; } catch { return null; } };

// Per-section network state: which exit each section uses, who provides it
// and why. Everything returned by view() is safe to show: no credentials.
function createNetworkManager({ config, probe, env = process.env, fetchImpl, now = Date.now }) {
    const reservations = createReservations();
    const pool = createPoolClient({ baseUrl: config.poolUrl, password: config.poolPassword, fetchImpl });
    let lastPool = { status: 'unknown', reason: null, at: null };
    // How many proxies the pool still has, by type. It is only for showing, so
    // it is read from time to time instead of on every candidate.
    let poolCount = null;
    let countReadAt = 0;
    async function refreshCount() {
        if (now() - countReadAt < 15000) return;
        countReadAt = now();
        const inventory = await pool.count();
        if (inventory) poolCount = inventory;
    }
    const tracked = {
        async pop(options) {
            const answer = await pool.pop(options);
            lastPool = { status: answer.status, reason: answer.reason || null, at: new Date(now()).toISOString() };
            if (answer.status !== 'unavailable') await refreshCount();
            return answer;
        },
        report: (endpoint, ok) => pool.report(endpoint, ok)
    };
    const assigner = createAssigner({
        pool: tracked, reservations, probe, now, freeDeadlineMs: config.freeDeadlineMs,
        fallback: { candidates: sectionId => fallbackCandidates(sectionId, env) }
    });
    const sections = new Map();
    const blank = () => ({
        state: 'waiting', provider: null, ip: null, proxy: null, endpoint: null, reason: null,
        freeReason: null, freeSearch: null, freeRequest: null, since: null, reconnects: 0
    });
    const entry = id => {
        if (!sections.has(id)) sections.set(id, blank());
        return sections.get(id);
    };

    return {
        async assign(sectionId, { isCancelled, recovering = false, manual = false } = {}) {
            const current = entry(sectionId);
            const previousProvider = current.provider;
            const previousState = current.state;
            Object.assign(current, { state: recovering ? 'recovering' : 'validating' });
            const result = await assigner.assign(sectionId, { isCancelled, freeOnly: manual, keepCurrent: manual });
            if (result.provider) {
                Object.assign(current, {
                    state: 'connected', provider: result.provider, ip: result.ip,
                    proxy: labelOf(result.proxy.server),
                    // Only free entries belong to the pool: a paid port is not reported back.
                    endpoint: result.provider === 'free' ? hostOf(result.proxy.server) : null,
                    reason: result.reason || null, freeReason: null, freeSearch: result.freeSearch,
                    since: new Date(now()).toISOString(),
                    // A request from the operator is a decision, not a failed reconnection.
                    reconnects: current.reconnects + (recovering && !manual && previousProvider !== null ? 1 : 0),
                    freeRequest: manual ? { reason: null, at: new Date(now()).toISOString() } : current.freeRequest
                });
            } else if (manual) {
                // A manual request that finds nothing changes nothing: the section keeps
                // the exit it is using, and the panel learns why there was no free one.
                Object.assign(current, {
                    state: previousProvider ? previousState : 'waiting',
                    freeReason: result.freeReason || result.reason || null,
                    freeSearch: result.freeSearch,
                    freeRequest: { reason: result.reason || result.freeReason || 'unknown', at: new Date(now()).toISOString() }
                });
            } else {
                Object.assign(current, {
                    state: 'waiting', provider: null, ip: null, proxy: null, endpoint: null,
                    reason: result.reason, freeReason: result.freeReason || null, freeSearch: result.freeSearch, since: null
                });
            }
            return result;
        },
        async reportLoss(sectionId) {
            const current = sections.get(sectionId);
            if (current?.provider === 'free' && current.endpoint) return pool.report(current.endpoint, false);
            return false;
        },
        // The periodic browser probe can reveal that a tunnel changed exits. Keep
        // the reservation in sync; a collision forces recovery rather than showing
        // two sections as uniquely connected when they are not.
        confirmHealth(sectionId, ip) {
            const current = sections.get(sectionId);
            if (!current || current.state !== 'connected' || !isPublicIp(ip)) return false;
            if (!reservations.reserve(ip, sectionId, { provider: current.provider, endpoint: current.endpoint })) return false;
            current.ip = normalizeIp(ip);
            current.since = new Date(now()).toISOString();
            return true;
        },
        release(sectionId) {
            assigner.release(sectionId);
            const current = sections.get(sectionId);
            if (current) Object.assign(current, { ...blank(), reconnects: current.reconnects });
        },
        forget(sectionId) { assigner.release(sectionId); sections.delete(sectionId); },
        view(sectionId) { return { ...entry(sectionId) }; },
        summary() {
            return {
                mode: 'hybrid', pool: { ...lastPool, count: poolCount }, freeDeadlineMs: config.freeDeadlineMs,
                fallbackConfigured: Boolean(fallbackCandidates('s1', env)),
                reservations: reservations.snapshot().length
            };
        },
        reservations
    };
}

module.exports = { createNetworkManager };
