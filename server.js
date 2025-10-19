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

// Configuración
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Variables globales
let browser = null;
let page = null;

// Logger simple
const log = {
    info: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`),
    error: (msg) => console.error(`[${new Date().toLocaleTimeString()}] ERROR: ${msg}`)
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
    // No forzar executablePath, dejar que Puppeteer use su Chromium
    return config;
}

/**
 * Inicializar navegador (como fetch_html en Python)
 */
async function initBrowser() {
    if (browser) {
        try {
            await browser.close();
        } catch (err) {
            _logger.error('Error cerrando navegador:', err);
        }
    }
    browser = await puppeteer.launch({ headless: true });
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' });
}

/**
 * Navegar a URL
 */
async function navigateToUrl(url) {
    if (!page) {
        await initBrowser();
    }
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return true;
    } catch (err) {
        _logger.error('Error navegando:', err);
        if (String(err).includes('Target closed') || String(err).includes('Navigation timeout')) {
            await initBrowser();
        }
        return false;
    }
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
            quality: 80,
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

// Servir archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Ruta principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
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
app.get('/api/status', (req, res) => {
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
app.post('/api/screenshot', async (req, res) => {
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
app.get('/api/screenshot', (req, res) => {
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
app.post('/api/init', async (req, res) => {
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
async function startServer() {
    try {
        // Inicializar navegador
        const browserReady = await initBrowser();
        if (!browserReady) {
            log.error('No se pudo inicializar el navegador');
        }
        
        // Iniciar servidor HTTP
        server.listen(PORT, '0.0.0.0', () => {
            log.info(`🚀 Servidor PyRock ejecutándose en puerto ${PORT}`);
            log.info(`📱 Interfaz web: http://localhost:${PORT}`);
            log.info(`🌐 Navegador: ${browserReady ? 'Listo' : 'Error'}`);
        });
        
    } catch (error) {
        log.error(`Error iniciando servidor: ${error.message}`);
        process.exit(1);
    }
}

// Manejo de cierre limpio
process.on('SIGINT', async () => {
    log.info('Cerrando servidor...');
    if (browser) {
        await browser.close();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    log.info('Cerrando servidor...');
    if (browser) {
        await browser.close();
    }
    process.exit(0);
});

// Iniciar aplicación
log.info('🚀 Iniciando PyRock simplificado...');
startServer();