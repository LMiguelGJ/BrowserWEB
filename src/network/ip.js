'use strict';

const { isIP } = require('node:net');

// One notation per exit, so "::ffff:1.1.1.1" and "1.1.1.1" are the same exit.
function normalizeIp(value) {
    if (typeof value !== 'string') return '';
    const text = value.trim().toLowerCase();
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
    return mapped ? mapped[1] : text;
}

function isPublicIpv4(ip) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
}

function isPublicIpv6(ip) {
    if (ip === '::' || ip === '::1') return false;
    const first = Number.parseInt(ip.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
    if ((first & 0xffc0) === 0xfe80) return false; // link local fe80::/10
    if ((first & 0xff00) === 0xff00) return false; // multicast
    return true;
}

function isPublicIp(value) {
    const ip = normalizeIp(value);
    const version = isIP(ip);
    if (version === 4) return isPublicIpv4(ip);
    if (version === 6) return isPublicIpv6(ip);
    return false;
}

module.exports = { isPublicIp, normalizeIp };
