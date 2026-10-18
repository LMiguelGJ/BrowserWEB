/**
 * PyRock - Servidor Simplificado
 * Basado en el ejemplo de Python para máxima estabilidad
 */

// Cargar variables de entorno
require('dotenv').config();

const express = require('express');
const http = require('http');
const puppeteer = require('puppeteer');
const path = require('path');
const WebSocket = require('ws');
const { createScreencastController } = require('./screencast');

// Configuración
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Variables globales
let browser = null;
let page = null;
let previewController = null;
let initQueue = Promise.resolve();
let shuttingDown = false;
let shutdownCleanupError = null;

// Logger simple
const log = {
    info: (...args) => console.log(`[${new Date().toLocaleTimeString()}]`, ...args),
    warn: (...args) => console.warn(`[${new Date().toLocaleTimeString()}] WARN:`, ...args),
    error: (...args) => console.error(`[${new Date().toLocaleTimeString()}] ERROR:`, ...args)
};

/**
 * Configuración del navegador (simplificada como Python)
 */
function getBrowserConfig() {
    const config = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    };

    // En Docker Alpine, usar Chromium
    if (IS_PRODUCTION) {
        config.executablePath = '/usr/bin/chromium-browser';
    }

    return config;
}

/**
 * Inicializar navegador (como fetch_html en Python)
 */
function initBrowser() {
    if (shuttingDown) return Promise.resolve(false);
    const result = initQueue.then(initBrowserOnce, initBrowserOnce);
    initQueue = result.catch(() => {});
    return result;
}

async function initBrowserOnce() {
    try {
        if (shuttingDown) return false;
        if (previewController) await previewController.setUnavailable('Browser is restarting');
        if (shuttingDown) return false;
        if (browser) {
            const previousBrowser = browser;
            try {
                await previousBrowser.close();
            } catch (err) {
                log.error('Error cerrando navegador:', err);
            }
            if (browser === previousBrowser) {
                browser = null;
                page = null;
            }
        }
        if (shuttingDown) return false;
        log.info('Iniciando navegador...');
        const launchedBrowser = await puppeteer.launch(getBrowserConfig());
        if (shuttingDown) {
            try { await launchedBrowser.close(); }
            catch (error) {
                shutdownCleanupError ||= error;
                log.error('Error cerrando navegador iniciado durante shutdown:', error.message);
            }
            return false;
        }
        browser = launchedBrowser;
        page = await launchedBrowser.newPage();
        
        // Configuración avanzada para evitar detección de bots
        await page.setViewport({ width: 1366, height: 768 }); // Resolución más común
        
        // User-Agent más actualizado y realista
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Headers completos para simular navegador real
        await page.setExtraHTTPHeaders({
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Cache-Control': 'max-age=0'
        });
        
        // Configuraciones adicionales para evitar detección
        await page.evaluateOnNewDocument(() => {
            // Eliminar propiedades que revelan automatización
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });
            
            // Simular plugins de navegador real
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5],
            });
            
            // Simular idiomas
            Object.defineProperty(navigator, 'languages', {
                get: () => ['es-ES', 'es', 'en'],
            });
            
            // Ocultar automatización de Chrome
            window.chrome = {
                runtime: {},
            };
            
            // Simular permisos
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: 'granted' }) :
                    originalQuery(parameters)
            );
        });
        
        if (shuttingDown) return false;
        const initializedBrowser = browser;
        const initializedPage = page;
        if (initializedBrowser && typeof initializedBrowser.once === 'function') {
            initializedBrowser.once('disconnected', () => {
                if (browser !== initializedBrowser) return;
                if (previewController) previewController.setUnavailable('Browser disconnected').catch(() => {});
                browser = null;
                page = null;
            });
        }
        if (initializedPage && typeof initializedPage.once === 'function') {
            initializedPage.once('close', () => {
                if (page !== initializedPage) return;
                if (previewController) previewController.setUnavailable('Browser page closed').catch(() => {});
            });
        }
        if (previewController) await previewController.setPage(initializedPage);
        log.info('✅ Navegador iniciado correctamente');
        return true;
    } catch (error) {
        if (previewController) await previewController.setUnavailable('Browser initialization failed').catch(() => {});
        log.error(`Error iniciando navegador: ${error.message}`);
        return false;
    }
}

