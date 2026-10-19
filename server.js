'use strict';
require('dotenv').config();
const express = require('express');
const http = require('http');
const puppeteer = require('puppeteer');
const path = require('path');
const WebSocket = require('ws');
const { createScreencastController } = require('./screencast');
const { createSessionManager } = require('./sessions');
const { generateHumanPath, typeDelays } = require('./humanize');
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
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
function getBrowserConfig() {
    const config = { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] };
    if (IS_PRODUCTION) config.executablePath = '/usr/bin/chromium-browser';
    return config;
}
function serializeMutation(operation) {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.catch(() => {});
    return result;
}
async function ensureBrowser() {
    if (shuttingDown) throw Object.assign(new Error('Server is shutting down'), { status: 503 });
    if (browser) return browser;
    const launched = await puppeteer.launch(getBrowserConfig());
    if (shuttingDown) { await launched.close(); throw Object.assign(new Error('Server is shutting down'), { status: 503 }); }
    browser = launched;
    launched.once?.('disconnected', () => {
        if (browser !== launched) return;
        browser = null;
        sessions.markUnavailable('Browser disconnected');
    });
    return launched;
}
async function configurePage(page) {
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8', 'Accept-Encoding': 'gzip, deflate, br', 'DNT': '1',
        'Connection': 'keep-alive', 'Upgrade-Insecure-Requests': '1', 'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Cache-Control': 'max-age=0'
    });
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['es-ES', 'es', 'en'] });
        window.chrome = { runtime: {} };
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = parameters => parameters.name === 'notifications' ? Promise.resolve({ state: 'granted' }) : originalQuery(parameters);
    });
}
const sessions = createSessionManager({
    maxSessions: MAX_SESSIONS,
    async openPage() {
        const activeBrowser = await ensureBrowser();
        const context = await activeBrowser.createBrowserContext();
        try {
            if (shuttingDown) throw Object.assign(new Error('Server is shutting down'), { status: 503 });
            const page = await context.newPage();
            await configurePage(page);
            if (shuttingDown || browser !== activeBrowser) throw Object.assign(new Error('Browser unavailable'), { status: 503 });
            return { context, page };
        } catch (error) {
            try { await context.close(); } catch (closeError) { shutdownCleanupError ||= closeError; }
            throw error;
        }
    },
    closeContext: context => context.close(),
    createController: section => createScreencastController({ getPage: () => section.page })
});
async function initBrowser() {
    try {
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
            return true;
        });
    } catch (error) { log.error(`Error iniciando navegador: ${error.message}`); return false; }
}
function getSection(id) {
    const section = id ? sessions.get(id) : sessions.getDefault();
    if (!section) throw Object.assign(new Error('Sección no encontrada'), { status: 404, sectionMissing: true });
    return section;
}
async function navigateToUrl(url, section, retryCount = 0) {
    const maxRetries = 3, retryDelay = Math.pow(2, retryCount) * 1000;
    try {
        if (!section?.page || section.state !== 'ready') throw new Error('Navegador no inicializado');
        log.info(`Navegando a: ${url}${retryCount ? ` (intento ${retryCount + 1}/${maxRetries + 1})` : ''}`);
        await section.page.setExtraHTTPHeaders({ 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8', 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8', 'Accept-Encoding': 'gzip, deflate, br', 'DNT': '1', 'Connection': 'keep-alive', 'Upgrade-Insecure-Requests': '1' });
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
        return { success: true, message: 'Navegación exitosa', status: response?.status() };
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
        if (humanize) {
            // Lección de Camoufox: un clic es un teletransporte detectable; una mano
            // camina hasta el punto con timing real (incluidas vacilaciones).
            const from = lastCursorBySection.get(section.id) || null;
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
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (_req, res) => res.json({ status: 'ok', browser: browser ? 'connected' : 'disconnected', timestamp: new Date().toISOString() }));
app.use(express.json());
function apiError(res, error) {
    const status = error.status || 500;
    res.status(status).json({ success: false, error: error.sectionMissing ? 'Sección no encontrada' : error.message });
}
function routeSection(req) { return getSection(req.method === 'GET' ? req.query.session : req.body?.session); }
app.get('/api/sessions', (_req, res) => res.json({ success: true, sessions: sessions.list(), default: sessions.getDefault()?.id || null, max: MAX_SESSIONS }));
app.post('/api/sessions', async (req, res) => {
    try {
        if (shuttingDown) throw Object.assign(new Error('Browser unavailable'), { status: 503 });
        if (!browser) await serializeMutation(() => ensureBrowser());
        const section = await serializeMutation(() => sessions.create(req.body || {}));
        res.status(201).json({ success: true, session: sessions.list().find(item => item.id === section.id) });
    } catch (error) { apiError(res, error); }
});
app.delete('/api/sessions/:id', async (req, res) => {
    try { await serializeMutation(() => sessions.close(req.params.id)); res.json({ success: true }); } catch (error) { apiError(res, error); }
});
app.get('/api/status', (req, res) => {
    try { const section = routeSection(req); res.json({ success: true, browser: browser ? 'connected' : 'disconnected', browserReady: !!section.page && section.state === 'ready', lastAction, timestamp: new Date().toISOString() }); }
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
module.exports = { startServer, stopServer, app, server, previewUpgradeAllowed };
if (require.main === module) startServer().catch(error => { log.error(`Error iniciando servidor: ${error.message}`); process.exit(1); });
