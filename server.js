/**
 * PyRock - Versión Simplificada y Estable
 * Servidor Node.js con Puppeteer optimizado para estabilidad
 */

// Cargar variables de entorno
require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

// Configuración desde variables de entorno
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const BROWSER_TIMEOUT = parseInt(process.env.BROWSER_TIMEOUT) || 30000;
const SCREENSHOT_QUALITY = parseInt(process.env.SCREENSHOT_QUALITY) || 80;

// Variables globales
let browser = null;
let page = null;
let isInitialized = false;
let healthCheckInterval = null;
let lastHealthCheck = Date.now();

// Logger simple
const log = {
    info: (msg) => console.log(`ℹ️  ${msg}`),
    success: (msg) => console.log(`✅ ${msg}`),
    warning: (msg) => console.log(`⚠️  ${msg}`),
    error: (msg) => console.log(`❌ ${msg}`)
};

/**
 * Configuración optimizada de Puppeteer para Docker
 * Ejecuta siempre en segundo plano (headless) con configuración para contenedores
 */
function getBrowserConfig() {
    const config = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-extensions',
            '--disable-default-apps',
            '--disable-sync',
            '--disable-translate',
            '--hide-scrollbars',
            '--mute-audio',
            '--no-zygote',
            '--enable-automation'
        ]
    };

    // En Docker Alpine, usar Chromium
    if (process.env.NODE_ENV === 'production' || IS_PRODUCTION) {
        config.executablePath = '/usr/bin/chromium-browser';
    }

    return config;
}

/**
 * Limpiar completamente el navegador (cerrar todas las pestañas)
 */
async function cleanupBrowser() {
    try {
        if (browser) {
            log.info('Limpiando navegador - cerrando todas las pestañas...');
            
            // Obtener todas las páginas abiertas
            const pages = await browser.pages();
            
            // Cerrar todas las páginas excepto la primera (about:blank)
            for (let i = 1; i < pages.length; i++) {
                try {
                    await pages[i].close();
                } catch (error) {
                    log.warning(`Error cerrando página ${i}: ${error.message}`);
                }
            }
            
            // Cerrar el navegador completamente
            await browser.close();
            log.info('Navegador limpiado completamente');
        }
    } catch (error) {
        log.warning(`Error durante limpieza: ${error.message}`);
    } finally {
        // Detener monitoreo de salud
        stopBrowserHealthMonitoring();
        
        browser = null;
        page = null;
        isInitialized = false;
    }
}

/**
 * Inicializar navegador con recuperación automática
 */
async function initBrowser() {
    try {
        // Verificar si ya hay una instancia activa
        if (browser && !browser.process()?.killed) {
            log.info('Navegador ya está activo, cerrando pestañas adicionales...');
            
            // Cerrar pestañas adicionales, mantener solo una
            const pages = await browser.pages();
            for (let i = 1; i < pages.length; i++) {
                try {
                    await pages[i].close();
                } catch (error) {
                    log.warning(`Error cerrando pestaña adicional: ${error.message}`);
                }
            }
            
            // Usar la primera pestaña y navegar a example.com
            page = pages[0];
            await page.goto('https://example.com/');
            await page.setViewport({ width: 1280, height: 720 });
            
            isInitialized = true;
            log.success('Navegador reutilizado - pestañas adicionales cerradas');
            return true;
        }

        // Limpieza completa del navegador anterior
        await cleanupBrowser();

        log.info('Inicializando navegador...');
        
        browser = await puppeteer.launch(getBrowserConfig());
        page = await browser.newPage();
        
        // Configuración básica
        await page.setViewport({ width: 1280, height: 720 });
        await page.goto('https://example.com/');
        
        // Eventos de recuperación automática
        browser.on('disconnected', () => {
            if (isRecovering) {
                return; // Ya se está recuperando
            }
            
            log.warning('Navegador desconectado - iniciando recuperación automática...');
            isRecovering = true;
            isInitialized = false;
            browser = null;
            page = null;
            
            // Recuperación automática después de 2 segundos
            setTimeout(async () => {
                log.info('Intentando recuperación automática del navegador...');
                await initBrowser();
                isRecovering = false;
            }, 2000);
        });

        // Detectar errores de página
        page.on('error', (error) => {
            log.error(`Error en página: ${error.message}`);
        });

        page.on('pageerror', (error) => {
            log.error(`Error de página: ${error.message}`);
        });

        isInitialized = true;
        log.success('Navegador inicializado correctamente');
        
        // Iniciar monitoreo de salud
        startBrowserHealthMonitoring();
        
        return true;
        
    } catch (error) {
        log.error(`Error inicializando navegador: ${error.message}`);
        isInitialized = false;
        browser = null;
        page = null;
        
        // Reintentar automáticamente después de 5 segundos solo si no se está recuperando
        if (!isRecovering) {
            isRecovering = true;
            setTimeout(async () => {
                log.info('Reintentando inicialización del navegador...');
                await initBrowser();
                isRecovering = false;
            }, 5000);
        }
        
        return false;
    }
}

