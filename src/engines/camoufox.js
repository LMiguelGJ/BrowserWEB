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
const { isIpProbe } = require('../network-ip');
const { isHybridMode } = require('../network/config');

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

function createFrameSession(page, { timers = globalThis, fallbackIntervalMs = FALLBACK_POLL_MS, logger = null } = {}) {
    const session = new EventEmitter();
    let nextSessionId = 0;
    let screencastActive = false;
    let pollTimer = null;
    let polling = false;
    // Which path the preview took: 'screencast' (real frames) or 'poll'
    // (screenshots every 200 ms). The operator needs to know: a polling preview
    // is capped at ~5 fps and would otherwise look like a slow page.
    let previewMode = null;

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
            previewMode = 'screencast';
            logger?.info('Vista previa por screencast (frames nativos)');
            return;
        }
        // Older Playwright builds (or a Juggler without screencast): poll screenshots.
        previewMode = 'poll';
        logger?.info(`Vista previa por sondeo de capturas (cada ${fallbackIntervalMs} ms)`);
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
    session.previewMode = () => previewMode;
    return session;
}

function wrapPage(page, options = {}) {
    let frameSession = null;
    return {
        raw: page,
        mouse: page.mouse,
        keyboard: page.keyboard,
        evaluate: (fn, arg) => page.evaluate(fn, arg),
        // Where the section really is: it changes when the site opens a new tab.
        currentUrl: () => (typeof page.url === 'function' ? page.url() : ''),
        // 'screencast' or 'poll': how the preview frames are produced.
        previewMode: () => (frameSession ? frameSession.previewMode() : null),
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
        async createCDPSession() {
            frameSession = createFrameSession(page, options);
            return frameSession;
        }
    };
}

function parseHeadless(value) {
    const normalized = String(value ?? 'true').trim().toLowerCase();
    if (normalized === 'virtual') return 'virtual';
    if (normalized === 'false') return false;
    return true;
}

// The configured proxy, split into the parts a per-context proxy needs.
function parseProxyTemplate(value) {
    if (!value) return null;
    try {
        const url = new URL(value);
        return {
            scheme: url.protocol.replace(':', ''),
            host: url.hostname,
            port: url.port,
            username: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password)
        };
    } catch {
        return null;
    }
}

// The port range DataImpulse binds to a single IP for ~30 minutes. A sticky
// port needs no username markers, so nothing has to be percent-encoded on the
// way to the gateway.
function stickyBase() {
    const value = Number(process.env.PYROCK_PROXY_STICKY_BASE);
    return Number.isInteger(value) && value >= 10000 && value <= 20000 ? value : null;
}

function buildProxyUrl(template, port) {
    const credentials = template.username
        ? `${encodeURIComponent(template.username)}${template.password ? `:${encodeURIComponent(template.password)}` : ''}@`
        : '';
    return `${template.scheme}://${credentials}${template.host}:${port}`;
}

// Playwright wants the origin alone: credentials travel in their own fields.
function proxyOrigin(template, port) {
    return `${template.scheme}://${template.host}:${port}`;
}

// El puerto de un proxy, sin arriesgar una URL mal formada.
function proxyPort(server) {
    try { return Number(new URL(server).port) || null; } catch { return null; }
}

// La etiqueta de un proxy sin credenciales: nunca sale la contraseña en una
// respuesta de la API.
function proxyLabel(server) {
    try { const url = new URL(server); return `${url.protocol}//${url.host}`; } catch { return null; }
}

