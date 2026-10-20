'use strict';

// The page a section opens on. It is a plain navigation through the section's
// own proxy, so it leaves by the same exit as everything else the section
// does. Only http and https are accepted: a value that is not a page is
// ignored rather than opened. The value "off" means no start page at all.
const DEFAULT_START_URL = 'https://browser.lol/';

function startUrl(env = process.env) {
    const raw = String(env.PYROCK_START_URL || '').trim();
    if (!raw) return DEFAULT_START_URL;
    if (raw.toLowerCase() === 'off') return null;
    try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_START_URL;
        return url.toString();
    } catch {
        return DEFAULT_START_URL;
    }
}

module.exports = { startUrl, DEFAULT_START_URL };
