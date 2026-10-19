// Instancia de PyRockHTTP
let pyrock = null;

// Instancia del parser de scripts
let scriptParser = null;
let isScriptRunning = false;

// Side panels (log and scripts): only one is open at a time.
const PANEL_TABS = { logPanel: 'tabLog', scriptPanel: 'tabScripts', netPanel: 'tabNet' };
let openPanelId = null;

// Elementos del DOM
const preview = document.getElementById('preview');
const loadingText = document.getElementById('loadingText');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const logContainer = document.getElementById('logContainer');
const logBadge = document.getElementById('logBadge');
const lastUpdate = document.getElementById('lastUpdate');
const previewHelp = document.getElementById('previewHelp');
let currentPreviewStatus = null;
let pendingFrameRender = false;
let queuedManualScreenshot = null;
let activeSessionId = localStorage.getItem('pyrock.activeSession');
let sessionRecords = [];
let sessionMaximum = 5;
let closeConfirmTimer = null;
let armedCloseButton = null;

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
    // Monitor de programa: sin señal cuando la consola pierde la conexión y no hay imagen.
    if (!connected && loadingText.style.display !== 'none') {
        loadingText.textContent = 'SIN SEÑAL — reconectando…';
    }
}

// Agregar entrada al log
function addLog(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = document.createElement('div');
    logEntry.className = `log-entry ${type}`;
    logEntry.textContent = `[${timestamp}] ${message}`;

    logContainer.appendChild(logEntry);
    logContainer.scrollTop = logContainer.scrollHeight;

    // An error logged while the log panel is closed lights the badge on its tab.
    if (type === 'error' && openPanelId !== 'logPanel') {
        logBadge.hidden = false;
    }

    // Mantener solo las últimas 50 entradas
    while (logContainer.children.length > 50) {
        logContainer.removeChild(logContainer.firstChild);
    }
}

function setPanelState(panelId, open) {
    const panel = document.getElementById(panelId);
    const tab = document.getElementById(PANEL_TABS[panelId]);
    panel.classList.toggle('open', open);
    panel.setAttribute('aria-hidden', String(!open));
    tab.classList.toggle('active', open);
    tab.setAttribute('aria-expanded', String(open));
}

// Closes the open panel and returns focus to the tab that opened it.
function closePanel() {
    if (!openPanelId) return;
    const closing = openPanelId;
    openPanelId = null;
    setPanelState(closing, false);
    document.getElementById(PANEL_TABS[closing]).focus({ preventScroll: true });
}

// Opens a panel (closing the other one), or closes it when it is already open.
// Muestra por dónde sale el navegador y qué IP está usando cada sección. Con proxy
// rotativo la IP cambia por petición: lo que se muestra es una foto con su hora.
async function renderNetwork() {
    const body = document.getElementById('netBody');
    if (!body) return;
    let data;
    try {
        data = await pyrock.makeRequest('/api/network');
    } catch (error) {
        body.replaceChildren();
        const failed = document.createElement('div');
        failed.className = 'net-note';
        failed.textContent = `No se pudo leer la información de red: ${error.message}`;
        body.append(failed);
        return;
    }
    const mode = data.mode === 'sticky' ? `sticky (puerto ${data.stickyBase}+, una IP fija por sección)`
        : data.mode === 'rotating' ? 'rotativo (cambia en cada petición)'
        : 'sin proxy: sale la IP del servidor';
    const rows = [
        ['PROXY', data.configured ? `${data.host}:${data.port}` : 'sin proxy'],
        ['MODO', mode],
        ['AUTENTICACIÓN', data.credentials || '—']
    ];
    body.replaceChildren();
    for (const [label, value] of rows) {
        const line = document.createElement('div');
        line.className = 'net-row';
        const key = document.createElement('span');
        key.className = 'net-key';
        key.textContent = label;
        const text = document.createElement('span');
        text.className = 'net-value';
        text.textContent = value;
        line.append(key, text);
        body.append(line);
    }
    const heading = document.createElement('div');
    heading.className = 'net-heading';
    heading.textContent = 'SECCIONES';
    body.append(heading);
    for (const section of data.sections || []) {
        const line = document.createElement('div');
        line.className = 'net-row net-section';
        const name = document.createElement('span');
        name.className = 'net-name';
        name.textContent = section.name;
        const ip = document.createElement('span');
        ip.className = 'net-value';
        const parts = [];
        if (section.ip) parts.push(section.ip);
        if (section.port) parts.push(`puerto ${section.port}`);
        if (section.measuredAt) parts.push(new Date(section.measuredAt).toLocaleTimeString());
        if (section.ipCount > 1) parts.push(`${section.ipCount} IPs distintas`);
        ip.textContent = parts.length ? parts.join(' · ') : 'sin medir';
        line.append(name, ip);
        body.append(line);
    }
}