// The proxy a section uses: its own sticky port, so every section keeps a
// stable exit IP instead of getting a new one on every request.
function sectionProxy(sectionId) {
    const template = parseProxyTemplate(process.env.PYROCK_PROXY);
    const base = stickyBase();
    if (!template || !base) return null;
    const index = Number(String(sectionId || '').replace(/\D/g, '')) || 0;
    const port = base + index;
    // Only the shape Playwright accepts: an unknown key here is rejected.
    return { server: proxyOrigin(template, port), username: template.username, password: template.password };
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

// Ad, consent and analytics networks. A page that waits for one of these can
// sit in its loader for a long time — and one of them (a Cloudflare challenge
// script served by an ad network) may never resolve at all. Blocking them is
// opt-in because some sites need their consent script to boot.
const TRACKER_HOSTS = [
    'doubleclick.net', 'googlesyndication.com', 'google-analytics.com', 'googletagmanager.com',
    'amazon-adsystem.com', 'intergient.com', 'playwire.com', 'id5-sync.com',
    'fundingchoicesmessages.google.com', 'crwdcntrl.net', 'stackadapt.com', 'liadm.com',
    'scorecardresearch.com', 'taboola.com', 'outbrain.com', 'adsrvr.org', 'adnxs.com',
    'yieldmo.com', 'onesignal.com', 'smartadserver.com', 'casalemedia.com'
];

function isTrackerRequest(url) {
    try {
        const { hostname } = new URL(url);
        return TRACKER_HOSTS.some(host => hostname === host || hostname.endsWith(`.${host}`));
    } catch {
        return false;
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
                firefox_user_prefs: {
                    // Firefox decodifica H.264 con el libavcodec DEL SISTEMA: sin
                    // esas librerías en la imagen no puede pintar un stream avc1
                    // (el visor de browser.lol dice "unsupported-codec" y se queda
                    // en blanco aunque la página cargue).
                    'media.ffmpeg.use-system-libavcodec': true,
                    // En un contenedor los candidatos mDNS (.local) no se resuelven
                    // y el ICE falla: hay que quedarse con las direcciones de host.
                    'media.ice.default_address_only': true
                },
                ...launchOptions
            };
            const hybrid = isHybridMode();
            if (hybrid) {
                // Every section brings its own proxy, so the browser has no global
                // one. Two Firefox switches make sure nothing leaves directly: a
                // dead proxy must not fall back to the real connection, and
                // WebRTC may only use the proxy for ICE (it would otherwise
                // reveal the real address).
                options.firefox_user_prefs = {
                    ...options.firefox_user_prefs,
                    'network.proxy.failover_direct': false,
                    'media.peerconnection.ice.proxy_only_if_behind_proxy': true
                };
            }
            // A residential proxy makes the exit IP look like a person's connection
            // instead of a datacenter one — the single factor that most bot
            // protection actually scores.
            const proxy = hybrid ? '' : process.env.PYROCK_PROXY?.trim();
            if (proxy) {
                // With sticky ports the launch traffic leaves through the base
                // port, so the geolocation Camoufox derives matches the pool
                // the sections use.
                const template = parseProxyTemplate(proxy);
                const base = stickyBase();
                options.proxy = template && base ? buildProxyUrl(template, base) : proxy;
            }
            // With a proxy, the geolocation spoofed in the fingerprint should match
            // the proxy's IP; camoufox-js warns when it does not.
            if (!hybrid && (process.env.PYROCK_GEOIP === '1' || process.env.PYROCK_GEOIP === 'true')) {
                options.geoip = true;
            }
            return Camoufox(options);
        },
        async openPage(browser, { section, onPopup, proxy: assigned, storageState } = {}) {
            // No context options: Camoufox generates and owns the fingerprint,
            // and overriding its viewport or locale would break consistency.
            // The only exceptions are the proxy, so each section keeps its own
            // exit, and the state restored when a section changes exit.
            const hybrid = isHybridMode();
            // In the hybrid mode a context without an assigned proxy would leave
            // directly: refuse to create it at all.
            if (hybrid && !assigned) throw new Error('A hybrid section needs an assigned proxy before it can open');
            const proxy = assigned || (section ? sectionProxy(section.id) : null);
            const contextOptions = {};
            if (proxy) contextOptions.proxy = proxy;
            if (storageState) contextOptions.storageState = storageState;
            const context = await browser.newContext(Object.keys(contextOptions).length ? contextOptions : undefined);
            try {
                const raw = await context.newPage();
                if (logger) {
                    // Every message about a page says which section it belongs
                    // to: without that the log mixes the sections and there is
                    // no way to tell them apart.
                    const label = section?.name ? String(section.name).replace(/\s+/g, ' ').trim() : '';
                    const tag = label ? `[${label}] ` : '';
                    // A blank preview is the symptom; these are the causes.
                    raw.on('console', message => {
                        if (message.type() === 'error') logger.warn(`${tag}error de consola en la página: ${message.text().slice(0, 160)}`);
                    });
                    raw.on('pageerror', error => logger.warn(`${tag}excepción en la página: ${error.message.slice(0, 160)}`));
                    raw.on('requestfailed', request => {
                        const reason = request.failure()?.errorText || 'falló';
                        logger.warn(`${tag}petición fallida: ${request.url().slice(0, 120)} (${reason})`);
                    });
                }
                const page = wrapPage(raw, { logger });
                // Requests still in flight are the smoking gun when a page never
                // finishes loading: a challenge script that never resolves holds
                // the app's bootstrap hostage.
                const inFlight = new Set();
                raw.on('request', request => inFlight.add(request));
                raw.on('requestfinished', request => inFlight.delete(request));
                raw.on('requestfailed', request => inFlight.delete(request));
                page.pendingRequests = () => [...inFlight].map(request => request.url());
                // A site that opens a link in a new tab (a session link, a popup)
                // is reported so the section can follow it: otherwise the preview
                // would keep showing the page that opened the tab.
                if (typeof onPopup === 'function' && typeof context.on === 'function') {
                    const originOf = url => { try { return new URL(url).origin; } catch { return null; } };
                    const waitForRealUrl = async target => {
                        for (let attempt = 0; attempt < 30; attempt++) {
                            if (target.isClosed?.() || isIpProbe(target)) return null;
                            const current = target.url();
                            if (current && current !== 'about:blank') return current;
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                        return null;
                    };
                    context.on('page', popup => {
                        if (popup === raw) return;
                        (async () => {
                            const url = await waitForRealUrl(popup);
                            if (!url || isIpProbe(popup)) return; // Internal probes never replace the preview.
                            const popupOrigin = originOf(url);
                            const mainOrigin = originOf(raw.url());
                            // Only the same site is followed: an advertisement or
                            // a third-party popup would take the preview away
                            // from the page the user is working on.
                            if (popupOrigin && mainOrigin && popupOrigin !== mainOrigin) {
                                logger?.warn(`pestaña nueva ignorada (sitio distinto): ${url.slice(0, 120)}`);
                                return;
                            }
                            await onPopup(wrapPage(popup));
                        })().catch(() => {});
                    });
                }
                // Ad and consent networks can hold a page in its loader; blocking
                // them is opt-in (PYROCK_BLOCK_ADS=1) because some sites need
                // their consent script to boot.
                if (process.env.PYROCK_BLOCK_ADS === '1' || process.env.PYROCK_BLOCK_ADS === 'true') {
                    await raw.route('**/*', route => {
                        const request = route.request();
                        if (isTrackerRequest(request.url())) {
                            route.abort().catch(() => {});
                            return;
                        }
                        route.continue().catch(() => {});
                    });
                }
                return { context, page };
            } catch (error) {
                try { await context.close(); } catch { /* the original failure is the useful one */ }
                throw error;
            }
        },
        closeContext: context => context.close()
    };
}

module.exports = { createCamoufoxEngine, wrapPage, createFrameSession, measurePage, parseHeadless, diagnosePage, sectionProxy, parseProxyTemplate, stickyBase, buildProxyUrl, proxyPort, proxyLabel };
