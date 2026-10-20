'use strict';
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('node:url');
const WebSocket = require('ws');
const { createScreencastController } = require('./screencast');
const { createSessionManager } = require('./sessions');
const { measureExitIp } = require('./network-ip');
const { generateHumanPath, typeDelays } = require('./humanize');
const { createCamoufoxEngine, diagnosePage, sectionProxy, parseProxyTemplate, stickyBase, buildProxyUrl, proxyPort, proxyLabel } = require('./engines/camoufox');
const { readNetworkConfig, isHybridMode } = require('./network/config');
const { createNetworkManager } = require('./network/manager');
const { captureSnapshot, mergeSnapshots, restoreSnapshot } = require('./network/snapshot');
const PORT = process.env.PORT || 3000;
// Camoufox (anti-detect Firefox via Playwright) is the only engine.
// PYROCK_CAMOUFOX_MODULE is a test seam: it points the loader at a fixture module.
// The env var is read on every launch (not at import time) so a test can set it
// after requiring this module.
const camoufoxLoader = () => {
    const seam = process.env.PYROCK_CAMOUFOX_MODULE;
    return seam ? import(pathToFileURL(path.resolve(seam)).href) : import('camoufox-js');
};
const rawLimit = process.env.MAX_SESSIONS;
const parsedLimit = rawLimit && /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
const MAX_SESSIONS = Number.isInteger(parsedLimit) && parsedLimit >= 1 ? Math.min(parsedLimit, 10) : 5;
let browser = null;
let mutationQueue = Promise.resolve();
let shuttingDown = false;
let shutdownCleanupError = null;
let lastAction = { type: 'status', message: 'Servidor iniciado', timestamp: Date.now() };
const log = {
    info: (...args) => console.log(`[${new Date().toLocaleTimeString()}]`, ...args),
    warn: (...args) => console.warn(`[${new Date().toLocaleTimeString()}] WARN:`, ...args),
    error: (...args) => console.error(`[${new Date().toLocaleTimeString()}] ERROR:`, ...args)
};
// The engine reports the page's console errors and failed requests through the log.
const engine = createCamoufoxEngine({ loader: camoufoxLoader, logger: log });
function serializeMutation(operation) {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.catch(() => {});
    return result;
}
async function ensureBrowser() {
    if (shuttingDown) throw Object.assign(new Error('Server is shutting down'), { status: 503 });
    if (browser) return browser;
    const launched = await engine.launch();
    if (shuttingDown) { await launched.close(); throw Object.assign(new Error('Server is shutting down'), { status: 503 }); }
    browser = launched;
    launched.once?.('disconnected', () => {
        if (browser !== launched) return;
        browser = null;
        sessions.markUnavailable('Browser disconnected');
    });
    return launched;
}
// ---- Hybrid network: a free exit per section, DataImpulse only as a fallback ----
// The manager is built on first use from the environment, so a wrong setting
// is reported instead of guessed around. Outside the hybrid mode none of this
// runs and the sections behave exactly as before.
let network = null;
let networkSignature = '';
function ensureNetwork() {
    if (!isHybridMode()) { network = null; networkSignature = ''; return null; }
    const config = readNetworkConfig();
    const signature = JSON.stringify(config);
    if (!network || signature !== networkSignature) {
        network = createNetworkManager({ config, env: process.env, probe: probeProxy });
        networkSignature = signature;
    }
    return network;
}
// Measures the real exit of a candidate in the browser itself, in a throwaway
// context: that is the address a site would see, whatever the pool claims.
async function probeProxy(proxy, { timeoutMs }) {
    const activeBrowser = await ensureBrowser();
    const context = await activeBrowser.newContext({ proxy });
    try { return await measureExitIp(context, { timeoutMs }); }
    finally { try { await context.close(); } catch { /* the probe is over */ } }
}
function noExit(result) {
    const why = [result.reason, result.freeReason].filter(Boolean).join(' / ');
    return Object.assign(new Error(`Sin salida de red disponible (${why || 'sin motivo'})`), { status: 503, networkReason: result.reason });
}
// An exit found before the section is created or resumed, so the long search
// does not hold the queue that every other section shares.
const preassigned = new Map();
async function networkAssignment(section) {
    const net = ensureNetwork();
    if (!net) return null;
    const ready = preassigned.get(section.id);
    if (ready) { preassigned.delete(section.id); return ready; }
    return net.assign(section.id, { isCancelled: () => shuttingDown });
}
const recoveries = new Map();
const recoveryJobs = new Set();
function networkRetryDelays() {
    const custom = String(process.env.PYROCK_NETWORK_RETRY_MS || '').split(',').map(Number).filter(value => Number.isInteger(value) && value > 0);
    return custom.length ? custom : [30000, 60000, 120000, 300000];
}
function stopRecovery(id) {
    const record = recoveries.get(id);
    if (!record) return;
    clearTimeout(record.timer);
    record.generation++;
    recoveries.delete(id);
}
function scheduleRecoveryRetry(id, record) {
    const delays = networkRetryDelays();
    const base = delays[Math.min(record.attempt, delays.length - 1)];
    record.attempt++;
    // Jitter keeps several waiting sections from asking the pool at the same instant.
    record.timer = setTimeout(() => { record.timer = null; recoverSection(id).catch(() => {}); }, Math.round(base * (1 + Math.random() * 0.2)));
    record.timer.unref?.();
}
// Replaces the exit of a section whose proxy stopped working, keeping its
// identity, its cookies and storage and the page it was on. One recovery per
// section at a time; closing the section or stopping the server cancels it.
async function recoverSection(id) {
    const net = ensureNetwork();
    const section = sessions.get(id);
    if (!net || !section || shuttingDown) return false;
    let record = recoveries.get(id);
    if (record?.running) return false;
    if (!record) { record = { generation: 0, attempt: 0, timer: null, running: false }; recoveries.set(id, record); }
    clearTimeout(record.timer);
    record.timer = null;
    record.running = true;
    const generation = ++record.generation;
    const cancelled = () => shuttingDown || sessions.get(id) !== section || recoveries.get(id) !== record || record.generation !== generation;
    const job = (async () => {
        try {
            section.recovering = true;
            if (section.page) {
                section.snapshot = mergeSnapshots(await captureSnapshot(section), section.snapshot);
                await net.reportLoss(id);
                await serializeMutation(() => sessions.suspend(id));
            }
            const assignment = await net.assign(id, { isCancelled: cancelled, recovering: true });
            if (cancelled()) { net.release(id); return false; }
            if (!assignment.provider) { scheduleRecoveryRetry(id, record); return false; }
            preassigned.set(id, assignment);
            try { await serializeMutation(() => sessions.resume(id)); }
            finally { preassigned.delete(id); }
            if (cancelled()) return false;
            await restoreSnapshot(section, section.snapshot);
            section.recovering = false;
            record.attempt = 0;
            return true;
        } catch (error) {
            log.warn(`No se pudo recuperar la salida de ${id}: ${error.message}`);
            if (!cancelled()) scheduleRecoveryRetry(id, record);
            return false;
        } finally { record.running = false; }
    })();
    recoveryJobs.add(job);
    job.finally(() => recoveryJobs.delete(job)).catch(() => {});
    return job;
}
const networkControl = {
    recover: recoverSection,
    idle: () => Promise.allSettled([...recoveryJobs]),
    view: id => ensureNetwork()?.view(id) || null,
    summary: () => ensureNetwork()?.summary() || null
};
let proxyHealth = null;
function ensureProxyHealth() {
    const net = ensureNetwork();
    if (!net) { proxyHealth?.stop(); proxyHealth = null; return null; }
    if (!proxyHealth) {
        const { createProxyHealth } = require('./network/proxy-health');
        proxyHealth = createProxyHealth({
            sections: () => sessions.list().map(item => ({ id: item.id, ...net.view(item.id) })),
            check: async id => {
                const section = sessions.get(id);
                if (!section?.context) return null;
                return measureExitIp(section.context, { timeoutMs: 8000 });
            },
            recover: recoverSection,
            onHealthy: async (id, ip) => {
                if (!net.confirmHealth(id, ip)) await recoverSection(id);
            }
        });
    }
    return proxyHealth;
}
// Camoufox owns the fingerprint (user agent, headers, window size): PyRock
// injects no Chrome-style patches, because they would contradict it.
const sessions = createSessionManager({
    maxSessions: MAX_SESSIONS,
    async openPage(section) {
        const activeBrowser = await ensureBrowser();
        const assignment = await networkAssignment(section);
        if (assignment && !assignment.provider) throw noExit(assignment);
        const pageOptions = { section, onPopup: popup => sessions.adopt(section, popup) };
        if (assignment) {
            pageOptions.proxy = assignment.proxy;
            pageOptions.storageState = section.snapshot?.storageState || undefined;
        }
        let opened;
        try { opened = await engine.openPage(activeBrowser, pageOptions); }
        catch (error) { network?.release(section.id); throw error; }
        const health = ensureProxyHealth();
        if (health) {
            opened.page.on?.('requestfailed', request => {
                const failure = request?.failure?.();
                const message = failure?.errorText || request?.errorText || '';
                health.notifyFailure(section.id, message);
            });
        }
        if (shuttingDown || browser !== activeBrowser) {
            try { await engine.closeContext(opened.context); } catch (closeError) { shutdownCleanupError ||= closeError; }
            network?.release(section.id);
            throw Object.assign(new Error('Browser unavailable'), { status: 503 });
        }
        return opened;
    },
    closeContext: context => engine.closeContext(context),
    createController: section => createScreencastController({ getPage: () => section.page }),
    // A closed section gives back its exit and stops any recovery in progress.
    onClosed: section => { stopRecovery(section.id); network?.forget(section.id); }
});
async function initBrowser() {
    try {
        // Validate hybrid settings before launching the browser. A typo in the
        // loopback pool URL or timeout must not silently permit direct traffic.
        ensureNetwork();
        return await serializeMutation(async () => {
            if (shuttingDown) return false;
            if (browser) {
                const previousBrowser = browser;
                browser = null;
                try { await previousBrowser.close(); } catch (error) { log.warn('Error cerrando navegador:', error.message); }
            }
            await ensureBrowser();
            if (!sessions.getDefault()) await sessions.create();
            else await sessions.restartAll();
            ensureProxyHealth()?.start();
            return true;
        });
    } catch (error) { log.error(`Error iniciando navegador: ${error.message}`); return false; }
}
function getSection(id) {
    const section = id ? sessions.get(id) : sessions.getDefault();
    if (!section) throw Object.assign(new Error('Sección no encontrada'), { status: 404, sectionMissing: true });
    // While the exit is being replaced the section has no page: say so instead of failing obscurely.
    if (section.recovering) throw Object.assign(new Error('La sección está cambiando de salida de red; reintentá en unos segundos'), { status: 503 });
    return section;
}
async function navigateToUrl(url, section, retryCount = 0) {
    const maxRetries = 3, retryDelay = Math.pow(2, retryCount) * 1000;
    try {
        if (!section?.page || section.state !== 'ready') throw new Error('Navegador no inicializado');
        log.info(`Navegando a: ${url}${retryCount ? ` (intento ${retryCount + 1}/${maxRetries + 1})` : ''}`);
        const response = await section.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        if (response) {
            const status = response.status(); log.info(`Respuesta HTTP: ${status}`);
            if (status >= 400) {
                const message = `HTTP ${status}: ${response.statusText()}`;
                if ([503,502,504,429,408].includes(status) && retryCount < maxRetries) { await new Promise(resolve => setTimeout(resolve, retryDelay)); return navigateToUrl(url, section, retryCount + 1); }
                if (status === 503) throw new Error(`${message} - El sitio web está temporalmente no disponible o bloqueando bots`);
                if (status === 403) throw new Error(`${message} - Acceso denegado, posible detección de bot`);
                if (status === 429) throw new Error(`${message} - Demasiadas solicitudes, el sitio está limitando el acceso`);
                throw new Error(message);
            }
        }
        // A preview can be blank while the request "succeeded"; report what the page
        // actually did so the cause is in the log, not in a guess.
        // "domcontentloaded" only means the HTML arrived: a single-page app can
        // take minutes to hydrate, and reporting that as a success left the
        // operator with a blank preview and no explanation.
        const settleTimeout = Number(process.env.PYROCK_SETTLE_TIMEOUT_MS) >= 0
            ? Number(process.env.PYROCK_SETTLE_TIMEOUT_MS)
            : 20000;
        const deadline = Date.now() + settleTimeout;
        let diagnosis = await diagnosePage(section.page);
        let settled = diagnosis.readyState === 'complete' && diagnosis.textLength > 0;
        while (!settled && Date.now() < deadline) {
            await sleep(500);
            diagnosis = await diagnosePage(section.page);
            settled = diagnosis.readyState === 'complete' && diagnosis.textLength > 0;
        }
        log.info('Estado de la página:', JSON.stringify(diagnosis));
        // La sección guarda el estado para que el panel pueda refrescarlo solo.
        section.diagnosis = diagnosis;
        return {
            success: true,
            message: settled ? 'Navegación exitosa' : 'La página todavía no termina de cargar',
            status: response?.status(),
            diagnosis,
            settled,
            previewMode: section.page.previewMode?.() || null
        };
    } catch (error) {
        const message = error.message;
        const retryable = ['Navigation timeout','net::ERR_CONNECTION_REFUSED','net::ERR_CONNECTION_RESET','net::ERR_NETWORK_CHANGED','Target closed'].some(item => message.includes(item));
        if (retryable && retryCount < maxRetries) { await new Promise(resolve => setTimeout(resolve, retryDelay)); return navigateToUrl(url, section, retryCount + 1); }
        if (message.includes('Target closed') || message.includes('Protocol error')) {
            if (!browser) await initBrowser(); else await serializeMutation(() => sessions.restart(section.id));
        }
        return { success: false, error: message, retries: retryCount, suggestion: message.includes('timeout') ? 'Timeout de conexión. Verifica la URL o intenta con un sitio más rápido.' : 'Error de navegación. Verifica la URL e intenta nuevamente.' };
    }
}
function takeScreenshot(section) {
    return section.page.screenshot({ encoding: 'base64', quality: 60, type: 'jpeg' }).then(screenshot => {
        section.lastScreenshot = `data:image/jpeg;base64,${screenshot}`;
        return { success: true, screenshot: section.lastScreenshot };
    }).catch(error => ({ success: false, error: error.message }));
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Última posición del cursor por sección: de donde parte la trayectoria humanizada.
const lastCursorBySection = new Map();

async function clickAt(x, y, section, { humanize = true } = {}) {
    try {
        if (humanize && !engine.humanizesCursor) {
            // Lección de Camoufox: un clic es un teletransporte detectable; una mano
            // camina hasta el punto con timing real (incluidas vacilaciones).
            // Camoufox humaniza el cursor por launch, no por petición, así que aquí
            // se usa el generador de PyRock (cursory-js) y `humanize: false` funciona.
            // El puntero virtual arranca en el origen: esa posición es conocida, así que
            // el primer clic también camina en lugar de teletransportarse.
            const from = lastCursorBySection.get(section.id) || [0, 0];
            const { steps, trailingDelayMs } = generateHumanPath(from, [x, y]);
            for (const step of steps) {
                if (step.delayMs > 0) await sleep(step.delayMs);
                await section.page.mouse.move(step.x, step.y);
            }
            if (trailingDelayMs > 0) await sleep(trailingDelayMs);
        }
        await section.page.mouse.click(x, y);
        lastCursorBySection.set(section.id, [x, y]);
        return { success: true, message: `Click en (${x}, ${y})${humanize ? ' (humanizado)' : ''}` };
    } catch (error) { return { success: false, error: error.message }; }
}
async function typeText(text, section, { humanize = true } = {}) {
    try {
        if (humanize) {
            const delays = typeDelays(text);
            let i = 0;
            for (const ch of text) {
                await section.page.keyboard.type(ch);
                const delay = delays[i++] || 0;
                if (delay > 0) await sleep(delay);
            }
        } else {
            await section.page.keyboard.type(text);
        }
        return { success: true, message: `Texto escrito: ${text}` };
    } catch (error) { return { success: false, error: error.message }; }
}
async function pressKey(key, section) { try { await section.page.keyboard.press(key); return { success: true, message: `Tecla presionada: ${key}` }; } catch (error) { return { success: false, error: error.message }; } }
const app = express();
const server = http.createServer(app);
const previewWss = new WebSocket.Server({ noServer: true, perMessageDeflate: false, maxPayload: 1024 });
function previewUpgradeAllowed(request) {
    if (!request?.headers) return false;
    let pathname; try { pathname = new URL(request.url, 'http://localhost').pathname; } catch { return false; }
    if (pathname !== '/ws/preview') return false;
    const { host, origin } = request.headers;
    if (typeof host !== 'string' || !host || typeof origin !== 'string' || !origin) return false;
    try { const parsed = new URL(origin); return ['http:','https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash && parsed.host.toLowerCase() === host.toLowerCase(); } catch { return false; }
}
server.previewUpgradeAllowed = previewUpgradeAllowed;
server.on('upgrade', (request, socket, head) => {
    if (!previewUpgradeAllowed(request)) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    previewWss.handleUpgrade(request, socket, head, ws => previewWss.emit('connection', ws, request));
});
previewWss.on('connection', (socket, request) => {
    let id;
    try { id = new URL(request.url, 'http://localhost').searchParams.get('session'); } catch {}
    const section = id ? sessions.get(id) : sessions.getDefault();
    if (!section) { socket.send(JSON.stringify({ type: 'status', state: 'unavailable', message: 'Sección no encontrada' })); socket.close(4404, 'Sección no encontrada'); return; }
    section.controller.addViewer(socket);
});
const publicDirectory = path.join(__dirname, '..', 'public');
app.use(express.static(publicDirectory));
app.get('/', (_req, res) => res.sendFile(path.join(publicDirectory, 'index.html')));
app.get('/health', (_req, res) => {
    let networkState = null;
    try {
        const net = ensureNetwork();
        if (net) {
            const summary = net.summary();
            const states = sessions.list().map(section => net.view(section.id));
            networkState = {
                ...summary,
                waiting: states.filter(item => item.state === 'waiting').length,
                connected: states.filter(item => item.state === 'connected').length
            };
        }
    } catch (error) {
        networkState = { mode: 'hybrid', status: 'misconfigured', error: error.message };
    }
    res.json({ status: 'ok', browser: browser ? 'connected' : 'disconnected', network: networkState, timestamp: new Date().toISOString() });
});
app.use(express.json());
function apiError(res, error) {
    const status = error.status || 500;
    res.status(status).json({ success: false, error: error.sectionMissing ? 'Sección no encontrada' : error.message });
}
function routeSection(req) { return getSection(req.method === 'GET' ? req.query.session : req.body?.session); }
app.get('/api/sessions', (_req, res) => res.json({ success: true, sessions: sessions.list(), default: sessions.getDefault()?.id || null, max: MAX_SESSIONS }));

// Última IP medida por sección: id de sección -> { ip, at, history: [{ ip, at }] }
const measuredIps = new Map();

// Cómo sale el navegador y qué IP usa cada sección. Con proxy rotativo la IP
// cambia en cada petición: lo que se muestra es siempre una foto con su hora.
function networkOverview() {
    const net = ensureNetwork();
    if (net) {
        const summary = net.summary();
        const byId = new Map(sessions.list().map(section => [section.id, section]));
        return {
            configured: true, host: null, port: null, mode: 'hybrid', stickyBase: null,
            credentials: null, pool: summary.pool, freeDeadlineMs: summary.freeDeadlineMs,
            fallbackConfigured: summary.fallbackConfigured,
            sections: [...byId].map(([id, section]) => {
                const state = net.view(id);
                const connected = state.state === 'connected';
                let port = null;
                try { port = connected ? Number(new URL(state.proxy).port) || null : null; } catch {}
                return {
                    id, name: section.name, proxy: connected ? state.proxy : null, port,
                    ip: connected ? state.ip : null, measuredAt: connected ? state.since : null,
                    measurementError: state.state === 'waiting' ? state.reason : null,
                    ipCount: connected ? 1 : 0, provider: connected ? state.provider : null,
                    state: state.state, reason: state.reason, freeReason: state.freeReason,
                    reconnects: state.reconnects, freeSearch: state.freeSearch
                };
            })
        };
    }
    const template = parseProxyTemplate(process.env.PYROCK_PROXY);
    const base = stickyBase();
    let mode = 'none';
    if (base) mode = 'sticky';
    else if (template) mode = 'rotating';
    // Sin credenciales: la contraseña de la proxy no sale en la API.
    const shared = template ? buildProxyUrl(template, template.port) : null;
    return {
        configured: !!template,
        host: template ? template.host : null,
        port: template ? template.port : null,
        mode,
        stickyBase: base,
        credentials: template && template.username ? `${template.username}:${'•'.repeat(8)}` : null,
        sections: sessions.list().map(section => {
            const proxy = sectionProxy(section.id);
            const measurement = measuredIps.get(section.id) || null;
            const history = measurement ? measurement.history : [];
            const server = proxy ? proxy.server : shared;
            let port = null;
            if (proxy) port = proxyPort(proxy.server);
            else if (template && template.port) port = Number(template.port);
            return {
                id: section.id,
                name: section.name,
                proxy: server ? proxyLabel(server) : null,
                port,
                ip: measurement ? measurement.ip : null,
                measuredAt: measurement ? measurement.at : null,
                measurementError: measurement?.error || null,
                // Cuántas IPs distintas se han visto: con proxy rotativo son varias
                // por sección, y eso en sí mismo es información.
                ipCount: new Set(history.map(entry => entry.ip)).size
            };
        })
    };
}
app.get('/api/network', (_req, res) => res.json(networkOverview()));
app.post('/api/network/measure', async (req, res) => {
    try {
        if (ensureNetwork()) {
            const health = ensureProxyHealth();
            if (req.body?.session) await health?.checkNow(req.body.session);
            else await health?.checkAll();
            return res.json(networkOverview());
        }
        const wanted = req.body?.session ? [req.body.session] : sessions.list().map(section => section.id);
        for (const id of wanted) {
            const section = sessions.get(id);
            if (!section?.page) continue;
            try {
                const ip = await measureExitIp(section.context);
                if (ip) {
                    const previous = measuredIps.get(id) || { history: [] };
                    const at = new Date().toISOString();
                    measuredIps.set(id, {
                        ip,
                        at,
                        history: [...previous.history, { ip, at }].slice(-5)
                    });
                }
            } catch {
                const previous = measuredIps.get(id) || { ip: null, at: null, history: [] };
                measuredIps.set(id, { ...previous, error: 'No se pudo medir la IP; intentá nuevamente.' });
            }
        }
        res.json(networkOverview());
    } catch (error) { apiError(res, error); }
});
app.post('/api/sessions', async (req, res) => {
    let reserved = null;
    try {
        if (shuttingDown) throw Object.assign(new Error('Browser unavailable'), { status: 503 });
        if (!browser) await serializeMutation(() => ensureBrowser());
        const net = ensureNetwork();
        if (net) {
            // Looking for an exit can take a minute: do it before taking the shared queue.
            const id = sessions.peekNextId();
            const assignment = await net.assign(id, { isCancelled: () => shuttingDown });
            if (!assignment.provider) throw noExit(assignment);
            preassigned.set(id, assignment);
            reserved = id;
        }
        const section = await serializeMutation(() => sessions.create(req.body || {}));
        res.status(201).json({ success: true, session: sessions.list().find(item => item.id === section.id) });
    } catch (error) { apiError(res, error); }
    finally {
        // An exit that was found but never used (invalid name, limit reached) goes back.
        if (reserved && preassigned.delete(reserved)) network?.release(reserved);
    }
});
app.delete('/api/sessions/:id', async (req, res) => {
    try { await serializeMutation(() => sessions.close(req.params.id)); res.json({ success: true }); } catch (error) { apiError(res, error); }
});
app.get('/api/status', (req, res) => {
    try { const section = routeSection(req); res.json({ success: true, browser: browser ? 'connected' : 'disconnected', engine: engine.name, browserReady: !!section.page && section.state === 'ready', lastAction, timestamp: new Date().toISOString() }); }
    catch (error) { apiError(res, error); }
});
app.post('/api/navigate', async (req, res) => {
    try { const section = routeSection(req); const { url } = req.body; if (!url) return res.status(400).json({ success: false, error: 'URL requerida' }); const result = await navigateToUrl(url, section); lastAction = { type: 'navigate', result, timestamp: Date.now() }; res.json(result); }
    catch (error) { apiError(res, error); }
});
app.post('/api/screenshot', async (req, res) => { try { const result = await takeScreenshot(routeSection(req)); lastAction = { type: 'screenshot', result, timestamp: Date.now() }; res.json(result); } catch (error) { apiError(res, error); } });
app.get('/api/screenshot', (req, res) => { try { const screenshot = routeSection(req).lastScreenshot; res.json(screenshot ? { success: true, screenshot } : { success: false, error: 'No hay screenshot disponible' }); } catch (error) { apiError(res, error); } });
app.post('/api/click', async (req, res) => { try { const section = routeSection(req); const { x, y, humanize } = req.body; if (x === undefined || y === undefined) return res.status(400).json({ success: false, error: 'Coordenadas x, y requeridas' }); const result = await clickAt(x, y, section, { humanize: humanize !== false }); lastAction = { type: 'click', result, timestamp: Date.now() }; res.json(result); } catch (error) { apiError(res, error); } });
app.post('/api/type', async (req, res) => { try { const section = routeSection(req); const { text, humanize } = req.body; if (!text) return res.status(400).json({ success: false, error: 'Texto requerido' }); const result = await typeText(text, section, { humanize: humanize !== false }); lastAction = { type: 'type', result, timestamp: Date.now() }; res.json(result); } catch (error) { apiError(res, error); } });
app.post('/api/key', async (req, res) => { try { const section = routeSection(req); const { key } = req.body; if (!key) return res.status(400).json({ success: false, error: 'Tecla requerida' }); const result = await pressKey(key, section); lastAction = { type: 'key', result, timestamp: Date.now() }; res.json(result); } catch (error) { apiError(res, error); } });
app.post('/api/init', async (req, res) => {
    try {
        if (shuttingDown) return res.json({ success: false, message: 'Error inicializando navegador' });
        let result;
        if (req.body?.session) result = await serializeMutation(async () => { await sessions.restart(req.body.session); return true; });
        else result = await initBrowser();
        lastAction = { type: 'init', result: { success: result }, timestamp: Date.now() };
        res.json({ success: result, message: result ? 'Navegador inicializado' : 'Error inicializando navegador' });
    } catch (error) { apiError(res, error); }
});
let startPromise = null, stopPromise = null;
async function startServer({ port = PORT, host = '0.0.0.0' } = {}) {
    if (shuttingDown) throw new Error('Server is shutting down');
    if (server.listening) return server;
    if (startPromise) return startPromise;
    startPromise = (async () => {
        const browserReady = await initBrowser();
        if (shuttingDown) throw new Error('Server is shutting down');
        if (!browserReady) log.error('No se pudo inicializar el navegador');
        await new Promise((resolve, reject) => { const onError = error => { server.off('listening', onListening); reject(error); }; const onListening = () => { server.off('error', onError); resolve(); }; server.once('error', onError); server.once('listening', onListening); server.listen(port, host); });
        log.info(`🚀 Servidor PyRock ejecutándose en puerto ${server.address().port}`); log.info(`📱 Interfaz web: http://localhost:${server.address().port}`); log.info(`🌐 Navegador: ${browserReady ? 'Listo' : 'Error'}`); return server;
    })();
    try { return await startPromise; } finally { startPromise = null; }
}
async function stopServer() {
    if (stopPromise) return stopPromise;
    shuttingDown = true;
    stopPromise = (async () => {
        let error = null;
        for (const id of recoveries.keys()) stopRecovery(id);
        for (const section of sessions.list()) { try { await sessions.get(section.id).controller.close(); } catch (cause) { error ||= cause; } }
        for (const socket of previewWss.clients) { try { socket.close(1001, 'Server shutting down'); } catch {} socket.terminate(); }
        await new Promise(resolve => previewWss.close(() => resolve()));
        await mutationQueue;
        try { await sessions.closeAll(); } catch (cause) { error ||= cause; }
        error ||= shutdownCleanupError;
        if (browser) { const activeBrowser = browser; browser = null; try { await activeBrowser.close(); } catch (cause) { error ||= cause; } }
        if (server.listening) await new Promise(resolve => server.close(resolve));
        if (error) throw error;
    })();
    return stopPromise;
}
process.on('SIGINT', async () => { log.info('Cerrando servidor...'); await stopServer(); process.exit(0); });
process.on('SIGTERM', async () => { log.info('Cerrando servidor...'); await stopServer(); process.exit(0); });
module.exports = { startServer, stopServer, app, server, previewUpgradeAllowed, networkControl };
if (require.main === module) startServer().catch(error => { log.error(`Error iniciando servidor: ${error.message}`); process.exit(1); });
