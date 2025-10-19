/**
 * PyRock - Servidor Simplificado
 * Basado en el ejemplo de Python para máxima estabilidad
 */

// Cargar variables de entorno
require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
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

    // En Docker Alpine, usar Chromium
    if (IS_PRODUCTION) {
        config.executablePath = '/usr/bin/chromium-browser';
    }

    return config;
}

/**
 * Inicializar navegador (como fetch_html en Python)
 */
async function initBrowser() {
    try {
        if (browser) {
            await browser.close();
        }
        
        log.info('Iniciando navegador...');
        browser = await puppeteer.launch(getBrowserConfig());
        page = await browser.newPage();
        
        // Configuración básica
        await page.setViewport({ width: 1280, height: 720 });
        
        log.info('✅ Navegador iniciado correctamente');
        return true;
    } catch (error) {
        log.error(`Error iniciando navegador: ${error.message}`);
        return false;
    }
}

/**
 * Navegar a URL
 */
async function navigateToUrl(url) {
    try {
        if (!page) {
            throw new Error('Navegador no inicializado');
        }
        
        log.info(`Navegando a: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
        return { success: true, message: 'Navegación exitosa' };
    } catch (error) {
        log.error(`Error navegando: ${error.message}`);
        return { success: false, error: error.message };
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

// Crear servidor WebSocket
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    log.info('Cliente WebSocket conectado');
    
    // Enviar estado inicial
    ws.send(JSON.stringify({
        type: 'status',
        message: 'Conectado al servidor PyRock',
        browserReady: !!browser
    }));
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            await handleWebSocketMessage(ws, data);
        } catch (error) {
            log.error(`Error procesando mensaje WebSocket: ${error.message}`);
            ws.send(JSON.stringify({
                type: 'error',
                message: error.message
            }));
        }
    });
    
    ws.on('close', () => {
        log.info('Cliente WebSocket desconectado');
    });
});

/**
 * Manejar mensajes WebSocket
 */
async function handleWebSocketMessage(ws, data) {
    const { type, payload } = data;
    
    switch (type) {
        case 'navigate':
            const navResult = await navigateToUrl(payload.url);
            ws.send(JSON.stringify({
                type: 'navigate_result',
                ...navResult
            }));
            break;
            
        case 'screenshot':
            const screenshotResult = await takeScreenshot();
            ws.send(JSON.stringify({
                type: 'screenshot_result',
                ...screenshotResult
            }));
            break;
            
        case 'click':
            const clickResult = await clickAt(payload.x, payload.y);
            ws.send(JSON.stringify({
                type: 'click_result',
                ...clickResult
            }));
            break;
            
        case 'type':
            const typeResult = await typeText(payload.text);
            ws.send(JSON.stringify({
                type: 'type_result',
                ...typeResult
            }));
            break;
            
        default:
            ws.send(JSON.stringify({
                type: 'error',
                message: `Comando no reconocido: ${type}`
            }));
    }
}

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