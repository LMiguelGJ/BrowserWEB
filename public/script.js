// Instancia de PyRockHTTP
let pyrock = null;

// Cada sección tiene su script: contenido, archivo, estado y parser propio.
// Así dos secciones pueden correr scripts a la vez, cada uno en la suya.
const scriptStates = new Map();
let scriptParserAvailable = false;

// Side panels (log and scripts): only one is open at a time.
const PANEL_TABS = { logPanel: 'tabLog', scriptPanel: 'tabScripts', netPanel: 'tabNet' };
let openPanelId = null;
let networkPollingTimer = null;
let networkPollInFlight = false;
function stopNetworkPolling() {
    if (networkPollingTimer !== null) clearInterval(networkPollingTimer);
    networkPollingTimer = null;
}
function startNetworkPolling() {
    if (networkPollingTimer !== null) return;
    networkPollingTimer = setInterval(async () => {
        if (openPanelId !== 'netPanel' || networkPollInFlight) return;
        networkPollInFlight = true;
        try { await renderNetwork(); } finally { networkPollInFlight = false; }
    }, 5000);
}

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
let sessionMaximum = 0;
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

// El registro es de la app, pero cada línea sabe de qué sección es: el panel
// muestra el de la sección activa y hay un interruptor para verlos todos.
const logEntries = [];
// La primera línea del registro: la que el HTML mostraba antes de que el
// script lo dibujara, y que el redibujado no puede perder.
logEntries.push({ sessionId: null, sectionName: '', message: 'Sistema iniciado - vista previa en vivo disponible al conectar', type: 'info', at: '' });
const LOG_MEMORY_LIMIT = 200;
const LOG_VISIBLE_LIMIT = 50;
let logScopeAll = false;
let logScopeRendered = null;

// Agregar entrada al log
function addLog(message, type = 'info', sessionId = activeSessionId) {
    const section = sessionId ? sessionRecords.find(item => item.id === sessionId) : null;
    logEntries.push({
        sessionId: sessionId || null,
        sectionName: section?.name || '',
        message,
        type,
        at: new Date().toLocaleTimeString()
    });
    while (logEntries.length > LOG_MEMORY_LIMIT) logEntries.shift();
    renderLog(true);
}

function visibleLogEntries() {
    if (logScopeAll) return logEntries;
    return logEntries.filter(entry => !entry.sessionId || entry.sessionId === activeSessionId);
}

function renderLog(force = false) {
    const scope = logScopeAll ? 'all' : (activeSessionId || 'none');
    // El refresco periódico no reconstruye el registro: el operador puede
    // estar leyéndolo y no debe ver la lista moverse sola.
    if (!force && scope === logScopeRendered) return;
    logScopeRendered = scope;
    const entries = visibleLogEntries();
    const nodes = entries.slice(-LOG_VISIBLE_LIMIT).map(entry => {
        const node = document.createElement('div');
        node.className = `log-entry ${entry.type}`;
        // Al ver todas las secciones, cada línea dice de cuál es.
        const who = logScopeAll && entry.sectionName ? ` ${entry.sectionName} ·` : '';
        node.textContent = entry.at ? `[${entry.at}]${who} ${entry.message}` : entry.message;
        return node;
    });
    logContainer.replaceChildren(...nodes);
    logContainer.scrollTop = logContainer.scrollHeight;
    updateLogBadge(entries);
}

// El badge avisa de lo que el operador tiene delante: un error en la sección
// abierta, o en cualquiera cuando la vista muestra todas.
function updateLogBadge(entries = visibleLogEntries()) {
    if (openPanelId === 'logPanel') {
        logBadge.hidden = true;
        return;
    }
    logBadge.hidden = !entries.some(entry => entry.type === 'error');
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
    if (closing === 'netPanel') stopNetworkPolling();
    setPanelState(closing, false);
    document.getElementById(PANEL_TABS[closing]).focus({ preventScroll: true });
}