/**
 * Verificar si el navegador está activo
 */
function isBrowserReady() {
    return browser && page && isInitialized && !browser.process()?.killed;
}

/**
 * Verificar salud del navegador de forma profunda
 */
async function checkBrowserHealth() {
    try {
        if (!browser || !page) {
            return false;
        }

        // Verificar si el proceso del navegador sigue vivo
        if (browser.process()?.killed) {
            log.warning('Proceso del navegador terminado');
            return false;
        }

        // Intentar una operación simple para verificar que responde
        await page.evaluate(() => document.title);
        
        lastHealthCheck = Date.now();
        return true;
    } catch (error) {
        log.warning(`Fallo en verificación de salud: ${error.message}`);
        return false;
    }
}

// Variable para evitar múltiples recuperaciones simultáneas
let isRecovering = false;

/**
 * Iniciar monitoreo automático de salud del navegador
 */
function startBrowserHealthMonitoring() {
    // Limpiar monitoreo anterior si existe
    if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
    }

    healthCheckInterval = setInterval(async () => {
        if (!isBrowserReady() || isRecovering) {
            return; // No hay navegador para monitorear o ya se está recuperando
        }

        const isHealthy = await checkBrowserHealth();
        
        if (!isHealthy && !isRecovering) {
            log.warning('Navegador no saludable detectado - iniciando recuperación...');
            isRecovering = true;
            isInitialized = false;
            
            // Intentar recuperación automática
            setTimeout(async () => {
                log.info('Iniciando recuperación automática por monitoreo...');
                await initBrowser();
                isRecovering = false;
            }, 1000);
        }
    }, 10000); // Verificar cada 10 segundos

    log.info('Monitoreo de salud del navegador iniciado');
}

/**
 * Detener monitoreo de salud del navegador
 */
function stopBrowserHealthMonitoring() {
    if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
        log.info('Monitoreo de salud del navegador detenido');
    }
}

/**
 * Navegar a URL con recuperación automática
 */
async function navigateToUrl(url) {
    // Verificar si el navegador está disponible, si no, reinicializarlo
    if (!isBrowserReady()) {
        log.warning('Navegador no disponible - reinicializando...');
        const initSuccess = await initBrowser();
        if (!initSuccess) {
            throw new Error('No se pudo reinicializar el navegador');
        }
    }

    // Validar URL
    let targetUrl = url.trim();
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        targetUrl = 'https://' + targetUrl;
    }

    try {
        new URL(targetUrl);
    } catch (e) {
        throw new Error(`URL inválida: ${targetUrl}`);
    }

    log.info(`Navegando a: ${targetUrl}`);

    try {
        const response = await page.goto(targetUrl, { 
            waitUntil: 'domcontentloaded', 
            timeout: 30000 
        });
        
        if (!response) {
            throw new Error('No se recibió respuesta del servidor');
        }

        if (!response.ok()) {
            throw new Error(`HTTP ${response.status()}: ${response.statusText()}`);
        }

        const finalUrl = page.url();
        log.success(`Navegación exitosa a: ${finalUrl}`);
        
        return {
            success: true,
            url: finalUrl,
            status: response.status()
        };
        
    } catch (error) {
        log.error(`Error navegando a ${targetUrl}: ${error.message}`);
        
        // Si hay error de navegación, intentar reinicializar el navegador
        if (error.message.includes('Target closed') || 
            error.message.includes('Session closed') ||
            error.message.includes('Protocol error') ||
            error.message.includes('detached') || 
            error.message.includes('closed')) {
            log.warning('Error de sesión detectado - reinicializando navegador...');
            await initBrowser();
        }
        
        throw error;
    }
}

/**
 * Capturar screenshot y guardar como archivo estático
 */
