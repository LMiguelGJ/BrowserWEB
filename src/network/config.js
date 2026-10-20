'use strict';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isHybridMode(env = process.env) {
    return String(env.PYROCK_PROXY_MODE || '').trim().toLowerCase() === 'hybrid';
}

// Settings of the hybrid mode. Invalid values are rejected instead of
// silently replaced: a wrong deadline or a pool outside this machine must be
// noticed, not guessed around.
function readNetworkConfig(env = process.env) {
    if (!isHybridMode(env)) return { enabled: false };
    let freeDeadlineMs = 60000;
    const rawDeadline = env.PYROCK_FREE_SEARCH_TIMEOUT_MS;
    if (rawDeadline !== undefined && rawDeadline !== '') {
        const value = /^\d+$/.test(rawDeadline) ? Number(rawDeadline) : NaN;
        if (!Number.isInteger(value) || value < 10000 || value > 300000) {
            throw new RangeError('PYROCK_FREE_SEARCH_TIMEOUT_MS must be an integer between 10000 and 300000');
        }
        freeDeadlineMs = value;
    }
    let url;
    try { url = new URL(env.PYROCK_PROXY_POOL_URL || 'http://127.0.0.1:8899'); }
    catch { throw new TypeError('PYROCK_PROXY_POOL_URL is not a valid URL'); }
    if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname)) {
        throw new TypeError('PYROCK_PROXY_POOL_URL must be an http URL on this machine (loopback)');
    }
    return { enabled: true, freeDeadlineMs, poolUrl: url.origin, poolPassword: env.PYROCK_PROXY_POOL_PASSWORD || '' };
}

module.exports = { readNetworkConfig, isHybridMode };
