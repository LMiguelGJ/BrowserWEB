'use strict';

const { normalizeIp } = require('./ip');

// Which section holds which exit. An exit is never shared between sections,
// whatever the provider: a free proxy and a DataImpulse port that resolve to
// the same address would still be one connection.
function createReservations() {
    const byIp = new Map();
    const byOwner = new Map();

    function release(owner) {
        const ip = byOwner.get(owner);
        if (ip === undefined) return false;
        byOwner.delete(owner);
        byIp.delete(ip);
        return true;
    }

    return {
        reserve(ip, owner, meta = {}) {
            const key = normalizeIp(ip);
            if (!key) return false;
            const holder = byIp.get(key);
            if (holder && holder.owner !== owner) return false;
            // An owner holds one exit at a time: taking a new one frees the old.
            if (byOwner.get(owner) !== key) release(owner);
            byIp.set(key, { owner, ...meta, at: new Date().toISOString() });
            byOwner.set(owner, key);
            return true;
        },
        release,
        holder(ip) { return byIp.get(normalizeIp(ip))?.owner ?? null; },
        exitOf(owner) { return byOwner.get(owner) ?? null; },
        snapshot() { return [...byIp].map(([ip, value]) => ({ ip, ...value })); }
    };
}

module.exports = { createReservations };
