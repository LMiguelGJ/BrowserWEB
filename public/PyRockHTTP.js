/**
 * PyRock HTTP client for REST controls and the live preview WebSocket.
 */
class PyRockHTTP {
    constructor(options = {}) {
        this.serverUrl = options.serverUrl || 'http://localhost:3000';
        this.sessionId = options.sessionId ?? null;
        this.onSessionGone = options.onSessionGone || (() => {});
        this.statusPollIntervalMs = options.statusPollIntervalMs || 30000;
        this.maxRetries = options.maxRetries ?? 3;
        this.retryDelay = options.retryDelay ?? 1000;
        this.statusTimer = null;
        this.reconnectTimer = null;
        this.previewSocket = null;
        this.connectPromise = null;
        this.connectionGeneration = 0;
        this.retryIndex = 0;
        this.isConnected = false;
        this.isDisconnecting = false;
        this.lastActionTimestamp = 0;
        this.lastStatusCheckAt = 0;

        this.onLog = options.onLog || console.log;
        this.onStatusChange = options.onStatusChange || (() => {});
        this.onPreviewStatus = options.onPreviewStatus || (() => {});
        this.onScreenshotUpdate = options.onScreenshotUpdate || (() => {});
    }

    connect() {
        if (this.isConnected && !this.isDisconnecting) return Promise.resolve(true);
        if (this.connectPromise) return this.connectPromise;
        const promise = this.connectOnce();
        this.connectPromise = promise;
        const clearPromise = () => {
            if (this.connectPromise === promise) this.connectPromise = null;
        };
        promise.then(clearPromise, clearPromise);
        return promise;
    }

    async connectOnce() {
        const generation = ++this.connectionGeneration;
        this.isDisconnecting = false;
        try {
            const response = await this.makeRequest('/api/status');
            if (generation !== this.connectionGeneration) return false;
            if (!response.success) return false;

            this.isConnected = true;
            this.retryIndex = 0;
            this.onStatusChange('connected');
            this.onLog('Conectado al servidor PyRock via HTTP');
            if (response.browser === 'disconnected') {
                this.onLog('Inicializando navegador automáticamente...');
                try {
                    await this.initBrowser({ all: true });
                } catch (error) {
                    this.onLog(`Error inicializando navegador: ${error.message}`);
                }
            }
            if (generation !== this.connectionGeneration || !this.isConnected) return false;
            this.scheduleStatusCheck(generation);
            this.openPreviewSocket(generation);
            return true;
        } catch (error) {
            if (generation === this.connectionGeneration && error.status === 404 && this.sessionId) {
                const staleId = this.sessionId;
                this.sessionId = null;
                const recovered = await this.connectOnce();
                if (recovered) await this.onSessionGone(staleId);
                return recovered;
            }
            if (generation === this.connectionGeneration) {
                this.onLog(`Error conectando: ${error.message}`);
                this.isConnected = false;
                this.onStatusChange('disconnected');
                this.scheduleConnectRetry(generation);
            }
            return false;
        }
    }

    disconnect() {
        if (this.isDisconnecting) return;
        this.isDisconnecting = true;
        this.connectionGeneration++;
        this.connectPromise = null;
        this.isConnected = false;
        this.clearStatusTimer();
        this.clearReconnectTimer();
        const socket = this.previewSocket;
        this.previewSocket = null;
        if (socket && socket.readyState < 2) socket.close();
        this.onPreviewStatus('unavailable', 'Preview disconnected');
        this.onStatusChange('disconnected');
        this.onLog('Desconectado del servidor PyRock');
    }

    previewUrl() {
        try {
            const url = new URL(this.serverUrl);
            url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            url.pathname = '/ws/preview';
            url.search = this.sessionId ? `?session=${encodeURIComponent(this.sessionId)}` : '';
            url.hash = '';
            return url.toString();
        } catch (error) {
            this.onPreviewStatus('unavailable', error.message);
            return null;
        }
    }

    openPreviewSocket(generation) {
        if (!this.isConnected || generation !== this.connectionGeneration || this.isDisconnecting) return;
        this.clearReconnectTimer();
        this.onPreviewStatus('starting');
        const url = this.previewUrl();
        if (!url) {
            this.scheduleReconnect(generation);
            return;
        }
        let socket;
        try {
            socket = new WebSocket(url);
        } catch (error) {
            this.onPreviewStatus('unavailable', error.message);
            this.scheduleReconnect(generation);
            return;
        }
        this.previewSocket = socket;
        socket.onopen = () => {
            if (!this.isCurrentSocket(socket, generation)) return;
            this.onPreviewStatus('starting');
        };
        socket.onmessage = event => this.handlePreviewMessage(socket, generation, event.data);
        socket.onerror = () => {
            if (this.isCurrentSocket(socket, generation)) this.onPreviewStatus('unavailable', 'Preview WebSocket error');
        };
        socket.onclose = event => {
            if (!this.isCurrentSocket(socket, generation)) return;
            this.previewSocket = null;
            if (event?.code === 4404) {
                this.onPreviewStatus('unavailable', 'Sección no encontrada');
                this.onSessionGone(this.sessionId);
                return;
            }
            this.onPreviewStatus('reconnecting');
            this.scheduleReconnect(generation);
        };
    }

