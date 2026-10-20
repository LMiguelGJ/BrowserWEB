'use strict';

const { parseProxyTemplate } = require('../engines/camoufox');

// DataImpulse is the paid fallback. Each section has its own sticky port: the
// rotating port is never used as an identity, and a candidate list is only
// built when everything needed to measure the real exit is configured.
const STEP = 50;
const ATTEMPTS = 3;
const LAST_PORT = 20000;

function fallbackCandidates(sectionId, env = process.env) {
    const template = parseProxyTemplate(env.PYROCK_PROXY);
    if (!template || !template.username || !template.host) return null;
    const value = Number(env.PYROCK_PROXY_STICKY_BASE);
    if (!Number.isInteger(value) || value < 10000 || value > LAST_PORT) return null;
    const index = Number(String(sectionId || '').replace(/\D/g, '')) || 0;
    const candidates = [];
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const port = value + index + attempt * STEP;
        if (port > LAST_PORT) break;
        candidates.push({
            server: `${template.scheme}://${template.host}:${port}`,
            username: template.username, password: template.password
        });
    }
    return candidates.length ? candidates : null;
}

module.exports = { fallbackCandidates, ATTEMPTS };
