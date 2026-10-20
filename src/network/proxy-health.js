'use strict';

const TUNNEL_FAILURES = [
    'ERR_PROXY_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED',
    'NS_ERROR_PROXY_CONNECTION_REFUSED', 'NS_ERROR_PROXY_CONNECTION_FAILED',
    'NS_ERROR_NET_RESET'
];

function isProxyTransportFailure(value) {
    const message = typeof value === 'string' ? value : value?.message || value?.errorText || '';
    return TUNNEL_FAILURES.some(code => message.includes(code));
}

function createProxyHealth({
    sections, check, recover, onHealthy = () => {}, intervalMs = 120000,
    jitterMs = 15000, random = Math.random,
    setTimeout: schedule = setTimeout, clearTimeout: cancel = clearTimeout
}) {
    if (typeof sections !== 'function' || typeof check !== 'function' || typeof recover !== 'function') {
        throw new TypeError('sections, check and recover are required');
    }
    const failures = new Map();
    const checking = new Map();
    const recovering = new Set();
    let timer = null;
    let started = false;

    async function triggerRecovery(id) {
        if (recovering.has(id)) return false;
        recovering.add(id);
        failures.set(id, 0);
        try { return await recover(id); }
        finally { recovering.delete(id); }
    }

    async function checkNow(id) {
        if (recovering.has(id)) return { status: 'recovering' };
        if (checking.has(id)) return checking.get(id);
        const section = sections().find(item => item.id === id);
        if (!section || section.state !== 'connected') return { status: 'skipped' };
        const job = (async () => {
            let ip = null;
            try { ip = await check(id, section); } catch { ip = null; }
            if (typeof ip === 'string' && ip.trim()) {
                failures.set(id, 0);
                await onHealthy(id, ip.trim(), section);
                return { status: 'healthy', ip: ip.trim() };
            }
            const count = (failures.get(id) || 0) + 1;
            failures.set(id, count);
            if (count >= 2) {
                const recovered = await triggerRecovery(id);
                return { status: 'lost', failures: count, recovered };
            }
            return { status: 'failed', failures: count };
        })();
        checking.set(id, job);
        try { return await job; }
        finally { if (checking.get(id) === job) checking.delete(id); }
    }

    function scheduleNext() {
        if (!started) return;
        const offset = Math.round((random() * 2 - 1) * jitterMs);
        timer = schedule(async () => {
            timer = null;
            if (!started) return;
            const live = sections().filter(item => item.state === 'connected');
            // Stagger section probes across the sweep instead of probing them all
            // in the same instant. checkNow deduplicates explicit and scheduled work.
            for (const section of live) {
                if (!started) break;
                await checkNow(section.id);
            }
            scheduleNext();
        }, Math.max(1, intervalMs + offset));
        timer?.unref?.();
    }

    return {
        start() { if (started) return; started = true; scheduleNext(); },
        stop() { started = false; if (timer !== null) cancel(timer); timer = null; },
        checkNow,
        async checkAll() {
            const live = sections().filter(item => item.state === 'connected');
            return Promise.all(live.map(section => checkNow(section.id)));
        },
        notifyFailure(id, error) {
            if (!isProxyTransportFailure(error)) return false;
            triggerRecovery(id).catch(() => {});
            return true;
        },
        state(id) { return { failures: failures.get(id) || 0, checking: checking.has(id), recovering: recovering.has(id) }; }
    };
}

module.exports = { createProxyHealth, isProxyTransportFailure };
