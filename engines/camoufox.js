/*
 * Camoufox engine for PyRock — the only engine.
 *
 * Camoufox (daijro/camoufox) is an anti-detect Firefox driven through
 * Playwright. This module adapts the small Playwright surface PyRock needs to
 * the Puppeteer-ish shape server.js and screencast.js already use, so the
 * preview pipeline, the REST contract and the UI stay untouched.
 *
 * Three facts from the official API (camoufox-js 0.13.0) drive this design:
 *
 * 1. `Camoufox(options)` returns a Playwright *Browser* (not a context
 *    manager, unlike the Python API). One browser, one context per section.
 * 2. Camoufox defaults contexts to `viewport: null` on purpose: it pins the
 *    window to a spoofed size and lets Juggler measure it. An explicit
 *    viewport cannot be satisfied and breaks the fingerprint — so this engine
 *    never sets one.
 * 3. Playwright's `page.screencast` (>= 1.59) delivers JPEG frames in CSS
 *    pixels, 1:1 with the page. That matters: PyRock's client maps a click on
 *    the preview image back to page coordinates using the image's pixel size,
 *    so a scaled frame would send clicks to the wrong place. Frames are
 *    therefore requested at the page's own CSS size, and manual screenshots
 *    are taken with scale:'css' so both paths agree.
 *
 * Stealth lives in the browser (C++ level), not in injected scripts: this
 * engine injects no Chrome-style patches and sends no Chrome-style headers,
 * because those would contradict Camoufox's own fingerprint.
 *
 * Cursor humanization: Camoufox can humanize the cursor itself, but that is a
 * launch-time setting with no per-request override, and PyRock's API promises
 * `humanize: false` returns to instant clicks. PyRock therefore launches with
 * Camoufox's built-in humanizer OFF and uses its own (cursory-js — the same
 * generator Camoufox vendors) so the per-request contract holds exactly.
 */

'use strict';

const { EventEmitter } = require('node:events');

const FALLBACK_POLL_MS = 200;
const DEFAULT_FRAME_SIZE = { width: 1366, height: 768 };

function mapWaitUntil(waitUntil) {
    if (waitUntil === 'networkidle0' || waitUntil === 'networkidle2') return 'networkidle';
    return waitUntil;
}

// The page's own CSS size, which is what a frame must match to keep clicks honest.
async function measurePage(page) {
    if (typeof page.viewportSize === 'function') {
        const size = page.viewportSize();
        if (size && size.width > 0 && size.height > 0) return size;
    }
    if (typeof page.evaluate === 'function') {
        const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
        if (size && size.width > 0 && size.height > 0) return size;
    }
    return null;
}

