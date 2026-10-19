/*
 * Camoufox engine for PyRock.
 *
 * Camoufox is an anti-detect Firefox driven through Playwright (camoufox-js,
 * the Apify port). PyRock was written against Puppeteer/CDP, so this module
 * adapts the small Playwright surface it needs to the shape server.js and
 * screencast.js already use. Nothing else in the preview pipeline changes:
 *
 *   - wrapPage() exposes the Puppeteer-style calls PyRock makes
 *     (setViewport, goto, screenshot with encoding, mouse, keyboard, isClosed).
 *   - createCDPSession() returns a CDP-compatible event bridge: Playwright's
 *     page.screencast.start({ onFrame }) (>= 1.59, Firefox capped at 25 fps)
 *     becomes "Page.screencastFrame" events, so screencast.js keeps its ack
 *     flow untouched. Without page.screencast it falls back to polling
 *     screenshots, so the preview still works on older Playwright builds.
 *
 * Stealth lives in the browser, not in injected scripts: Camoufox masks the
 * fingerprint at the C++ level and ships its own cursor humanizer, so this
 * engine injects no window.chrome / navigator patches and PyRock must not
 * add its own cursor humanization on top (see humanizesCursor).
 */

'use strict';

const { EventEmitter } = require('node:events');

const VIEWPORT = { width: 1366, height: 768 };
const DEFAULT_FALLBACK_INTERVAL_MS = 200;

function selectEngine(env = process.env) {
    return String(env.ENGINE || '').toLowerCase() === 'camoufox' ? 'camoufox' : 'chromium';
}

function parseHeadless(value) {
    const normalized = String(value ?? 'true').trim().toLowerCase();
    if (normalized === 'virtual') return 'virtual';
    if (normalized === 'false') return false;
    return true;
}

function mapWaitUntil(waitUntil) {
    return waitUntil === 'networkidle0' || waitUntil === 'networkidle2' ? 'networkidle' : waitUntil;
}

function createFrameSession(page, { timers = globalThis, fallbackIntervalMs = DEFAULT_FALLBACK_INTERVAL_MS } = {}) {
    const session = new EventEmitter();
    let nextSessionId = 0;
    let screencastActive = false;
    let pollTimer = null;
    let polling = false;

    const emitFrame = buffer => {
        session.emit('Page.screencastFrame', { data: Buffer.from(buffer).toString('base64'), sessionId: ++nextSessionId });
    };

    async function start(params = {}) {
        const quality = params.quality ?? 60;
        const size = { width: params.maxWidth ?? VIEWPORT.width, height: params.maxHeight ?? VIEWPORT.height };
        if (page.screencast && typeof page.screencast.start === 'function') {
            await page.screencast.start({ onFrame: async ({ data }) => emitFrame(data), size, quality });
            screencastActive = true;
            return;
        }
        pollTimer = timers.setInterval(async () => {
            if (polling) return;
            polling = true;
            try { emitFrame(await page.screenshot({ type: 'jpeg', quality })); }
            catch { /* a closed page just stops producing frames */ }
            finally { polling = false; }
        }, fallbackIntervalMs);
        pollTimer?.unref?.();
    }

    async function stop() {
        if (pollTimer !== null) {
            timers.clearInterval(pollTimer);
            pollTimer = null;
        }
        if (screencastActive) {
            screencastActive = false;
            await page.screencast.stop();
        }
    }

    session.send = async (method, params) => {
        switch (method) {
            case 'Page.startScreencast': return start(params);
            case 'Page.stopScreencast': return stop();
            case 'Page.screencastFrameAck': return undefined; // Playwright needs no per-frame ack.
            default: throw new Error(`Unsupported CDP method: ${method}`);
        }
    };
    session.detach = async () => {
        await stop();
        session.removeAllListeners();
    };
    return session;
}

function wrapPage(page, options = {}) {
    return {
        raw: page,
        mouse: page.mouse,
        keyboard: page.keyboard,
        async setViewport(size) { await page.setViewportSize(size); },
        // Camoufox owns request headers and keeps them consistent with its fingerprint; the Chrome-style
        // Sec-Fetch-* / Accept-* set PyRock sends to Chromium would contradict it, so they are dropped here.
        async setExtraHTTPHeaders() {},
        goto(url, { waitUntil, timeout } = {}) {
            return page.goto(url, {
                ...(waitUntil ? { waitUntil: mapWaitUntil(waitUntil) } : {}),
                ...(timeout !== undefined ? { timeout } : {})
            });
        },
        async screenshot({ encoding, ...rest } = {}) {
            const image = await page.screenshot(rest);
            return encoding === 'base64' ? Buffer.from(image).toString('base64') : image;
        },
        isClosed: () => page.isClosed(),
        createCDPSession: async () => createFrameSession(page, options)
    };
}

function createCamoufoxEngine({ loader = () => import('camoufox-js'), launchOptions = {} } = {}) {
    return {
        name: 'camoufox',
        // The browser humanizes the cursor itself; PyRock must not stack a second humanizer on top.
        humanizesCursor: true,
        async launch() {
            const { Camoufox } = await loader();
            return Camoufox({
                headless: parseHeadless(process.env.CAMOUFOX_HEADLESS),
                humanize: true,
                ...launchOptions
            });
        },
        async openPage(browser) {
            // No context options: Camoufox injects its own fingerprint and locale, and overriding them breaks consistency.
            const context = await browser.newContext();
            try {
                const page = wrapPage(await context.newPage());
                await page.setViewport(VIEWPORT);
                return { context, page };
            } catch (error) {
                try { await context.close(); } catch { /* the original failure is the useful one */ }
                throw error;
            }
        },
        closeContext: context => context.close()
    };
}

module.exports = { createCamoufoxEngine, wrapPage, createFrameSession, selectEngine, parseHeadless, VIEWPORT };
