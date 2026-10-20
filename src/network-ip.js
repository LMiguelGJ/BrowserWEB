'use strict';

const { isIP } = require('node:net');
const probePages = new WeakSet();
const IP_SERVICES = ['https://api.ipify.org/', 'https://ifconfig.me/ip', 'https://icanhazip.com/'];

// Navigate outside the site's CSP, but inside its existing proxy context.
async function measureExitIp(context, { services = IP_SERVICES, timeoutMs = 15000 } = {}) {
    let probe;
    let expired = false;
    let timer;
    const deadline = Date.now() + timeoutMs;
    const work = (async () => {
        const page = await context.newPage();
        if (expired) {
            await page.close();
            throw new Error('IP measurement timed out');
        }
        probe = page;
        probePages.add(page);
        for (const url of services) {
            if (expired) break;
            try {
                const response = await page.goto(url, {
                    waitUntil: 'domcontentloaded',
                    timeout: Math.max(1, Math.min(5000, deadline - Date.now()))
                });
                if (!response?.ok()) continue;
                const ip = (await response.text()).trim();
                if (isIP(ip)) return ip;
            } catch { /* Try the next service within the same total deadline. */ }
        }
        throw new Error('IP measurement failed');
    })();
    try {
        return await Promise.race([
            work,
            new Promise((_, reject) => {
                timer = setTimeout(() => { expired = true; reject(new Error('IP measurement timed out')); }, timeoutMs);
            })
        ]);
    } finally {
        expired = true;
        clearTimeout(timer);
        if (probe) {
            try { await probe.close(); } catch { /* Context may already be closed. */ }
        }
    }
}

module.exports = { measureExitIp, isIpProbe: page => probePages.has(page) };