    isCurrentSocket(socket, generation) {
        return this.isConnected && !this.isDisconnecting &&
            generation === this.connectionGeneration && this.previewSocket === socket;
    }

    handlePreviewMessage(socket, generation, raw) {
        if (!this.isCurrentSocket(socket, generation)) return;
        let message;
        try {
            message = JSON.parse(raw);
        } catch (error) {
            this.onLog(`Mensaje de preview inválido: ${error.message}`);
            return;
        }
        if (!message || typeof message !== 'object') return;
        if (message.type === 'status' && ['starting', 'live', 'unavailable'].includes(message.state)) {
            this.onPreviewStatus(message.state, typeof message.message === 'string' ? message.message : undefined);
            return;
        }
        if (message.type === 'error' && typeof message.message === 'string') {
            this.onPreviewStatus('unavailable', message.message);
            return;
        }
        if (message.type !== 'frame' || !Number.isSafeInteger(message.id) || typeof message.data !== 'string') return;

        let completed = false;
        const finish = renderError => {
            if (completed) return;
            completed = true;
            if (!this.isCurrentSocket(socket, generation) || socket.readyState !== WebSocket.OPEN) return;
            try {
                socket.send(JSON.stringify({ type: 'ack', id: message.id }));
                if (!renderError) {
                    this.retryIndex = 0;
                    this.onPreviewStatus('live');
                } else {
                    this.onLog(`Error renderizando frame de preview: ${renderError.message || renderError}`);
                }
            } catch (error) {
                this.onLog(`Error confirmando frame de preview: ${error.message}`);
            }
        };
        try {
            this.onScreenshotUpdate(message.data, finish);
        } catch (error) {
            this.onLog(`Error mostrando frame de preview: ${error.message}`);
            finish(error);
        }
    }