// Opens a panel (closing the other one), or closes it when it is already open.
// Muestra por dónde sale el navegador y qué IP está usando cada sección. Con proxy
// rotativo la IP cambia por petición: lo que se muestra es una foto con su hora.
// What the free pool is doing, in words the operator can act on. The raw
// status travels in the tooltip, because 'unavailable' alone says nothing.
function poolLabel(pool) {
    if (!pool) return 'sin estado';
    if (pool.status === 'ok') {
        // How many exits are left, and of what kind: the answer to "how many
        // IPs can I use right now".
        const total = pool.count?.total;
        if (!total) return 'ok';
        const types = Object.entries(pool.count?.byType || {}).map(([type, value]) => `${type} ${value}`).join(' · ');
        return types ? `ok · ${total} (${types})` : `ok · ${total}`;
    }
    if (pool.status === 'empty') return 'vacío';
    if (pool.status === 'unavailable') {
        if (pool.reason === 'unreachable') return 'no responde';
        if (pool.reason === 'unauthorized') return 'clave incorrecta';
        return 'no disponible';
    }
    return pool.status;
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '—';
    const megabytes = bytes / (1024 * 1024);
    return megabytes >= 1024 ? `${(megabytes / 1024).toFixed(2)} GB` : `${Math.round(megabytes)} MB`;
}

async function renderNetwork() {
    const body = document.getElementById('netBody');
    if (!body) return null;
    let data;
    try {
        data = await pyrock.makeRequest('/api/network');
    } catch (error) {
        body.replaceChildren();
        const failed = document.createElement('div');
        failed.className = 'net-note';
        failed.textContent = `No se pudo leer la información de red: ${error.message}`;
        body.append(failed);
        return null;
    }
    const mode = data.mode === 'hybrid' ? 'híbrido: gratis primero; DataImpulse de respaldo'
        : data.mode === 'sticky' ? `sticky (puerto ${data.stickyBase}+, una IP fija por sección)`
        : data.mode === 'rotating' ? 'rotativo (cambia en cada petición)'
        : 'sin proxy: sale la IP del servidor';
    const rows = data.mode === 'hybrid'
        ? [
            ['MODO', mode],
            ['POOL GRATUITO', poolLabel(data.pool), data.pool?.reason ? `motivo: ${data.pool.reason}` : null],
            ['RESPALDO', data.fallbackConfigured ? 'DataImpulse' : 'no configurado']
        ]
        : [['PROXY', data.configured ? `${data.host}:${data.port}` : 'sin proxy'], ['MODO', mode], ['AUTENTICACIÓN', data.credentials || '—']];
    body.replaceChildren();
    for (const [label, value, hint] of rows) {
        const line = document.createElement('div');
        line.className = 'net-row';
        const key = document.createElement('span');
        key.className = 'net-key';
        key.textContent = label;
        const text = document.createElement('span');
        text.className = 'net-value';
        text.textContent = value;
        if (hint) text.title = hint;
        line.append(key, text);
        body.append(line);
    }
    // La memoria que importa es la del navegador, y el proceso de Node no ve al
    // navegador que lanzó: el informe lista sus procesos hijo con su RSS. Si
    // el informe no está disponible, el panel sigue mostrando la red igual.
    let memory = null;
    try { memory = await pyrock.makeRequest('/api/diagnostics'); } catch { memory = null; }
    if (memory) {
        const parts = [...(memory.processes || []).map(item => `${item.name} ${formatBytes(item.rss)}`)];
        parts.push(`Node ${formatBytes(memory.node?.rss)}`);
        const contexts = memory.sections?.contexts ?? 0;
        parts.push(`${contexts} contextos vivos`);
        const line = document.createElement('div');
        line.className = 'net-row';
        const key = document.createElement('span');
        key.className = 'net-key';
        key.textContent = 'MEMORIA';
        const value = document.createElement('span');
        value.className = 'net-value';
        value.textContent = parts.join(' · ');
        value.title = `Sondeos: ${memory.probes?.created ?? 0} creados, ${memory.probes?.failed ?? 0} sin liberar`;
        line.append(key, value);
        body.append(line);
        // Un contexto que no se pudo cerrar sigue consumiendo memoria del
        // navegador sin que nadie lo mire: hay que decirlo en pantalla.
        for (const failure of memory.sections?.closeFailures || []) {
            const note = document.createElement('div');
            note.className = 'net-note';
            note.textContent = `No se liberó el contexto de ${failure.id}: ${failure.message}`;
            body.append(note);
        }
    }
    const heading = document.createElement('div');
    heading.className = 'net-heading';
    heading.textContent = 'SECCIONES';
    body.append(heading);
    if (data.mode === 'rotating') {
        // Con proxy rotativo la IP de cada sección es una foto, no una
        // identidad: se dice en pantalla para que nadie la tome por fija.
        const note = document.createElement('div');
        note.className = 'net-note';
        note.textContent = 'Modo rotativo: cada petición sale por una IP distinta. Para una IP fija por sección, define PYROCK_PROXY_STICKY_BASE (puertos 10000-20000).';
        body.append(note);
    }
    for (const section of data.sections || []) {
        const line = document.createElement('div');
        line.className = 'net-row net-section';
        const name = document.createElement('span');
        name.className = 'net-name';
        name.textContent = section.name;
        const ip = document.createElement('span');
        ip.className = 'net-value';
        const parts = [];
        if (data.mode === 'hybrid') {
            if (section.provider === 'free') parts.push('Gratis');
            if (section.provider === 'dataimpulse') parts.push('DataImpulse');
            const states = { connected: 'conectada', validating: 'comprobando gratuitas', recovering: 'reconectando', waiting: 'esperando proxy', failed: 'sin salida' };
            parts.push(states[section.state] || 'sin estado');
            if (section.ip) parts.push(section.ip);
            else if (section.state === 'waiting') parts.push('IP sin medir');
            if (section.port) parts.push(`puerto ${section.port}`);
            const reason = section.reason || section.freeReason;
            if (reason && section.state !== 'connected') parts.push(`motivo: ${reason}`);
            if (section.reconnects) parts.push(`${section.reconnects} reconexiones`);
            // The last manual request for a free exit, and why it found nothing.
            if (section.freeRequest?.reason && section.provider) parts.push(`sin IP gratis: ${section.freeRequest.reason}`);
        } else {
            if (section.measurementError) parts.push('Medición fallida');
            if (section.ip) parts.push(section.measurementError ? `Última IP: ${section.ip}` : section.ip);
            else parts.push('IP sin medir');
            if (section.port) parts.push(`puerto ${section.port}`);
            if (section.measuredAt) parts.push(new Date(section.measuredAt).toLocaleTimeString());
            if (section.ipCount > 1) parts.push(`${section.ipCount} IPs distintas`);
        }
        ip.textContent = parts.length ? parts.join(' · ') : 'sin medir';
        line.append(name, ip);
        if (data.mode === 'hybrid') {
            // A small lever to start the search again for this section alone.
            const request = document.createElement('button');
            request.type = 'button';
            request.className = 'net-request';
            request.textContent = 'IP gratis';
            request.title = 'Buscar otra salida para esta sección ahora';
            request.addEventListener('click', () => requestFreeIp(section.id, request));
            line.append(request);
        }
        body.append(line);
    }
    return data;
}

