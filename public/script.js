// Instancia de PyRockHTTP
let pyrock = null;

// Instancia del parser de scripts
let scriptParser = null;
let isScriptRunning = false;
let currentScriptExecution = null;

// Elementos del DOM
const preview = document.getElementById('preview');
const loadingText = document.getElementById('loadingText');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const logContainer = document.getElementById('logContainer');
const lastUpdate = document.getElementById('lastUpdate');
const previewHelp = document.getElementById('previewHelp');
let currentPreviewStatus = null;
let pendingFrameRender = false;
let queuedManualScreenshot = null;

// Elementos del DOM para scripts
const scriptEditor = document.getElementById('scriptEditor');
const scriptFileInput = document.getElementById('scriptFileInput');
const executeBtn = document.getElementById('executeBtn');
const stopBtn = document.getElementById('stopBtn');
const scriptStatus = document.getElementById('scriptStatus');
const scriptProgress = document.getElementById('scriptProgress');

// Actualizar estado de conexión
function updateStatus(text, connected) {
    statusText.textContent = text;
    statusDot.className = `status-dot ${connected ? 'connected' : ''}`;
}

// Agregar entrada al log
function addLog(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = document.createElement('div');
    logEntry.className = `log-entry ${type}`;
    logEntry.textContent = `[${timestamp}] ${message}`;

    logContainer.appendChild(logEntry);
    logContainer.scrollTop = logContainer.scrollHeight;

    // Mantener solo las últimas 50 entradas
    while (logContainer.children.length > 50) {
        logContainer.removeChild(logContainer.firstChild);
    }
}

// Funciones de control usando PyRockHTTP (REST API)
async function navigate(url = null) {
    const targetUrl = url || document.getElementById('urlInput').value.trim();
    if (!targetUrl) {
        addLog('Por favor ingresa una URL', 'error');
        return;
    }

    if (pyrock && pyrock.isConnected) {
        try {
            await pyrock.navigate(targetUrl);
        } catch (error) {
            addLog(`Error navegando: ${error.message}`, 'error');
        }
    } else {
        addLog('No hay conexión con el servidor PyRock', 'error');
    }
}

async function takeScreenshot() {
    if (pyrock && pyrock.isConnected) {
        try {
            await pyrock.takeScreenshot();
        } catch (error) {
            addLog(`Error tomando screenshot: ${error.message}`, 'error');
        }
    } else {
        addLog('No hay conexión con el servidor PyRock', 'error');
    }
}

async function getStatus() {
    if (pyrock && pyrock.isConnected) {
        try {
            const status = await pyrock.getStatus();
            addLog(`Estado del navegador: ${status.browser}`, 'info');
        } catch (error) {
            addLog(`Error obteniendo estado: ${error.message}`, 'error');
        }
    } else {
        addLog('No hay conexión con el servidor PyRock', 'error');
    }
}

async function initBrowser() {
    if (pyrock && pyrock.isConnected) {
        try {
            await pyrock.initBrowser();
        } catch (error) {
            addLog(`Error inicializando navegador: ${error.message}`, 'error');
        }
    } else {
        addLog('No hay conexión con el servidor PyRock', 'error');
    }
}

// Parses a coordinate field; only a missing or invalid value falls back to the default, so 0 stays valid.
function readCoordinate(id, fallback) {
    const value = parseInt(document.getElementById(id).value, 10);
    return Number.isNaN(value) ? fallback : value;
}

async function sendClick() {
    const x = readCoordinate('clickX', 600);
    const y = readCoordinate('clickY', 620);

    // Mostrar indicador visual en la imagen del preview
    const preview = document.getElementById('preview');
    if (preview && preview.naturalWidth > 0) {
        const position = getIndicatorPosition(preview, x, y);
        showClickIndicator(position.x, position.y);
    }

    if (pyrock && pyrock.isConnected) {
        try {
            await pyrock.click(x, y);
        } catch (error) {
            addLog(`Error haciendo click: ${error.message}`, 'error');
        }
    } else {
        addLog('No hay conexión con el servidor PyRock', 'error');
    }
}

async function sendType() {
    const text = document.getElementById('typeText').value || 'hola';

    if (pyrock && pyrock.isConnected) {
        try {
            await pyrock.type(text);
        } catch (error) {
            addLog(`Error escribiendo texto: ${error.message}`, 'error');
        }
    } else {
        addLog('No hay conexión con el servidor PyRock', 'error');
    }
}

async function sendKey(key) {
    if (pyrock && pyrock.isConnected) {
        try {
            await pyrock.pressKey(key);
        } catch (error) {
            addLog(`Error presionando tecla: ${error.message}`, 'error');
        }
    } else {
        addLog('No hay conexión con el servidor PyRock', 'error');
    }
}

