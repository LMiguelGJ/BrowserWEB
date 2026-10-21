'use strict';

const { isIP } = require('node:net');
const probePages = new WeakSet();
const IP_SERVICES = ['https://api.ipify.org/', 'https://ifconfig.me/ip', 'https://icanhazip.com/'];

// How long a timed out measurement is given to unwind after its navigation is
// aborted, before the probe page is closed anyway.
const ABORT_GRACE_MS = 250;

// The timed out navigation is aborted and then awaited: closing the page while
// a goto is still in flight is what leaves dead contexts behind in the browser.
// The grace keeps an unresponsive navigation from holding the caller.
function settle(work, graceMs) {
    return new Promise(resolve => {
        let grace = null;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            if (grace) clearTimeout(grace);
            resolve();
        };
        grace = setTimeout(finish, Math.max(0, graceMs));
        grace?.unref?.();
        work.then(finish, finish);
    });
}

// Navigate outside the site's CSP, but inside its existing proxy context.
async function measureExitIp(context, { services = IP_SERVICES, timeoutMs = 15000, abortGraceMs = ABORT_GRACE_MS } = {}) {
    let probe;
    let expired = false;
    let timer;
    const controller = new AbortController();
    const deadline = Date.now() + timeoutMs;
    const work = (async () => {
        const page = await context.newPage();
        if (expired) {
            await page.close();
            throw new Error('IP measurement timed out');
        }
        probe = page;
        probePages.add(page);
        let lastError = null;
        for (const url of services) {
            if (expired) break;
            try {
                const response = await page.goto(url, {
                    waitUntil: 'domcontentloaded',
                    // The whole remaining budget goes to this service: a slow
                    // proxy deserves the chance, and the total is the bound.
                    timeout: Math.max(1, deadline - Date.now()),
                    signal: controller.signal
                });
                if (!response?.ok()) continue;
                const ip = (await response.text()).trim();
                if (isIP(ip)) return ip;
            } catch (error) {
                // The reason travels with the failure: it tells a refused proxy
                // apart from a slow service.
                lastError = error;
            }
        }
        throw new Error(`IP measurement failed${lastError?.message ? `: ${lastError.message}` : ''}`);
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
        controller.abort();
        await settle(work, abortGraceMs);
        if (probe) {
            try { await probe.close(); } catch { /* Context may already be closed. */ }
        }
    }
}

module.exports = { measureExitIp, isIpProbe: page => probePages.has(page) };