// The operator asks for the flow to start again for one section: it looks for
// a free exit first, and only then the paid fallback.
async function requestFreeIp(sectionId, button) {
    if (button) { button.disabled = true; button.textContent = 'buscando…'; }
    try {
        // The target section is explicit: the active session must not override it.
        await pyrock.makeRequest('/api/network/request', 'POST', { session: sectionId }, { includeSession: false });
    } catch (error) {
        addLog(`No se pudo pedir una IP gratis: ${error.message}`, 'error');
    }
    await renderNetwork();
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

async function openNetworkPanel() {
    startNetworkPolling();
    const data = await renderNetwork();
    // El modo híbrido ya sondea desde el gestor; abrir el panel solo lee su
    // estado compartido y no crea otra medición que compita con recuperación.
    if (data && data.mode !== 'hybrid' && data.sections.some(section => !section.ip)) measureNetwork();
}

function togglePanel(panelId) {
    if (!PANEL_TABS[panelId]) return;
    if (openPanelId === panelId) {
        closePanel();
        return;
    }
    if (openPanelId) {
        if (openPanelId === 'netPanel') stopNetworkPolling();
        setPanelState(openPanelId, false);
    }
    openPanelId = panelId;
    setPanelState(panelId, true);
    if (panelId === 'logPanel') {
        logBadge.hidden = true;
        renderLog(true);
        logContainer.scrollTop = logContainer.scrollHeight;
    }
    if (panelId === 'netPanel') openNetworkPanel();
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
// La página de arranque la publica el servidor; el cliente no inventa ninguna.
let startPageUrl = '';
// Página heredada por una sección nueva mientras todavía carga (el servidor la
// reporta en blanco hasta entonces) y texto de teclado de cada sección.
const pendingUrls = new Map();
const typedTexts = new Map();

function isBlankUrl(url) { return !url || url === 'about:blank'; }

// Lo que muestra el campo de Navegación: la URL real de la sección, o mientras
// carga la heredada y, en su defecto, la página de arranque. Nunca about:blank.
function displayUrl(section) {
    if (!isBlankUrl(section.url)) { pendingUrls.delete(section.id); return section.url; }
    return pendingUrls.get(section.id) || startPageUrl;
}

function showPreviewMode(mode) {
    const element = document.getElementById('previewMode');
    if (!element) return;
    if (mode === 'poll') element.textContent = 'sondeo de capturas';
    else if (mode === 'screencast') element.textContent = 'screencast';
    else element.textContent = '';
}

function applySectionState(section) {
    if (!section) return;
    const url = isBlankUrl(section.url) ? '' : section.url;
    if (url && url !== lastSectionUrl) {
        const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
        if (lastSectionUrl) addLog(`Se siguió una pestaña nueva: ${host}`, 'info');
        lastSectionUrl = url;
    }
    const field = document.getElementById('urlInput');
    // Lo que el operador está tipeando no se pisa.
    const shown = displayUrl(section);
    if (field && shown && shown !== field.value && document.activeElement !== field) field.value = shown;
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
    const text = document.getElementById('typeText').value;
    if (!text) {
        addLog('Escribe el texto a enviar', 'error');
        return;
    }

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
document.getElementById('logScope').addEventListener('click', () => {
// El interruptor cambia entre el registro de la sección activa y el de
// todas las secciones.
logScopeAll = !logScopeAll;
const scope = document.getElementById('logScope');
scope.setAttribute('aria-pressed', logScopeAll ? 'true' : 'false');
scope.textContent = logScopeAll ? 'todas' : 'esta';
renderLog(true);
});
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

// El refresco de la lista de secciones corre mientras el cliente está
// conectado: si la app se abrió con el servidor caído, la lista se puebla
// sola cuando el servidor vuelve.
let sessionRefreshTimer = null;
function startSessionRefresh() {
    if (sessionRefreshTimer !== null) return;
    sessionRefreshTimer = setInterval(() => { refreshSessions(); }, 3000);
}

async function refreshSessions() {
    if (!pyrock || !pyrock.isConnected || typeof pyrock.listSessions !== 'function') return;
    const result = await pyrock.listSessions();
    sessionRecords = result.sessions || []; sessionMaximum = result.max ?? 0;
    if (result.startUrl) startPageUrl = result.startUrl;
    const deckBus = document.getElementById('deckBus');
    if (deckBus) deckBus.textContent = `PVW → PGM · ${sessionRecords.find(s => s.id === activeSessionId)?.name || '—'}`;
    const list = document.getElementById('sessionList');
    const add = document.getElementById('sessionAdd');
    // Un máximo de 0 significa que no hay tope de secciones.
    const capped = sessionMaximum > 0;
    add.disabled = capped && sessionRecords.length >= sessionMaximum;
    add.title = add.disabled ? 'Límite de secciones alcanzado' : 'Agregar sección';
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
    // El editor y el registro son de la sección: lo que se estaba escribiendo
    // se guarda en la sección que se deja y se carga el de la que se entra.
    const previousId = activeSessionId;
    if (previousId) scriptState(previousId).content = scriptEditor.value;
    const typeField = document.getElementById('typeText');
    if (previousId) typedTexts.set(previousId, typeField.value);
    if (typedTexts.has(section.id)) typeField.value = typedTexts.get(section.id);
    activeSessionId = section.id; localStorage.setItem('pyrock.activeSession', section.id);
    // El registro sigue a la sección activa.
    renderLog();
    scriptEditor.value = scriptState(section.id).content;
    updateScriptUi(section.id);
    pyrock.switchSession(section.id); pendingFrameRender = false; queuedManualScreenshot = null;
    preview.style.display = 'none'; loadingText.style.display = 'block'; loadingText.textContent = 'Cargando sección…';
    const field = document.getElementById('urlInput');
    if (document.activeElement !== field) field.value = displayUrl(section);
    refreshSessions();
}
// La sección nueva hereda de la activa lo que el operador tiene en Navegación
// y en Control de Teclado, y navega a esa página. El texto solo se copia al
// campo: no se escribe en la página. Una URL en blanco no se hereda: ahí manda
// la página de arranque que abre el servidor.
async function createInheritingSection(name) {
    const inheritedUrl = document.getElementById('urlInput').value.trim();
    const inheritedText = document.getElementById('typeText').value;
    const result = await pyrock.createSession(name);
    const section = result.session;
    const inherits = /^https?:\/\//i.test(inheritedUrl);
    if (inherits) pendingUrls.set(section.id, inheritedUrl);
    typedTexts.set(section.id, inheritedText);
    await refreshSessions();
    activateSession(section);
    if (inherits) await navigate(inheritedUrl);
}
async function addSessionInline() {
    const list = document.getElementById('sessionList'); if (list.querySelector('input')) return;
    const li = document.createElement('li'), input = document.createElement('input'); input.setAttribute('aria-label', 'Nombre de sección');
    // Llega pre-cargado con el nombre siguiente; queda seleccionado para editar o reemplazar.
    input.value = `Sección ${sessionRecords.length + 1}`;
    li.append(input); list.prepend(li); const cancel = () => li.remove();
    input.addEventListener('keydown', async e => { if (e.key === 'Escape') cancel(); if (e.key === 'Enter') { try { await createInheritingSection(input.value.trim() || undefined); } catch (error) { addLog(error.message, 'error'); } } });
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
                // Si la app se abrió con el servidor caído, cuando el cliente
                // vuelve a conectar la lista de secciones tiene que poblarse.
                if (connected) {
                    refreshSessions();
                    startSessionRefresh();
                }
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
                startSessionRefresh();
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
        // Cada sección tendrá su propio parser, con su cliente y su estado.
        scriptParserAvailable = true;
        addLog('Parser de scripts inicializado con indicadores visuales', 'success');
    } else {
        addLog('Advertencia: Parser de scripts no disponible', 'error');
    }

});

window.addEventListener('pagehide', () => {
    if (pyrock) pyrock.disconnect();
});

// ===== FUNCIONES DE MANEJO DE SCRIPTS =====

// El estado de scripts de una sección: su contenido, su archivo, si está
// corriendo y su propio parser.
function scriptState(sectionId = activeSessionId) {
    const id = sectionId || 'default';
    if (!scriptStates.has(id)) {
        scriptStates.set(id, { id, content: '', fileName: '', running: false, status: 'Listo', progress: '', parser: null });
    }
    return scriptStates.get(id);
}

// El parser de una sección: el suyo, con el cliente de esa sección y con el
// indicador de clic solo si esa sección está en pantalla.
function scriptParserFor(sectionId) {
    const state = scriptState(sectionId);
    if (!state.parser) {
        const visualIndicators = {
            showClickIndicator: (...args) => { if (activeSessionId === state.id) showClickIndicator(...args); },
            getIndicatorPosition
        };
        state.parser = new PyRockScriptParser(pyrock.forSession(state.id), visualIndicators);
    }
    return state.parser;
}

// El panel de scripts muestra siempre el de la sección activa.
function updateScriptUi(sectionId = activeSessionId) {
    const state = scriptState(sectionId);
    if (state.id !== activeSessionId) return;
    scriptStatus.textContent = `Estado: ${state.status}`;
    scriptProgress.textContent = state.progress;
    executeBtn.disabled = state.running;
    stopBtn.disabled = !state.running;
}

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
            // El archivo cargado es el de la sección activa: las otras
            // secciones no se tocan.
            const state = scriptState();
            if (state.running) stopScript();
            if (state.parser) {
                state.parser.commands = [];
                state.parser.currentLine = 0;
            }
            scriptEditor.value = e.target.result;
            state.content = e.target.result;
            state.fileName = file.name;
            state.status = 'Script cargado';
            state.progress = '';
            updateScriptUi(state.id);
            addLog(`Script cargado: ${file.name} - Editor restablecido`, 'success', state.id);
        };
        reader.readAsText(file);
    }
    
    // Limpiar el input para permitir cargar el mismo archivo nuevamente
    event.target.value = '';
});