function createFrameSession(page, { timers = globalThis, fallbackIntervalMs = FALLBACK_POLL_MS } = {}) {
    const session = new EventEmitter();
    let nextSessionId = 0;
    let screencastActive = false;
    let pollTimer = null;
    let polling = false;

    const emitFrame = buffer => {
        session.emit('Page.screencastFrame', { data: Buffer.from(buffer).toString('base64'), sessionId: ++nextSessionId });
    };

    async function start() {
        const quality = 60;
        // The frame must be the page's CSS size: PyRock's client maps preview
        // clicks through the image's pixel size, so any scaling would break it.
        const size = await measurePage(page) || DEFAULT_FRAME_SIZE;
        if (page.screencast && typeof page.screencast.start === 'function') {
            await page.screencast.start({ onFrame: async ({ data }) => emitFrame(data), size, quality });
            screencastActive = true;
            return;
        }
        // Older Playwright builds (or a Juggler without screencast): poll screenshots.
        pollTimer = timers.setInterval(async () => {
            if (polling) return;
            polling = true;
            try { emitFrame(await page.screenshot({ type: 'jpeg', quality, scale: 'css' })); }
            catch { /* a closed page simply stops producing frames */ }
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
            // The page may already be closed (browser restart, crash): stopping a
            // dead target must not be reported as a preview failure.
            try { await page.screencast.stop(); }
            catch (error) {
                if (!/closed|detached|target closed|has been closed/i.test(error?.message || '')) throw error;
            }
        }
    }

    session.send = async (method) => {
        switch (method) {
            case 'Page.startScreencast': return start();
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
        evaluate: (fn, arg) => page.evaluate(fn, arg),
        // Camoufox owns the window size and the fingerprint: PyRock must not
        // pin a viewport, set a user agent or send Chrome-style headers.
        async setViewport() {},
        async setUserAgent() {},
        async setExtraHTTPHeaders() {},
        async evaluateOnNewDocument() {},
        goto(url, { waitUntil, timeout } = {}) {
            return page.goto(url, {
                ...(waitUntil ? { waitUntil: mapWaitUntil(waitUntil) } : {}),
                ...(timeout !== undefined ? { timeout } : {})
            });
        },
        async screenshot({ encoding, scale = 'css', ...rest } = {}) {
            // scale:'css' keeps manual screenshots in the same pixel space as
            // the live frames, so the client's click mapping stays correct.
            const image = await page.screenshot({ ...rest, scale });
            return encoding === 'base64' ? Buffer.from(image).toString('base64') : image;
        },
        isClosed: () => page.isClosed(),
        createCDPSession: async () => createFrameSession(page, options)
    };
}

function parseHeadless(value) {
    const normalized = String(value ?? 'true').trim().toLowerCase();
    if (normalized === 'virtual') return 'virtual';
    if (normalized === 'false') return false;
    return true;
}

function defaultOs() {
    return process.platform === 'win32' ? 'windows' : 'linux';
}

async function resolveCamoufox(loader) {
    const module = await loader();
    // The real package is ESM; a CommonJS test seam exposes the export on default.
    const exported = module.Camoufox || module.default?.Camoufox;
    if (typeof exported !== 'function') throw new Error('camoufox-js did not export a Camoufox function');
    return exported;
}

// Reads what the controlled page actually did, so a blank preview can be
// explained instead of guessed: a page stuck in "loading" never ran its app,
// while a "complete" page with no text is a different failure.
async function diagnosePage(page) {
    const pending = (typeof page.pendingRequests === 'function' ? page.pendingRequests() : []).slice(0, 8);
    try {
        const state = await page.evaluate(() => {
            const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
            return {
                readyState: document.readyState,
                title: document.title,
                textLength: text.length,
                spinnerish: document.querySelectorAll('[class*="spinner"],[class*="loading"],[class*="Loader"],[role="progressbar"]').length
            };
        });
        return { ...state, pending };
    } catch (error) {
        return { error: error.message.split('\n')[0], pending };
    }
}

function createCamoufoxEngine({ loader = () => import('camoufox-js'), launchOptions = {}, logger = null } = {}) {
    return {
        name: 'camoufox',
        // PyRock humanizes the cursor itself (cursory-js), so Camoufox's
        // launch-time humanizer stays off to avoid humanizing twice.
        humanizesCursor: false,
        async launch() {
            const Camoufox = await resolveCamoufox(loader);
            const options = {
                headless: parseHeadless(process.env.CAMOUFOX_HEADLESS),
                humanize: false,
                os: process.env.CAMOUFOX_OS || defaultOs(),
                locale: process.env.CAMOUFOX_LOCALE || 'es-ES',
                ...launchOptions
            };
            // A residential proxy makes the exit IP look like a person's connection
            // instead of a datacenter one — the single factor that most bot
            // protection actually scores.
            const proxy = process.env.PYROCK_PROXY?.trim();
            if (proxy) options.proxy = proxy;
            // With a proxy, the geolocation spoofed in the fingerprint should match
            // the proxy's IP; camoufox-js warns when it does not.
            if (process.env.PYROCK_GEOIP === '1' || process.env.PYROCK_GEOIP === 'true') {
                options.geoip = true;
            }
            return Camoufox(options);
        },
        async openPage(browser) {
            // No context options: Camoufox generates and owns the fingerprint,
            // and overriding its viewport or locale would break consistency.
            const context = await browser.newContext();
            try {
                const raw = await context.newPage();
                if (logger) {
                    // A blank preview is the symptom; these are the causes.
                    raw.on('console', message => {
                        if (message.type() === 'error') logger.warn(`error de consola en la página: ${message.text().slice(0, 160)}`);
                    });
                    raw.on('pageerror', error => logger.warn(`excepción en la página: ${error.message.slice(0, 160)}`));
                    raw.on('requestfailed', request => {
                        const reason = request.failure()?.errorText || 'falló';
                        logger.warn(`petición fallida: ${request.url().slice(0, 120)} (${reason})`);
                    });
                }
                const page = wrapPage(raw);
                // Requests still in flight are the smoking gun when a page never
                // finishes loading: a challenge script that never resolves holds
                // the app's bootstrap hostage.
                const inFlight = new Set();
                raw.on('request', request => inFlight.add(request));
                raw.on('requestfinished', request => inFlight.delete(request));
                raw.on('requestfailed', request => inFlight.delete(request));
                page.pendingRequests = () => [...inFlight].map(request => request.url());
                return { context, page };
            } catch (error) {
                try { await context.close(); } catch { /* the original failure is the useful one */ }
                throw error;
            }
        },
        closeContext: context => context.close()
    };
}

module.exports = { createCamoufoxEngine, wrapPage, createFrameSession, measurePage, parseHeadless, diagnosePage };