async function takeScreenshot() {
    try {
        // Verificar si el navegador está disponible, si no, reinicializarlo
        if (!isBrowserReady()) {
            log.warning('Navegador no disponible para screenshot - reinicializando...');
            const initSuccess = await initBrowser();
            if (!initSuccess) {
                log.error('No se pudo reinicializar el navegador para screenshot');
                return false;
            }
        }

        const screenshotPath = path.join(__dirname, 'public', 'screenshot.png');
        
        await page.screenshot({
            path: screenshotPath,
            fullPage: false,
            type: 'png'
        });
        
        // Log eliminado para evitar spam en consola (se ejecuta cada 1 segundo)
        return true;
    } catch (error) {
        log.error(`Error capturando pantalla: ${error.message}`);
        
        // Si hay error de sesión, reinicializar navegador
        if (error.message.includes('Target closed') || 
            error.message.includes('Session closed') ||
            error.message.includes('Protocol error')) {
            log.warning('Error de sesión en screenshot - reinicializando navegador...');
            await initBrowser();
        }
        
        return false;
    }
}

/**
 * Hacer click en coordenadas específicas con recuperación automática
 */
async function clickAt(x, y) {
    try {
        // Verificar si el navegador está disponible, si no, reinicializarlo
        if (!isBrowserReady()) {
            log.warning('Navegador no disponible para click - reinicializando...');
            const initSuccess = await initBrowser();
            if (!initSuccess) {
                throw new Error('No se pudo reinicializar el navegador');
            }
        }

        await page.mouse.click(x, y);
        log.info(`Click realizado en (${x}, ${y})`);
        return true;
    } catch (error) {
        log.error(`Error haciendo click: ${error.message}`);
        
        // Si hay error de sesión, reinicializar navegador
        if (error.message.includes('Target closed') || 
            error.message.includes('Session closed') ||
            error.message.includes('Protocol error')) {
            log.warning('Error de sesión en click - reinicializando navegador...');
            await initBrowser();
        }
        
        return false;
    }
}

/**
 * Escribir texto en el elemento activo con recuperación automática
 */
async function typeText(text) {
    try {
        // Verificar si el navegador está disponible, si no, reinicializarlo
        if (!isBrowserReady()) {
            log.warning('Navegador no disponible para escribir - reinicializando...');
            const initSuccess = await initBrowser();
            if (!initSuccess) {
                throw new Error('No se pudo reinicializar el navegador');
            }
        }

        await page.keyboard.type(text);
        log.info(`Texto escrito: "${text}"`);
        return true;
    } catch (error) {
        log.error(`Error escribiendo texto: ${error.message}`);
        
        // Si hay error de sesión, reinicializar navegador
        if (error.message.includes('Target closed') || 
            error.message.includes('Session closed') ||
            error.message.includes('Protocol error')) {
            log.warning('Error de sesión escribiendo - reinicializando navegador...');
            await initBrowser();
        }
        
        return false;
    }
}

/**
 * Presionar tecla especial con recuperación automática
 */
async function pressKey(key) {
    try {
        // Verificar si el navegador está disponible, si no, reinicializarlo
        if (!isBrowserReady()) {
            log.warning('Navegador no disponible para tecla - reinicializando...');
            const initSuccess = await initBrowser();
            if (!initSuccess) {
                throw new Error('No se pudo reinicializar el navegador');
            }
        }

        await page.keyboard.press(key);
        log.info(`Tecla presionada: ${key}`);
        return true;
    } catch (error) {
        log.error(`Error presionando tecla: ${error.message}`);
        
        // Si hay error de sesión, reinicializar navegador
        if (error.message.includes('Target closed') || 
            error.message.includes('Session closed') ||
            error.message.includes('Protocol error')) {
            log.warning('Error de sesión con tecla - reinicializando navegador...');
            await initBrowser();
        }
        
        return false;
    }
}

// Configurar Express
const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        browser: isBrowserReady(),
        timestamp: new Date().toISOString()
    });
});

// Configurar WebSocket
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    log.info('Nueva conexión WebSocket');

    // Enviar estado inicial
    ws.send(JSON.stringify({
        type: 'status',
        message: 'Conectado a PyRock',
        browserReady: isBrowserReady()
    }));

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            await handleWebSocketMessage(ws, data);
        } catch (error) {
            log.error(`Error procesando mensaje: ${error.message}`);
            ws.send(JSON.stringify({
                type: 'error',
                message: error.message
            }));
        }
    });

    ws.on('close', () => {
        log.info('Conexión WebSocket cerrada');
    });

    ws.on('error', (error) => {
        log.error(`Error WebSocket: ${error.message}`);
    });
});