// Ejecutar script
async function executeScript() {
    if (!scriptParserAvailable) {
        addLog('Error: Parser de scripts no disponible', 'error');
        return;
    }

    if (!pyrock || !pyrock.isConnected) {
        addLog('Error: No hay conexión con PyRock', 'error');
        return;
    }

    const state = scriptState();
    const scriptContent = scriptEditor.value.trim();
    if (!scriptContent) {
        addLog('Error: No hay script para ejecutar', 'error', state.id);
        return;
    }

    if (state.running) {
        addLog('Ya hay un script ejecutándose en esta sección', 'error', state.id);
        return;
    }

    const parser = scriptParserFor(state.id);
    // El log de un script pertenece a la sección en la que corre, no a la que
    // esté en pantalla.
    const log = (message, type) => addLog(message, type, state.id);
    try {
        state.content = scriptContent;
        state.running = true;
        state.status = 'Ejecutando...';
        state.progress = '';
        updateScriptUi(state.id);

        log('Iniciando ejecución de script', 'info');

        // Cargar y validar script
        const commands = parser.loadScript(scriptContent);
        
        log(`Script validado: ${commands.length} comandos encontrados`, 'success');

        // Ejecutar comandos con soporte para saltos y bucles
        parser.currentLine = 0;
        
        while (parser.currentLine < commands.length && state.running) {
            const command = commands[parser.currentLine];
            state.progress = `Comando ${parser.currentLine + 1}/${commands.length}: Línea ${command.lineNumber}`;
            updateScriptUi(state.id);
            
            log(`Ejecutando línea ${command.lineNumber}: ${command.originalLine}`, 'info');

            try {
                await parser.executeCommand(command);
                
                // Solo avanzar si no hubo salto (loop)
                const previousLine = parser.currentLine;
                parser.currentLine++;
                
                // Si hubo un salto, currentLine ya fue modificado por el comando
                if (parser.currentLine !== previousLine + 1) {
                    continue; // No hacer pausa en saltos
                }
                
                // Pequeña pausa entre comandos para mejor visualización
                if (parser.currentLine < commands.length && state.running) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            } catch (error) {
                log(`Error ejecutando comando: ${error.message}`, 'error');
                break;
            }
        }

        if (state.running) {
            log('Script ejecutado completamente', 'success');
            state.status = 'Completado';
        } else {
            state.status = 'Cancelado';
        }

    } catch (error) {
        state.status = 'Error';
        addLog(`Error en script: ${error.message}`, 'error', state.id);
    } finally {
        state.running = false;

        // Limpiar parser
        if (parser) {
            parser.commands = [];
            parser.currentLine = 0;
        }
        state.progress = '';
        updateScriptUi(state.id);
        
        // Si no hay error específico, marcar como listo
        if (state.status === 'Completado' || state.status === 'Cancelado' || state.status === 'Error') {
            setTimeout(() => {
                if (!state.running) {
                    state.status = 'Listo';
                    updateScriptUi(state.id);
                }
            }, 2000);
        }
    }
}

// Parar ejecución de script
function stopScript() {
    const state = scriptState();
    if (!state.running) return;
    // El loop ve que ya no corre y termina; su finally deja el estado limpio.
    state.running = false;
    addLog('Deteniendo ejecución de script...', 'info', state.id);
    updateScriptUi(state.id);
}

// El estado y el progreso del script viven en el estado de su sección; la
// UI los muestra a través de updateScriptUi.

// Script state is restored by executeScript's finally block.