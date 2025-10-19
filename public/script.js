// Instancia de PyRockCommands
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

// Funciones de control usando únicamente PyRockCommands
function navigate(url = null) {
    const targetUrl = url || document.getElementById('urlInput').value.trim();
    if (!targetUrl) {
        addLog('Por favor ingresa una URL', 'error');
        return;
    }

    if (pyrock && pyrock.isConnectedToServer()) {
        pyrock.navigate(targetUrl);
        refreshPreview(); // Actualizar preview después de navegar
    } else {
        addLog('No hay conexión con el servidor PyRock', 'error');
    }
}

function takeScreenshot() {
    if (pyrock && pyrock.isConnectedToServer()) {
        pyrock.takeScreenshot();
    } else {
        addLog('No hay conexión con el servidor PyRock', 'error');
    }
}

function getStatus() {
    if (pyrock && pyrock.isConnectedToServer()) {
        pyrock.getStatus();
    } else {
        addLog('No hay conexión con el servidor PyRock', 'error');
    }
}

function initBrowser() {
    if (pyrock && pyrock.isConnectedToServer()) {
        pyrock.initBrowser();
    } else {
        addLog('No hay conexión con el servidor PyRock', 'error');
    }
}

function sendClick() {
    const x = parseInt(document.getElementById('clickX').value) || 600;
    const y = parseInt(document.getElementById('clickY').value) || 620;

    // Mostrar indicador visual en la imagen del preview
    const preview = document.getElementById('preview');
    if (preview && preview.naturalWidth > 0) {
        const position = getIndicatorPosition(preview, x, y);
        showClickIndicator(position.x, position.y);
    }

    if (pyrock && pyrock.isConnectedToServer()) {
        pyrock.click(x, y);
        refreshPreview(); // Actualizar preview después del click
    } else {
        addLog('No hay conexión con el servidor PyRock', 'error');
    }
}

function sendType() {
    const text = document.getElementById('typeText').value || 'hola';

    if (pyrock && pyrock.isConnectedToServer()) {
        pyrock.type(text);
        refreshPreview(); // Actualizar preview después de escribir
    } else {
        addLog('No hay conexión con el servidor PyRock', 'error');
    }
}

function sendKey(key) {
    if (pyrock && pyrock.isConnectedToServer()) {
        pyrock.pressKey(key);
        refreshPreview(); // Actualizar preview después de presionar tecla
    } else {
        addLog('No hay conexión con el servidor PyRock', 'error');
    }
}

// Actualizar preview desde archivo estático
function refreshPreview() {
    const timestamp = new Date().getTime();
    const newSrc = `/screenshot.png?t=${timestamp}`;

    preview.onload = () => {
        preview.style.display = 'block';
        loadingText.style.display = 'none';
        lastUpdate.textContent = `Última actualización: ${new Date().toLocaleTimeString()}`;
    };

    preview.onerror = () => {
        preview.style.display = 'none';
        loadingText.style.display = 'block';
        loadingText.textContent = '❌ Error cargando imagen';
    };

    preview.src = newSrc;
}

// Inicializar preview automático
function startAutoPreview() {
    // Actualizar cada 1 segundo
    setInterval(refreshPreview, 1000);
    addLog('Preview automático iniciado (cada 1 segundo)', 'success');
}

// Manejar tecla Enter en input de URL
document.getElementById('urlInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        navigate();
    }
});

// Función auxiliar para calcular las coordenadas del indicador considerando object-fit: contain
function getIndicatorPosition(preview, realX, realY) {
    const rect = preview.getBoundingClientRect();
    const containerWidth = rect.width;
    const containerHeight = rect.height;
    const imageAspectRatio = preview.naturalWidth / preview.naturalHeight;
    const containerAspectRatio = containerWidth / containerHeight;

    let displayedWidth, displayedHeight, offsetX, offsetY;

    if (imageAspectRatio > containerAspectRatio) {
        // La imagen se ajusta por ancho
        displayedWidth = containerWidth;
        displayedHeight = containerWidth / imageAspectRatio;
        offsetX = 0;
        offsetY = (containerHeight - displayedHeight) / 2;
    } else {
        // La imagen se ajusta por alto
        displayedWidth = containerHeight * imageAspectRatio;
        displayedHeight = containerHeight;
        offsetX = (containerWidth - displayedWidth) / 2;
        offsetY = 0;
    }

    // Convertir coordenadas reales a coordenadas del display
    const scaleX = displayedWidth / preview.naturalWidth;
    const scaleY = displayedHeight / preview.naturalHeight;

    const displayX = (realX * scaleX) + offsetX;
    const displayY = (realY * scaleY) + offsetY;

    return { x: displayX, y: displayY };
}

// Función para mostrar indicador visual del click
function showClickIndicator(x, y) {
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

// Click en la imagen para hacer click en las coordenadas de los campos
preview.addEventListener('click', (event) => {
    // Usar las coordenadas de los campos de entrada
    const x = parseInt(document.getElementById('clickX').value) || 600;
    const y = parseInt(document.getElementById('clickY').value) || 620;

    // Mostrar indicador visual en la posición correspondiente a esas coordenadas
    const position = getIndicatorPosition(preview, x, y);
    showClickIndicator(position.x, position.y);

    // Enviar click usando las coordenadas de los campos
    sendClick();
});

// Inicializar aplicación
window.addEventListener('load', async () => {
    addLog('Iniciando PyRock...', 'info');

    // Inicializar PyRockCommands
    if (typeof PyRockCommands !== 'undefined') {
        pyrock = new PyRockCommands();

        // Configurar callbacks
        pyrock.onLog((message, type) => {
            addLog(message, type);
        });

        pyrock.onStatusChange((connected, message) => {
            updateStatus(connected ? 'Conectado' : 'Desconectado', connected);
            if (message) {
                addLog(message, connected ? 'success' : 'error');
            }
        });

        // Conectar PyRockCommands
        try {
            await pyrock.connect();
            addLog('PyRockCommands inicializado correctamente', 'success');

            // Obtener estado inicial
            setTimeout(() => {
                pyrock.getStatus();
            }, 1000);
        } catch (error) {
            addLog(`Error inicializando PyRockCommands: ${error.message}`, 'error');
            updateStatus('Error de conexión', false);
        }
    } else {
        addLog('Error: PyRockCommands no está disponible', 'error');
        updateStatus('Error de librería', false);
    }

    // Iniciar preview automático
    startAutoPreview();

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

    // Cargar preview inicial
    setTimeout(refreshPreview, 1000);
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

    if (!pyrock || !pyrock.isConnectedToServer()) {
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