async function measureNetwork() {
    const button = document.getElementById('netMeasure');
    if (button) { button.disabled = true; button.textContent = 'Midiendo…'; }
    try {
        await pyrock.makeRequest('/api/network/measure', 'POST', {});
    } catch (error) {
        addLog(`No se pudo medir la IP: ${error.message}`, 'error');
    }
    await renderNetwork();
    if (button) { button.disabled = false; button.textContent = 'Medir ahora'; }
}

function togglePanel(panelId) {
    if (!PANEL_TABS[panelId]) return;
    if (openPanelId === panelId) {
        closePanel();
        return;
    }
    if (openPanelId) setPanelState(openPanelId, false);
    openPanelId = panelId;
    setPanelState(panelId, true);
    if (panelId === 'logPanel') {
        logBadge.hidden = true;
        logContainer.scrollTop = logContainer.scrollHeight;
    }
    if (panelId === 'netPanel') renderNetwork();
    document.getElementById(`${panelId}Close`).focus({ preventScroll: true });
}

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && openPanelId) closePanel();
});

// Funciones de control usando PyRockHTTP (REST API)
// Refleja en el panel dónde está realmente la sección activa: la URL cambia
// sola cuando el sitio abre otra pestaña, y el modo de preview dice si los
// frames vienen de screencast o del sondeo de capturas.
let lastSectionUrl = '';
let lastListSignature = '';

function showPreviewMode(mode) {
    const element = document.getElementById('previewMode');
    if (!element) return;
    if (mode === 'poll') element.textContent = 'sondeo de capturas';
    else if (mode === 'screencast') element.textContent = 'screencast';
    else element.textContent = '';
}

function applySectionState(section) {
    if (!section) return;
    const url = section.url || '';
    if (url && url !== lastSectionUrl) {
        const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
        if (lastSectionUrl) addLog(`Se siguió una pestaña nueva: ${host}`, 'info');
        lastSectionUrl = url;
    }
    const field = document.getElementById('urlInput');
    // Lo que el operador está tipeando no se pisa.
    if (field && url && url !== field.value && document.activeElement !== field) field.value = url;
    if (section.previewMode) showPreviewMode(section.previewMode);
    if (section.diagnosis) showDiagnosis(section.diagnosis);
}

// Muestra en el panel por qué una página quedó en blanco: el dato viene del
// servidor (qué estado tiene el documento y qué petición sigue pendiente).
let lastDiagnosisMessage = '';
function showDiagnosis(diagnosis) {
    const hint = document.getElementById('previewHint');
    if (!hint) return;
    if (!diagnosis || diagnosis.error) { hint.hidden = true; lastDiagnosisMessage = ''; return; }
    const pending = diagnosis.pending || [];
    let message = '';
    if (diagnosis.readyState && diagnosis.readyState !== 'complete') {
        const host = pending.length ? (() => { try { return new URL(pending[0]).hostname; } catch { return pending[0]; } })() : '';
        message = `La página sigue cargando (${pending.length} petición${pending.length === 1 ? '' : 'es'} pendiente${pending.length === 1 ? '' : 's'}${host ? `: ${host}` : ''}).`;
    } else if (diagnosis.textLength === 0) {
        message = 'La página cargó pero no muestra nada: suele pedir una sesión iniciada o estar bloqueada.';
    }
    if (!message) { hint.hidden = true; lastDiagnosisMessage = ''; return; }
    hint.textContent = message;
    hint.hidden = false;
    if (message !== lastDiagnosisMessage) { lastDiagnosisMessage = message; addLog(message, 'info'); }
}

