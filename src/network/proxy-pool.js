'use strict';

const { isIP } = require('node:net');
const { isPublicIp } = require('./ip');

// Client of the proxy-scraper pool API. The pool is asked for HTTP first and
// for SOCKS afterwards: the proven path keeps priority and the rest of the
// inventory is extra supply. Every request keeps `https=1`, because without a
// verified TLS tunnel the browser cannot open an https site at all.
const POP_PATHS = [
    '/pop?protocol=http&https=1',
    '/pop?protocol=socks5&https=1',
    '/pop?protocol=socks4&https=1'
];
const SCHEMES = new Set(['http:', 'socks5:', 'socks4:']);

function parseCandidate(body) {
    let url;
    try { url = new URL(body?.url); } catch { return { status: 'invalid', reason: 'malformed' }; }
    const endpoint = typeof body?.proxy === 'string' ? body.proxy : `${url.hostname}:${url.port}`;
    const reject = reason => ({ status: 'invalid', reason, endpoint });
    if (!SCHEMES.has(url.protocol)) return reject('unsupported_scheme');
    // The label has to agree with the URL: the browser gets the scheme.
    if (body.type && body.type !== url.protocol.replace(':', '')) return reject('type_mismatch');
    if (url.username || url.password) return reject('credentials');
    const port = Number(url.port);
    if (!isIP(url.hostname) || !Number.isInteger(port) || port < 1 || port > 65535) return reject('malformed');
    if (!isPublicIp(url.hostname)) return reject('not_public');
    return { status: 'ok', proxy: { endpoint, server: `${url.protocol}//${url.host}` } };
}

function createPoolClient({ baseUrl, password = '', fetchImpl = fetch, timeoutMs = 5000 }) {
    const authorization = `Basic ${Buffer.from(`any:${password}`).toString('base64')}`;

    async function request(path, timeout) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            return await fetchImpl(`${baseUrl}${path}`, {
                headers: { authorization }, signal: controller.signal, redirect: 'error'
            });
        } finally { clearTimeout(timer); }
    }

    return {
        async pop({ timeoutMs: limit = timeoutMs } = {}) {
            const started = Date.now();
            for (const path of POP_PATHS) {
                // The whole call shares one budget: the phases must not push the
                // search past the deadline of the section that asked.
                const left = limit - (Date.now() - started);
                if (left <= 0) return { status: 'empty' };
                let response;
                try { response = await request(path, left); }
                catch { return { status: 'unavailable', reason: 'unreachable' }; }
                if (response.status === 401) return { status: 'unavailable', reason: 'unauthorized' };
                // This phase is empty; the next protocol may still have one.
                if (response.status === 404) continue;
                if (!response.ok) return { status: 'unavailable', reason: `http_${response.status}` };
                let body;
                try { body = await response.json(); } catch { return { status: 'invalid', reason: 'malformed' }; }
                if (body?.code === 0 && !body?.url) continue;
                return parseCandidate(body);
            }
            return { status: 'empty' };
        },
        // How many proxies the pool still has, by type. Only for showing, and
        // only with a number that cannot be mistaken: the pool answers
        // differently depending on the version, so a total is taken only from an
        // explicit field or from a flat list of numbers. A wrong number is
        // worse than none.
        async count() {
            for (const path of ['/count', '/__proxy-scraper/status']) {
                let body;
                try {
                    const response = await request(path, timeoutMs);
                    if (!response.ok) continue;
                    body = await response.json();
                } catch { continue; }
                if (!body || typeof body !== 'object') continue;
                const numbers = {};
                for (const [key, value] of Object.entries(body)) {
                    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
                }
                const totalKey = ['total', 'count', 'size', 'available'].find(key => numbers[key] !== undefined);
                const byType = {};
                for (const [key, value] of Object.entries(numbers)) {
                    if (key === totalKey) continue;
                    byType[key] = value;
                }
                let total = totalKey ? numbers[totalKey] : Object.values(byType).reduce((sum, value) => sum + value, 0);
                // The status page groups the totals (the pool, the proxies by
                // type): only the groups that can hold the inventory are read,
                // so a counter of requests is never shown as a number of exits.
                if (!totalKey) {
                    for (const key of ['pool', 'proxies', 'byType', 'available', 'total']) {
                        const group = body[key];
                        if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
                        const inside = Object.entries(group).filter(([, item]) => typeof item === 'number' && Number.isFinite(item));
                        if (!inside.length) continue;
                        const groupTotal = ['total', 'count', 'size', 'available'].find(name => group[name] !== undefined);
                        total = groupTotal ? group[groupTotal] : inside.reduce((sum, [, item]) => sum + item, 0);
                        for (const [type, amount] of inside) {
                            if (type !== groupTotal) byType[type] = amount;
                        }
                        break;
                    }
                }
                if (!Number.isFinite(total) || total <= 0) continue;
                return { total, byType };
            }
            return null;
        },
        // Feedback is best effort: a pool that cannot hear it must not break a section.
        async report(endpoint, ok) {
            try {
                const response = await request(`/report?proxy=${encodeURIComponent(endpoint)}&ok=${ok ? 1 : 0}`, timeoutMs);
                return response.ok;
            } catch { return false; }
        }
    };
}

module.exports = { createPoolClient, parseCandidate };
