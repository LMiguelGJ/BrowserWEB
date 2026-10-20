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
        // How many proxies the pool still has, by type. Only for showing: the
        // shape of the answer is not guaranteed, so a number is taken wherever
        // there is one and the breakdown is best effort.
        async count() {
            let body;
            try {
                const response = await request('/count', timeoutMs);
                if (!response.ok) return null;
                body = await response.json();
            } catch { return null; }
            if (!body || typeof body !== 'object') return null;
            const numbers = {};
            for (const [key, value] of Object.entries(body)) {
                if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
            }
            const explicit = numbers.total ?? numbers.count;
            const byType = {};
            for (const [key, value] of Object.entries(numbers)) {
                if (key === 'total' || key === 'count') continue;
                byType[key] = value;
            }
            // The pool may answer with the totals grouped (by type, by country):
            // the numbers inside the first group are the ones by type.
            for (const value of Object.values(body)) {
                if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
                const inside = Object.entries(value).filter(([, item]) => typeof item === 'number' && Number.isFinite(item));
                if (inside.length && !Object.keys(byType).length) {
                    for (const [type, amount] of inside) byType[type] = amount;
                    break;
                }
            }
            const total = explicit ?? Object.values(byType).reduce((sum, value) => sum + value, 0);
            if (!Number.isFinite(total) || total <= 0) return null;
            return { total, byType };
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
