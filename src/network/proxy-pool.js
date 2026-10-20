'use strict';

const { isIP } = require('node:net');
const { isPublicIp } = require('./ip');

// Client of the proxy-scraper pool API. Only plain HTTP proxies with a
// verified TLS test are requested: the same `https=1` filter also admits SOCKS
// relays, and those did not answer inside Camoufox.
const POP_PATH = '/pop?protocol=http&https=1';

function parseCandidate(body) {
    let url;
    try { url = new URL(body?.url); } catch { return { status: 'invalid', reason: 'malformed' }; }
    const endpoint = typeof body?.proxy === 'string' ? body.proxy : `${url.hostname}:${url.port}`;
    const reject = reason => ({ status: 'invalid', reason, endpoint });
    if (url.protocol !== 'http:' || (body.type && body.type !== 'http')) return reject('not_http');
    if (url.username || url.password) return reject('credentials');
    const port = Number(url.port);
    if (!isIP(url.hostname) || !Number.isInteger(port) || port < 1 || port > 65535) return reject('malformed');
    if (!isPublicIp(url.hostname)) return reject('not_public');
    return { status: 'ok', proxy: { endpoint, server: `http://${url.hostname}:${port}` } };
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
            let response;
            try { response = await request(POP_PATH, limit); }
            catch { return { status: 'unavailable', reason: 'unreachable' }; }
            if (response.status === 401) return { status: 'unavailable', reason: 'unauthorized' };
            if (response.status === 404) return { status: 'empty' };
            if (!response.ok) return { status: 'unavailable', reason: `http_${response.status}` };
            let body;
            try { body = await response.json(); } catch { return { status: 'invalid', reason: 'malformed' }; }
            if (body?.code === 0 && !body?.url) return { status: 'empty' };
            return parseCandidate(body);
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