// Actualizar preview desde archivo estático
// Sistema de actualización de preview eliminado - ahora se usa solo onScreenshotUpdate
// para evitar conflictos entre dos sistemas de actualización simultáneos

// Manejar tecla Enter en input de URL
document.getElementById('urlInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        navigate();
    }
});

// Where the object-fit: contain image is actually drawn, in viewport coordinates.
// It reads the current rendered rectangle on every call, so resizes, scrolling and the
// hover zoom are always reflected. Returns null while the geometry is unusable.
function getPreviewGeometry(image) {
    if (!image || !(image.naturalWidth > 0) || !(image.naturalHeight > 0)) return null;
    const rect = image.getBoundingClientRect();
    if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) return null;
    if (rect.width <= 0 || rect.height <= 0) return null;
    const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    return {
        scale, width, height,
        left: rect.left + (rect.width - width) / 2,
        top: rect.top + (rect.height - height) / 2
    };
}

// Converts a viewport point into remote browser coordinates, or null over the letterbox bands.
function getRemotePoint(image, clientX, clientY) {
    const geometry = getPreviewGeometry(image);
    if (!geometry) return null;
    const localX = clientX - geometry.left;
    const localY = clientY - geometry.top;
    if (!(localX >= 0 && localY >= 0 && localX < geometry.width && localY < geometry.height)) return null;
    return {
        x: Math.min(Math.floor(localX / geometry.scale), image.naturalWidth - 1),
        y: Math.min(Math.floor(localY / geometry.scale), image.naturalHeight - 1)
    };
}

// Projects a remote point into .preview-container coordinates, where indicators are positioned.
// Without usable geometry it returns NaN coordinates, which showClickIndicator ignores.
function getIndicatorPosition(preview, realX, realY) {
    const geometry = getPreviewGeometry(preview);
    const container = document.querySelector('.preview-container');
    if (!geometry || !container) return { x: NaN, y: NaN };
    const box = container.getBoundingClientRect();
    return {
        x: geometry.left + realX * geometry.scale - box.left - (container.clientLeft || 0),
        y: geometry.top + realY * geometry.scale - box.top - (container.clientTop || 0)
    };
}

// Función para mostrar indicador visual del click
function showClickIndicator(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    // Crear el indicador
    const indicator = document.createElement('div');
    indicator.className = 'click-indicator';
    indicator.style.left = x + 'px';
    indicator.style.top = y + 'px';

    // Agregar al contenedor del preview
    const previewContainer = document.querySelector('.preview-container');
    previewContainer.appendChild(indicator);

    // Remover después de la animación
    setTimeout(() => {
        if (indicator.parentNode) {
            indicator.parentNode.removeChild(indicator);
        }
    }, 1000);
}

// Click on the image: map the mouse position to remote coordinates, mirror them into the
// X/Y fields and send a single click (sendClick draws the one indicator).
preview.addEventListener('click', (event) => {
    const point = getRemotePoint(preview, event.clientX, event.clientY);
    if (!point) return;
    document.getElementById('clickX').value = String(point.x);
    document.getElementById('clickY').value = String(point.y);
    sendClick();
});