    scheduleReconnect(generation) {
        if (!this.isConnected || this.isDisconnecting || generation !== this.connectionGeneration || this.reconnectTimer) return;
        const delays = [1000, 2000, 4000, 8000, 10000];
        const delay = delays[Math.min(this.retryIndex, delays.length - 1)];
        this.retryIndex = Math.min(this.retryIndex + 1, delays.length - 1);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.openPreviewSocket(generation);
        }, delay);
    }

    // When the server is down the client keeps trying to connect on its own: a
    // tab that was open during a restart recovers by itself, without the
    // operator having to reload the page.
    scheduleConnectRetry(generation) {
        if (this.isConnected || this.isDisconnecting || generation !== this.connectionGeneration || this.reconnectTimer) return;
        const delays = [1000, 2000, 4000, 8000, 10000];
        const delay = delays[Math.min(this.retryIndex, delays.length - 1)];
        this.retryIndex = Math.min(this.retryIndex + 1, delays.length - 1);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            return this.connectOnce().catch(() => {});
        }, delay);
    }

    clearReconnectTimer() {
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    scheduleStatusCheck(generation) {
        this.clearStatusTimer();
        if (!this.isConnected || generation !== this.connectionGeneration) return;
        this.statusTimer = setTimeout(async () => {
            this.statusTimer = null;
            if (!this.isConnected || generation !== this.connectionGeneration) return;
            try {
                const status = await this.makeRequest('/api/status');
                if (status.success && status.lastAction && status.lastAction.timestamp > this.lastActionTimestamp) {
                    this.lastActionTimestamp = status.lastAction.timestamp;
                }
                this.lastStatusCheckAt = Date.now();
            } catch (error) {
                this.onLog(`Error consultando estado: ${error.message}`);
            } finally {
                this.scheduleStatusCheck(generation);
            }
        }, this.statusPollIntervalMs);
    }

    clearStatusTimer() {
        if (this.statusTimer !== null) {
            clearTimeout(this.statusTimer);
            this.statusTimer = null;
        }
    }

    async makeRequest(endpoint, method = 'GET', data = null, { includeSession = true } = {}) {
        const isSessionManagement = endpoint === '/api/sessions' || endpoint.startsWith('/api/sessions/');
        if (includeSession && !isSessionManagement && this.sessionId && method === 'GET') {
            const separator = endpoint.includes('?') ? '&' : '?';
            endpoint = `${endpoint}${separator}session=${encodeURIComponent(this.sessionId)}`;
        }
        const url = `${this.serverUrl}${endpoint}`;
        if (includeSession && !isSessionManagement && this.sessionId && endpoint.startsWith('/api/') && method !== 'GET') {
            data = { ...(data || {}), session: this.sessionId };
        }
        const options = { method, headers: { 'Content-Type': 'application/json' } };
        if (data && method !== 'GET') options.body = JSON.stringify(data);
        let attempt = 0;
        while (true) {
            try {
                const response = await fetch(url, options);
                if (!response.ok) {
                    const status = response.status;
                    const statusText = response.statusText;
                    if (attempt < this.maxRetries && [503, 502, 504, 429].includes(status)) {
                        attempt++;
                        await new Promise(resolve => setTimeout(resolve, this.retryDelay * attempt));
                        continue;
                    }
                    const error = new Error(`HTTP ${status}: ${statusText}`);
                    error.status = status;
                    if (status === 404 && this.sessionId && this.isConnected) this.onSessionGone(this.sessionId);
                    throw error;
                }
                return await response.json();
            } catch (error) {
                if (attempt < this.maxRetries && !error.status) {
                    attempt++;
                    await new Promise(resolve => setTimeout(resolve, this.retryDelay * attempt));
                    continue;
                }
                throw error;
            }
        }
    }

    async navigate(url) {
        if (!this.isConnected) throw new Error('No conectado al servidor');
        this.onLog(`Navegando a: ${url}`);
        const result = await this.makeRequest('/api/navigate', 'POST', { url });
        if (result.success) this.onLog(`Navegación exitosa: ${result.message || 'OK'}`);
        else this.onLog(`Error navegando: ${result.error}`);
        return result;
    }

    async takeScreenshot() {
        if (!this.isConnected) throw new Error('No conectado al servidor');
        const requestedSession = this.sessionId;
        const result = await this.makeRequest('/api/screenshot', 'POST');
        if (result.success) {
            if (result.screenshot && this.sessionId === requestedSession) this.onScreenshotUpdate(result.screenshot);
        } else this.onLog(`Error tomando screenshot: ${result.error}`);
        return result;
    }

    async click(x, y, { humanize } = {}) {
        if (!this.isConnected) throw new Error('No conectado al servidor');
        this.onLog(`Haciendo click en (${x}, ${y})`);
        const result = await this.makeRequest('/api/click', 'POST', { x, y, ...(humanize === undefined ? {} : { humanize }) });
        if (result.success) this.onLog(`Click exitoso en (${x}, ${y})`);
        else this.onLog(`Error en click: ${result.error}`);
        return result;
    }

    async type(text, { humanize } = {}) {
        if (!this.isConnected) throw new Error('No conectado al servidor');
        this.onLog(`Escribiendo texto: "${text}"`);
        const result = await this.makeRequest('/api/type', 'POST', { text, ...(humanize === undefined ? {} : { humanize }) });
        if (result.success) this.onLog(`Texto escrito exitosamente: "${text}"`);
        else this.onLog(`Error escribiendo texto: ${result.error}`);
        return result;
    }

    async pressKey(key) {
        if (!this.isConnected) throw new Error('No conectado al servidor');
        this.onLog(`Presionando tecla: ${key}`);
        const result = await this.makeRequest('/api/key', 'POST', { key });
        if (result.success) this.onLog(`Tecla presionada exitosamente: ${key}`);
        else this.onLog(`Error presionando tecla: ${result.error}`);
        return result;
    }

    async initBrowser({ all = false } = {}) {
        if (!this.isConnected) throw new Error('No conectado al servidor');
        this.onLog('Inicializando navegador...');
        const result = await this.makeRequest('/api/init', 'POST', {}, { includeSession: !all });
        if (result.success) this.onLog('Navegador inicializado exitosamente');
        else this.onLog(`Error inicializando navegador: ${result.error}`);
        return result;
    }

    async listSessions() { return this.makeRequest('/api/sessions'); }
    async createSession(name) { return this.makeRequest('/api/sessions', 'POST', name ? { name } : {}); }
    async closeSession(id) { return this.makeRequest(`/api/sessions/${encodeURIComponent(id)}`, 'DELETE'); }

    switchSession(id) {
        if (this.sessionId === id) return;
        this.sessionId = id;
        this.retryIndex = 0;
        this.clearReconnectTimer();
        const socket = this.previewSocket;
        this.previewSocket = null;
        if (socket && socket.readyState < 2) socket.close();
        if (this.isConnected) this.openPreviewSocket(this.connectionGeneration);
    }

    forSession(id) {
        const client = Object.create(this);
        client.sessionId = id;
        return client;
    }

    async getStatus() {
        return await this.makeRequest('/api/status');
    }
}

window.PyRockHTTP = PyRockHTTP;