/**
 * Manejar mensajes WebSocket
 */
async function handleWebSocketMessage(ws, data) {
    const { type, url } = data;

    switch (type) {
        case 'navigate':
            if (!url) {
                throw new Error('URL requerida');
            }
            
            try {
                const result = await navigateToUrl(url);
                ws.send(JSON.stringify({
                    type: 'navigation_success',
                    message: `Navegación exitosa a: ${result.url}`,
                    url: result.url
                }));
            } catch (error) {
                ws.send(JSON.stringify({
                    type: 'navigation_error',
                    message: `Error navegando: ${error.message}`,
                    url: url
                }));
            }
            break;

        case 'screenshot':
            const success = await takeScreenshot();
            ws.send(JSON.stringify({
                type: success ? 'screenshot_saved' : 'screenshot_error',
                message: success ? 'Screenshot guardado en /screenshot.png' : 'Error capturando screenshot',
                url: success ? '/screenshot.png' : null
            }));
            break;

        case 'status':
            ws.send(JSON.stringify({
                type: 'status',
                message: `Estado: ${isBrowserReady() ? 'Listo' : 'No disponible'}`,
                browserReady: isBrowserReady()
            }));
            break;

        case 'init':
            const initSuccess = await initBrowser();
            ws.send(JSON.stringify({
                type: initSuccess ? 'init_success' : 'init_error',
                message: initSuccess ? 'Navegador inicializado' : 'Error inicializando navegador',
                browserReady: isBrowserReady()
            }));
            break;

        case 'click':
            const { x, y } = data;
            if (x === undefined || y === undefined) {
                throw new Error('Coordenadas x, y requeridas');
            }
            
            const clickSuccess = await clickAt(x, y);
            ws.send(JSON.stringify({
                type: clickSuccess ? 'click_success' : 'click_error',
                message: clickSuccess ? `Click realizado en (${x}, ${y})` : 'Error realizando click',
                coordinates: { x, y }
            }));
            break;

        case 'type':
            const { text } = data;
            if (!text) {
                throw new Error('Texto requerido');
            }
            
            const typeSuccess = await typeText(text);
            ws.send(JSON.stringify({
                type: typeSuccess ? 'type_success' : 'type_error',
                message: typeSuccess ? `Texto escrito: "${text}"` : 'Error escribiendo texto',
                text: text
            }));
            break;

        case 'key':
            const { key } = data;
            if (!key) {
                throw new Error('Tecla requerida');
            }
            
            const keySuccess = await pressKey(key);
            ws.send(JSON.stringify({
                type: keySuccess ? 'key_success' : 'key_error',
                message: keySuccess ? `Tecla presionada: ${key}` : 'Error presionando tecla',
                key: key
            }));
            break;

        default:
            throw new Error(`Comando no reconocido: ${type}`);
    }
}

/**
 * Screenshots automáticos - guardar archivo estático
 */
function startAutoScreenshots() {
    setInterval(async () => {
        if (!isBrowserReady()) return;
        await takeScreenshot(); // Solo guarda el archivo, no envía por WebSocket
    }, 1000); // Cada 1 segundo para actualización fluida
}

/**
 * Iniciar servidor
 */
async function startServer() {
    try {
        // Inicializar navegador
        await initBrowser();
        
        // Iniciar screenshots automáticos
        startAutoScreenshots();
        
        // Iniciar servidor HTTP
        server.listen(PORT, () => {
            log.success(`Servidor PyRock ejecutándose en http://localhost:${PORT}`);
            log.info(`Preview disponible en: http://localhost:${PORT}`);
            log.success('PyRock listo para usar');
        });
        
    } catch (error) {
        log.error(`Error iniciando servidor: ${error.message}`);
        process.exit(1);
    }
}

// Manejo de cierre
process.on('SIGINT', async () => {
    log.info('Cerrando PyRock...');
    if (browser) {
        await browser.close().catch(() => {});
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    log.info('Cerrando PyRock...');
    if (browser) {
        await browser.close().catch(() => {});
    }
    process.exit(0);
});

// Iniciar aplicación
log.info('🚀 Iniciando PyRock simplificado...');
startServer();