// Inicializar aplicación
window.addEventListener('load', async () => {
    addLog('Iniciando PyRock...', 'info');

    // Inicializar PyRockHTTP
    if (typeof PyRockHTTP !== 'undefined') {
        // Usar configuración del archivo config.js
        const config = window.PyRockConfig || {};
        addLog(`🔧 Conectando a: ${config.serverUrl || 'http://localhost:3000'}`, 'info');
        
        pyrock = new PyRockHTTP({
            serverUrl: config.serverUrl || 'http://localhost:3000',
            statusPollIntervalMs: config.statusPollIntervalMs || 30000,
            onLog: (message, type = 'info') => {
                addLog(message, type);
            },
            onStatusChange: (status) => {
                const connected = status === 'connected';
                updateStatus(connected ? 'Conectado' : 'Desconectado', connected);
            },
            onPreviewStatus: (state, message) => {
                const labels = {
                    starting: '⏳ Vista previa: conectando…',
                    live: '🟢 Vista previa en vivo',
                    reconnecting: '⏸️ Vista previa pausada; intentando reconectar…',
                    unavailable: `⚠️ Vista previa no disponible${message ? `: ${message}` : ''}`
                };
                const label = labels[state] || 'Vista previa: estado desconocido';
                if (previewHelp) previewHelp.textContent = label;
                if (state !== currentPreviewStatus) {
                    currentPreviewStatus = state;
                    addLog(message ? `${label}` : label, state === 'unavailable' ? 'error' : 'info');
                }
                if (state !== 'live' && (!preview || !preview.complete || preview.naturalWidth === 0)) {
                    loadingText.style.display = 'block';
                    loadingText.textContent = label;
                } else if (state === 'live') {
                    loadingText.style.display = 'none';
                }
            },
            onScreenshotUpdate: (screenshot, onRenderComplete) => {
                if (!onRenderComplete && pendingFrameRender) {
                    queuedManualScreenshot = screenshot;
                    return;
                }
                if (!screenshot || !preview) {
                    loadingText.style.display = 'block';
                    loadingText.textContent = '⏳ Esperando fotograma de vista previa…';
                    if (onRenderComplete) onRenderComplete(new Error('No preview image element'));
                    return;
                }

                let completed = false;
                if (onRenderComplete) pendingFrameRender = true;
                const finish = error => {
                    if (completed) return;
                    completed = true;
                    if (onRenderComplete) {
                        pendingFrameRender = false;
                        onRenderComplete(error);
                        if (queuedManualScreenshot) {
                            const manualScreenshot = queuedManualScreenshot;
                            queuedManualScreenshot = null;
                            preview.src = manualScreenshot;
                        }
                    }
                };
                const cleanupListeners = () => {
                    preview.removeEventListener('load', handleLoad);
                    preview.removeEventListener('error', handleError);
                };
                const handleLoad = () => {
                    cleanupListeners();
                    preview.style.display = 'block';
                    loadingText.style.display = 'none';
                    lastUpdate.textContent = `Última actualización: ${new Date().toLocaleTimeString()}`;
                    finish();
                };
                const handleError = () => {
                    cleanupListeners();
                    preview.style.display = 'block';
                    loadingText.style.display = 'block';
                    loadingText.textContent = '❌ Error cargando imagen; se conserva la vista previa anterior si está disponible';
                    addLog('Error al mostrar imagen de preview', 'error');
                    finish(new Error('Error rendering preview image'));
                };
                preview.addEventListener('load', handleLoad);
                preview.addEventListener('error', handleError);
                preview.src = screenshot;
            }
        });

        // Conectar PyRockHTTP
        try {
            const connected = await pyrock.connect();
            if (connected) {
                addLog('PyRock HTTP inicializado correctamente', 'success');
                
            } else {
                addLog('Error conectando al servidor', 'error');
                updateStatus('Error de conexión', false);
            }
        } catch (error) {
            addLog(`Error inicializando PyRock HTTP: ${error.message}`, 'error');
            updateStatus('Error de conexión', false);
        }
    } else {
        addLog('Error: PyRockHTTP no está disponible', 'error');
        updateStatus('Error de librería', false);
    }

    addLog('Vista previa en vivo por WebSocket; los controles siguen usando REST', 'success');

    // Inicializar parser de scripts
    if (typeof PyRockScriptParser !== 'undefined') {
        // Pasar funciones de indicador visual al parser
        const visualIndicators = {
            showClickIndicator: showClickIndicator,
            getIndicatorPosition: getIndicatorPosition
        };
        scriptParser = new PyRockScriptParser(pyrock, visualIndicators);
        addLog('Parser de scripts inicializado con indicadores visuales', 'success');
    } else {
        addLog('Advertencia: Parser de scripts no disponible', 'error');
    }

});

window.addEventListener('pagehide', () => {
    if (pyrock) pyrock.disconnect();
});

// ===== FUNCIONES DE MANEJO DE SCRIPTS =====

// Cargar script desde archivo
function loadScriptFile() {
    scriptFileInput.click();
}

// Manejar selección de archivo
scriptFileInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            // Limpiar completamente el estado anterior
            if (isScriptRunning) {
                stopScript();
            }
            
            // Restablecer variables y estado
            currentScriptExecution = null;
            if (scriptParser) {
                scriptParser.commands = [];
                scriptParser.currentLine = 0;
            }
            
            // Reemplazar completamente el contenido del editor
            scriptEditor.value = e.target.result;
            
            // Restablecer UI
            updateScriptStatus('Script cargado');
            updateScriptProgress('');
            executeBtn.disabled = false;
            stopBtn.disabled = true;
            
            addLog(`Script cargado: ${file.name} - Editor restablecido`, 'success');
        };
        reader.readAsText(file);
    }
    
    // Limpiar el input para permitir cargar el mismo archivo nuevamente
    event.target.value = '';
});