async function navigate(url = null) {
    const targetUrl = url || document.getElementById('urlInput').value.trim();
    if (!targetUrl) {
        addLog('Por favor ingresa una URL', 'error');
        return;
    }

    if (pyrock && pyrock.isConnected) {
        try {
            const result = await pyrock.navigate(targetUrl);
            showDiagnosis(result && result.diagnosis);
        } catch (error) {
            addLog(`Error navegando: ${error.message}`, 'error');
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

// Conexión de controles: los handlers se registran aquí en lugar de atributos
// onclick inline, de modo que el uso es visible para el análisis estático y
// compatible con una Content-Security-Policy sin 'unsafe-inline'.
document.getElementById('navigateBtn').addEventListener('click', () => navigate());
document.getElementById('clickBtn').addEventListener('click', sendClick);
document.getElementById('typeBtn').addEventListener('click', sendType);
document.getElementById('restartBtn').addEventListener('click', initBrowser);
document.getElementById('arrowUp').addEventListener('click', () => sendKey('ArrowUp'));
document.getElementById('arrowLeft').addEventListener('click', () => sendKey('ArrowLeft'));
document.getElementById('arrowDown').addEventListener('click', () => sendKey('ArrowDown'));
document.getElementById('arrowRight').addEventListener('click', () => sendKey('ArrowRight'));
document.getElementById('keyEnter').addEventListener('click', () => sendKey('Enter'));
document.getElementById('keyTab').addEventListener('click', () => sendKey('Tab'));
document.getElementById('keyEscape').addEventListener('click', () => sendKey('Escape'));
document.getElementById('tabLog').addEventListener('click', () => togglePanel('logPanel'));
document.getElementById('tabScripts').addEventListener('click', () => togglePanel('scriptPanel'));
document.getElementById('tabNet').addEventListener('click', () => togglePanel('netPanel'));
document.getElementById('logPanelClose').addEventListener('click', closePanel);
document.getElementById('scriptPanelClose').addEventListener('click', closePanel);
document.getElementById('netPanelClose').addEventListener('click', closePanel);
document.getElementById('netMeasure').addEventListener('click', measureNetwork);
document.getElementById('loadScriptBtn').addEventListener('click', loadScriptFile);
document.getElementById('executeBtn').addEventListener('click', executeScript);
document.getElementById('stopBtn').addEventListener('click', stopScript);

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

async function refreshSessions() {
    if (!pyrock || !pyrock.isConnected || typeof pyrock.listSessions !== 'function') return;
    const result = await pyrock.listSessions();
    sessionRecords = result.sessions || []; sessionMaximum = result.max || 5;
    const deckBus = document.getElementById('deckBus');
    if (deckBus) deckBus.textContent = `PVW → PGM · ${sessionRecords.find(s => s.id === activeSessionId)?.name || '—'}`;
    const list = document.getElementById('sessionList');
    const add = document.getElementById('sessionAdd');
    add.disabled = sessionRecords.length >= sessionMaximum; add.title = add.disabled ? 'Límite de secciones alcanzado' : 'Agregar sección';
    // La lista solo se reconstruye cuando cambió: el refresco periódico no
    // puede borrar el nombre que se está escribiendo ni la confirmación de un
    // cierre a medio confirmar.
    const signature = sessionRecords.map(s => `${s.id}:${s.name}:${s.id === activeSessionId ? '1' : '0'}`).join('|');
    if (!list.querySelector('input') && signature !== lastListSignature) {
        lastListSignature = signature;
        list.replaceChildren();
        sessionRecords.forEach((section, index) => {
        const li = document.createElement('li'); li.classList.toggle('active', section.id === activeSessionId);
        const button = document.createElement('button'); button.type = 'button'; button.title = section.name; button.setAttribute('aria-label', section.name);
        button.setAttribute('aria-current', section.id === activeSessionId ? 'true' : 'false');
        const number = document.createElement('span'); number.textContent = String(index + 1);
        const name = document.createElement('span'); name.className = 'session-name'; name.textContent = section.name;
        button.append(number, name); button.addEventListener('click', () => activateSession(section)); li.append(button);
        const close = document.createElement('button'); close.type = 'button'; close.className = 'session-close'; close.textContent = '✕'; close.disabled = sessionRecords.length <= 1; close.setAttribute('aria-label', `Cerrar ${section.name}`);
        close.addEventListener('click', async () => {
            if (sessionRecords.length <= 1) return;
            if (close.dataset.confirm !== 'yes') {
                if (armedCloseButton && armedCloseButton !== close) {
                    clearTimeout(closeConfirmTimer);
                    armedCloseButton.dataset.confirm = '';
                    armedCloseButton.textContent = '✕';
                }
                armedCloseButton = close;
                close.dataset.confirm = 'yes'; close.textContent = '?';
                clearTimeout(closeConfirmTimer);
                closeConfirmTimer = setTimeout(() => {
                    if (armedCloseButton === close) armedCloseButton = null;
                    close.dataset.confirm = ''; close.textContent = '✕';
                }, 3000);
                return;
            }
            clearTimeout(closeConfirmTimer); armedCloseButton = null;
            const neighbor = sessionRecords[Math.max(0, index - 1)];
            await pyrock.closeSession(section.id);
            if (section.id === activeSessionId) activeSessionId = neighbor?.id || null;
            await refreshSessions();
            if (section.id === localStorage.getItem('pyrock.activeSession') && neighbor) await activateSession(neighbor);
        }); li.append(close); list.append(li);
    });
    }
    if (!sessionRecords.some(s => s.id === activeSessionId)) {
        activeSessionId = null;
        const current = sessionRecords.find(s => s.id === result.default);
        if (current) activateSession(current);
    }
    // Un solo dueño del campo de URL: si el operador está tipeando, no se pisa.
    applySectionState(sessionRecords.find(s => s.id === activeSessionId));
}
function activateSession(section) {
    if (!section) return;
    activeSessionId = section.id; localStorage.setItem('pyrock.activeSession', section.id);
    pyrock.switchSession(section.id); pendingFrameRender = false; queuedManualScreenshot = null;
    preview.style.display = 'none'; loadingText.style.display = 'block'; loadingText.textContent = 'Cargando sección…';
    const field = document.getElementById('urlInput');
    if (document.activeElement !== field) field.value = section.url || '';
    refreshSessions();
}
async function addSessionInline() {
    const list = document.getElementById('sessionList'); if (list.querySelector('input')) return;
    const li = document.createElement('li'), input = document.createElement('input'); input.setAttribute('aria-label', 'Nombre de sección');
    // Llega pre-cargado con el nombre siguiente; queda seleccionado para editar o reemplazar.
    input.value = `Sección ${sessionRecords.length + 1}`;
    li.append(input); list.prepend(li); const cancel = () => li.remove();
    input.addEventListener('keydown', async e => { if (e.key === 'Escape') cancel(); if (e.key === 'Enter') { try { const result = await pyrock.createSession(input.value.trim() || undefined); await refreshSessions(); activateSession(result.session); } catch (error) { addLog(error.message, 'error'); } } });
    input.addEventListener('blur', cancel); input.focus(); if (typeof input.select === 'function') input.select();
}
document.getElementById('sessionAdd').addEventListener('click', addSessionInline);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSessions(); });

// Inicializar aplicación
window.addEventListener('load', async () => {
    addLog('Iniciando PyRock...', 'info');

    // Inicializar PyRockHTTP
    if (typeof PyRockHTTP !== 'undefined') {
        // Usar configuración del archivo config.js
        const config = window.PyRockConfig || {};
        addLog(`🔧 Conectando a: ${config.serverUrl || 'http://localhost:3000'}`, 'info');
        
        pyrock = new PyRockHTTP({
            sessionId: localStorage.getItem('pyrock.activeSession'),
            onSessionGone: async () => { await refreshSessions(); },
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
                    loadingText.textContent = 'Esperando fotograma de vista previa…';
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
                    loadingText.textContent = 'Error cargando imagen; se conserva la vista previa anterior si está disponible';
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
                await refreshSessions();
                // Refresco periódico: mantiene al panel al tanto de dónde está la
                // sección (que cambia sola si el sitio abre otra pestaña) como del
                // estado de la página que sigue cargando.
                setInterval(() => { refreshSessions(); }, 3000);
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

    const previousClient = scriptParser.pyRock;
    let originalIndicator;
    try {
        const runSessionId = activeSessionId;
        scriptParser.pyRock = pyrock.forSession(runSessionId);
        originalIndicator = scriptParser.visualIndicators?.showClickIndicator;
        if (scriptParser.visualIndicators) scriptParser.visualIndicators.showClickIndicator = (...args) => { if (activeSessionId === runSessionId) originalIndicator?.(...args); };
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
        if (scriptParser) { scriptParser.pyRock = previousClient; if (scriptParser.visualIndicators && originalIndicator) scriptParser.visualIndicators.showClickIndicator = originalIndicator; }
        isScriptRunning = false;

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

// Script state is restored by executeScript's finally block.