/**
 * Navegar a URL con reintentos y manejo robusto de errores
 */
async function navigateToUrl(url, retryCount = 0) {
    const maxRetries = 3;
    const retryDelay = Math.pow(2, retryCount) * 1000; // Backoff exponencial
    
    try {
        if (!page) {
            throw new Error('Navegador no inicializado');
        }
        
        log.info(`Navegando a: ${url}${retryCount > 0 ? ` (intento ${retryCount + 1}/${maxRetries + 1})` : ''}`);
        
        // Configurar headers adicionales para evitar detección de bots
        await page.setExtraHTTPHeaders({
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
        });
        
        // Intentar navegación con timeout más largo
        const response = await page.goto(url, { 
            waitUntil: 'domcontentloaded', 
            timeout: 45000 
        });
        
        // Verificar código de estado HTTP
        if (response) {
            const status = response.status();
            log.info(`Respuesta HTTP: ${status}`);
            
            if (status >= 400) {
                const errorMsg = `HTTP ${status}: ${response.statusText()}`;
                
                // Errores temporales que pueden beneficiarse de reintentos
                if ([503, 502, 504, 429, 408].includes(status) && retryCount < maxRetries) {
                    log.warn(`${errorMsg} - Reintentando en ${retryDelay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    return await navigateToUrl(url, retryCount + 1);
                }
                
                // Errores específicos con mensajes informativos
                if (status === 503) {
                    throw new Error(`${errorMsg} - El sitio web está temporalmente no disponible o bloqueando bots`);
                } else if (status === 403) {
                    throw new Error(`${errorMsg} - Acceso denegado, posible detección de bot`);
                } else if (status === 429) {
                    throw new Error(`${errorMsg} - Demasiadas solicitudes, el sitio está limitando el acceso`);
                } else {
                    throw new Error(errorMsg);
                }
            }
        }
        
        log.info('✅ Navegación exitosa');
        return { success: true, message: 'Navegación exitosa', status: response?.status() };
        
    } catch (error) {
        const errorMsg = error.message;
        log.error(`Error navegando: ${errorMsg}`);
        
        // Errores de conexión que pueden beneficiarse de reintentos
        const retryableErrors = [
            'Navigation timeout',
            'net::ERR_CONNECTION_REFUSED',
            'net::ERR_CONNECTION_RESET',
            'net::ERR_NETWORK_CHANGED',
            'Target closed'
        ];
        
        const shouldRetry = retryableErrors.some(err => errorMsg.includes(err)) && retryCount < maxRetries;
        
        if (shouldRetry) {
            log.warn(`Error temporal detectado - Reintentando en ${retryDelay}ms...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            return await navigateToUrl(url, retryCount + 1);
        }
        
        // Reinicializar navegador en casos críticos
        if (errorMsg.includes('Target closed') || errorMsg.includes('Protocol error')) {
            log.warn('Reinicializando navegador debido a error crítico...');
            await initBrowser();
        }
        
        return { 
            success: false, 
            error: errorMsg,
            retries: retryCount,
            suggestion: getSuggestionForError(errorMsg)
        };
    }
}

/**
 * Obtener sugerencia basada en el tipo de error
 */
function getSuggestionForError(errorMsg) {
    if (errorMsg.includes('503')) {
        return 'El sitio puede estar bloqueando bots. Intenta con una URL diferente o espera unos minutos.';
    } else if (errorMsg.includes('403')) {
        return 'Acceso denegado. El sitio detectó el navegador automatizado.';
    } else if (errorMsg.includes('429')) {
        return 'Demasiadas solicitudes. Espera unos minutos antes de intentar nuevamente.';
    } else if (errorMsg.includes('timeout')) {
        return 'Timeout de conexión. Verifica la URL o intenta con un sitio más rápido.';
    }
    return 'Error de navegación. Verifica la URL e intenta nuevamente.';
}

/**
 * Tomar screenshot
 */
async function takeScreenshot() {
    try {
        if (!page) {
            throw new Error('Navegador no inicializado');
        }
        
        const screenshot = await page.screenshot({ 
            encoding: 'base64',
            quality: 60,
            type: 'jpeg'
        });
        
        return { success: true, screenshot: `data:image/jpeg;base64,${screenshot}` };
    } catch (error) {
        log.error(`Error tomando screenshot: ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * Click en coordenadas
 */
async function clickAt(x, y) {
    try {
        if (!page) {
            throw new Error('Navegador no inicializado');
        }
        
        await page.mouse.click(x, y);
        return { success: true, message: `Click en (${x}, ${y})` };
    } catch (error) {
        log.error(`Error haciendo click: ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * Escribir texto
 */
async function typeText(text) {
    try {
        if (!page) {
            throw new Error('Navegador no inicializado');
        }
        
        await page.keyboard.type(text);
        return { success: true, message: `Texto escrito: ${text}` };
    } catch (error) {
        log.error(`Error escribiendo texto: ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * Presionar tecla
 */
async function pressKey(key) {
    try {
        if (!page) {
            throw new Error('Navegador no inicializado');
        }
        
        await page.keyboard.press(key);
        return { success: true, message: `Tecla presionada: ${key}` };
    } catch (error) {
        log.error(`Error presionando tecla: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// Crear servidor Express
const app = express();
const server = http.createServer(app);
const previewWss = new WebSocket.Server({ noServer: true, perMessageDeflate: false, maxPayload: 1024 });
previewController = createScreencastController({ getPage: () => page });

function previewUpgradeAllowed(request) {
    if (!request || !request.headers) return false;
    let pathname;
    try { pathname = new URL(request.url, 'http://localhost').pathname; }
    catch { return false; }
    if (pathname !== '/ws/preview') return false;
    const host = request.headers.host;
    const origin = request.headers.origin;
    if (typeof host !== 'string' || !host || typeof origin !== 'string' || !origin) return false;
    try {
        const parsed = new URL(origin);
        return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash && parsed.host.toLowerCase() === host.toLowerCase();
    } catch {
        return false;
    }
}

server.previewUpgradeAllowed = previewUpgradeAllowed;
server.on('upgrade', (request, socket, head) => {
    if (!previewUpgradeAllowed(request)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
    }
    previewWss.handleUpgrade(request, socket, head, ws => {
        previewWss.emit('connection', ws, request);
    });
});
previewWss.on('connection', socket => previewController.addViewer(socket));

// Servir archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Ruta principal
app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/health', (_req, res) => {
    res.json({ 
        status: 'ok', 
        browser: browser ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString()
    });
});

// Middleware para JSON
app.use(express.json());

// Estado global para comunicación
let lastScreenshot = null;
let lastAction = { type: 'status', message: 'Servidor iniciado', timestamp: Date.now() };

// API Endpoints REST

// Estado del servidor y navegador
app.get('/api/status', (_req, res) => {
    res.json({
        success: true,
        browser: browser ? 'connected' : 'disconnected',
        browserReady: !!browser,
        lastAction: lastAction,
        timestamp: new Date().toISOString()
    });
});

// Navegar a URL
app.post('/api/navigate', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) {
            return res.status(400).json({ success: false, error: 'URL requerida' });
        }
        
        const result = await navigateToUrl(url);
        lastAction = { type: 'navigate', result, timestamp: Date.now() };
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Tomar screenshot
app.post('/api/screenshot', async (_req, res) => {
    try {
        const result = await takeScreenshot();
        if (result.success) {
            lastScreenshot = result.screenshot;
        }
        lastAction = { type: 'screenshot', result, timestamp: Date.now() };
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Obtener último screenshot
app.get('/api/screenshot', (_req, res) => {
    if (lastScreenshot) {
        res.json({ success: true, screenshot: lastScreenshot });
    } else {
        res.json({ success: false, error: 'No hay screenshot disponible' });
    }
});

// Click en coordenadas
app.post('/api/click', async (req, res) => {
    try {
        const { x, y } = req.body;
        if (x === undefined || y === undefined) {
            return res.status(400).json({ success: false, error: 'Coordenadas x, y requeridas' });
        }
        
        const result = await clickAt(x, y);
        lastAction = { type: 'click', result, timestamp: Date.now() };
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Escribir texto
app.post('/api/type', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) {
            return res.status(400).json({ success: false, error: 'Texto requerido' });
        }
        
        const result = await typeText(text);
        lastAction = { type: 'type', result, timestamp: Date.now() };
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Presionar tecla
app.post('/api/key', async (req, res) => {
    try {
        const { key } = req.body;
        if (!key) {
            return res.status(400).json({ success: false, error: 'Tecla requerida' });
        }
        
        const result = await pressKey(key);
        lastAction = { type: 'key', result, timestamp: Date.now() };
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Inicializar navegador
app.post('/api/init', async (_req, res) => {
    try {
        const result = await initBrowser();
        lastAction = { type: 'init', result: { success: result }, timestamp: Date.now() };
        res.json({ success: result, message: result ? 'Navegador inicializado' : 'Error inicializando navegador' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Iniciar servidor (como main() en Python)
 */
let startPromise = null;
let stopPromise = null;

async function startServer({ port = PORT, host = '0.0.0.0' } = {}) {
    if (shuttingDown) throw new Error('Server is shutting down');
    if (server.listening) return server;
    if (startPromise) return startPromise;
    startPromise = (async () => {
        const browserReady = await initBrowser();
        if (shuttingDown) throw new Error('Server is shutting down');
        if (!browserReady) log.error('No se pudo inicializar el navegador');
        await new Promise((resolve, reject) => {
            const onError = error => { server.off('listening', onListening); reject(error); };
            const onListening = () => { server.off('error', onError); resolve(); };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(port, host);
        });
        log.info(`🚀 Servidor PyRock ejecutándose en puerto ${server.address().port}`);
        log.info(`📱 Interfaz web: http://localhost:${server.address().port}`);
        log.info(`🌐 Navegador: ${browserReady ? 'Listo' : 'Error'}`);
        return server;
    })();
    try { return await startPromise; }
    finally { startPromise = null; }
}

async function stopServer() {
    if (stopPromise) return stopPromise;
    shuttingDown = true;
    stopPromise = (async () => {
        let shutdownError = null;
        try { await previewController.close(); }
        catch (error) { shutdownError = error; }
        for (const socket of previewWss.clients) {
            try { socket.close(1001, 'Server shutting down'); } catch {}
            socket.terminate();
        }
        await new Promise(resolve => previewWss.close(() => resolve()));
        await initQueue;
        shutdownError ||= shutdownCleanupError;
        if (browser) {
            const activeBrowser = browser;
            browser = null;
            page = null;
            try { await activeBrowser.close(); }
            catch (error) {
                log.warn('Error cerrando navegador:', error.message);
                shutdownError ||= error;
            }
        }
        if (server.listening) await new Promise(resolve => server.close(() => resolve()));
        if (shutdownError) throw shutdownError;
    })();
    return stopPromise;
}

process.on('SIGINT', async () => {
    log.info('Cerrando servidor...');
    await stopServer();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    log.info('Cerrando servidor...');
    await stopServer();
    process.exit(0);
});

module.exports = { startServer, stopServer, app, server, previewUpgradeAllowed };

if (require.main === module) {
    log.info('🚀 Iniciando PyRock simplificado...');
    startServer().catch(error => {
        log.error(`Error iniciando servidor: ${error.message}`);
        process.exit(1);
    });
}