// Ejecutar script
async function executeScript() {
    if (!scriptParser) {
        addLog('Error: Parser de scripts no disponible', 'error');
        return;
    }

    if (!pyrock || !pyrock.isConnected) {
        addLog('Error: No hay conexión con PyRock', 'error');
        return;
    }

    const scriptContent = scriptEditor.value.trim();
    if (!scriptContent) {
        addLog('Error: No hay script para ejecutar', 'error');
        return;
    }

    if (isScriptRunning) {
        addLog('Ya hay un script ejecutándose', 'error');
        return;
    }

    try {
        isScriptRunning = true;
        executeBtn.disabled = true;
        stopBtn.disabled = false;
        updateScriptStatus('Ejecutando...');

        addLog('Iniciando ejecución de script', 'info');

        // Cargar y validar script
        const commands = scriptParser.loadScript(scriptContent);
        
        addLog(`Script validado: ${commands.length} comandos encontrados`, 'success');

        // Ejecutar comandos con soporte para saltos y bucles
        scriptParser.currentLine = 0;
        
        while (scriptParser.currentLine < commands.length && isScriptRunning) {
            const command = commands[scriptParser.currentLine];
            updateScriptProgress(`Comando ${scriptParser.currentLine + 1}/${commands.length}: Línea ${command.lineNumber}`);
            
            addLog(`Ejecutando línea ${command.lineNumber}: ${command.originalLine}`, 'info');

            try {
                await scriptParser.executeCommand(command);
                
                // Solo avanzar si no hubo salto (loop)
                const previousLine = scriptParser.currentLine;
                scriptParser.currentLine++;
                
                // Si hubo un salto, currentLine ya fue modificado por el comando
                if (scriptParser.currentLine !== previousLine + 1) {
                    continue; // No hacer pausa en saltos
                }
                
                // Pequeña pausa entre comandos para mejor visualización
                if (scriptParser.currentLine < commands.length && isScriptRunning) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            } catch (error) {
                addLog(`Error ejecutando comando: ${error.message}`, 'error');
                break;
            }
        }

        if (isScriptRunning) {
            addLog('Script ejecutado completamente', 'success');
            updateScriptStatus('Completado');
        } else {
            updateScriptStatus('Cancelado');
        }

    } catch (error) {
        addLog(`Error en script: ${error.message}`, 'error');
        updateScriptStatus('Error');
    } finally {
        // Restablecer completamente el estado
        isScriptRunning = false;
        currentScriptExecution = null;
        
        // Limpiar parser
        if (scriptParser) {
            scriptParser.commands = [];
            scriptParser.currentLine = 0;
        }
        
        // Restablecer UI
        executeBtn.disabled = false;
        stopBtn.disabled = true;
        updateScriptProgress('');
        
        // Si no hay error específico, marcar como listo
        if (scriptStatus.textContent.includes('Completado') || 
            scriptStatus.textContent.includes('Cancelado') || 
            scriptStatus.textContent.includes('Error')) {
            setTimeout(() => {
                if (!isScriptRunning) {
                    updateScriptStatus('Listo');
                }
            }, 2000);
        }
    }
}

// Parar ejecución de script
function stopScript() {
    if (isScriptRunning) {
        isScriptRunning = false;
        addLog('Deteniendo ejecución de script...', 'info');
        
        // Limpiar completamente todas las variables y estado
        setTimeout(() => {
            // Restablecer variables globales
            currentScriptExecution = null;
            
            // Limpiar parser si existe
            if (scriptParser) {
                scriptParser.commands = [];
                scriptParser.currentLine = 0;
            }
            
            // Restablecer UI completamente
            updateScriptStatus('Listo');
            updateScriptProgress('');
            executeBtn.disabled = false;
            stopBtn.disabled = true;
            
            addLog('Script detenido - Variables restablecidas', 'info');
        }, 500);
    }
}

// Actualizar estado del script
function updateScriptStatus(status) {
    scriptStatus.textContent = `Estado: ${status}`;
}

// Actualizar progreso del script
function updateScriptProgress(progress) {
    scriptProgress.textContent = progress;
}

// Limpiar completamente el estado del script
function resetScriptState() {
    // Detener ejecución si está corriendo
    if (isScriptRunning) {
        isScriptRunning = false;
    }
    
    // Limpiar variables globales
    currentScriptExecution = null;
    
    // Limpiar parser
    if (scriptParser) {
        scriptParser.commands = [];
        scriptParser.currentLine = 0;
    }
    
    // Restablecer UI
    updateScriptStatus('Listo');
    updateScriptProgress('');
    executeBtn.disabled = false;
    stopBtn.disabled = true;
    
    addLog('Estado del script restablecido completamente', 'info');
}