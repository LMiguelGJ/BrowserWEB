/**
 * PyRock HTTP Client - Alternativa a WebSocket usando REST API
 */
class PyRockHTTP {
    constructor(options = {}) {
        this.serverUrl = options.serverUrl || 'http://localhost:3000';
        this.pollingInterval = options.pollingInterval || 2000; // 2 segundos
        this.statusPollIntervalMs = options.statusPollIntervalMs || 30000; // estado cada 30s
        this.maxRetries = options.maxRetries ?? 3;
        this.retryDelay = options.retryDelay ?? 1000;
        this.isPolling = false;
        this.pollingTimer = null;
        
        // Callbacks
        this.onLog = options.onLog || console.log;
        this.onStatusChange = options.onStatusChange || (() => {});
        this.onScreenshotUpdate = options.onScreenshotUpdate || (() => {});
        
        // Estado
        this.isConnected = false;
        this.lastActionTimestamp = 0;
        this.lastStatusCheckAt = 0;
    }
    
    /**
     * Iniciar conexión y polling
     */
    async connect() {
        try {
            const response = await this.makeRequest('/api/status');
            if (response.success) {
                this.isConnected = true;
                this.onStatusChange('connected');
                this.onLog('Conectado al servidor PyRock via HTTP');
                
                // Inicializar navegador automáticamente si no está inicializado
                if (response.browser === 'disconnected') {
                    this.onLog('Inicializando navegador automáticamente...');
                    try {
                        await this.initBrowser();
                    } catch (error) {
                        this.onLog(`Error inicializando navegador: ${error.message}`);
                    }
                }
                
                // Iniciar polling para capturas automáticas cada segundo
                this.startPolling();
                
                // Tomar primera captura inmediatamente
                setTimeout(() => this.getLatestScreenshot(), 1000);
                
                return true;
            }
        } catch (error) {
            this.onLog(`Error conectando: ${error.message}`);
            this.isConnected = false;
            this.onStatusChange('disconnected');
        }
        return false;
    }
    
    /**
     * Desconectar y detener polling
     */
    disconnect() {
        this.isConnected = false;
        this.stopPolling();
        this.onStatusChange('disconnected');
        this.onLog('Desconectado del servidor PyRock');
    }
    
    /**
     * Iniciar polling para actualizaciones
     */
    startPolling() {
        if (this.isPolling) return;
        
        this.isPolling = true;
        this.pollingTimer = setInterval(async () => {
            try {
                await this.checkForUpdates();
            } catch (error) {
                this.onLog(`Error en polling: ${error.message}`);
            }
        }, this.pollingInterval);
    }
    
    /**
     * Detener polling
     */
    stopPolling() {
        if (this.pollingTimer) {
            clearInterval(this.pollingTimer);
            this.pollingTimer = null;
        }
        this.isPolling = false;
    }
    
    /**
     * Verificar actualizaciones del servidor
     */
    async checkForUpdates() {
        try {
            // Tomar screenshot automáticamente cada vez que se ejecuta el polling
            await this.getLatestScreenshot();
            
            // Consultar estado con menor frecuencia
            const now = Date.now();
            if (now - this.lastStatusCheckAt >= this.statusPollIntervalMs) {
                const status = await this.makeRequest('/api/status');
                if (status.success && status.lastAction) {
                    // Actualizar timestamp de la última acción
                    if (status.lastAction.timestamp > this.lastActionTimestamp) {
                        this.lastActionTimestamp = status.lastAction.timestamp;
                    }
                }
                this.lastStatusCheckAt = now;
            }
        } catch (error) {
            // Error silencioso en polling para no saturar logs
        }
    }
    
    /**
     * Obtener último screenshot
     */
    async getLatestScreenshot() {
        try {
            const response = await this.makeRequest('/api/screenshot');
            if (response.success && response.screenshot) {
                this.onScreenshotUpdate(response.screenshot);
            }
        } catch (error) {
            this.onLog(`Error obteniendo screenshot: ${error.message}`);
        }
    }
    
    /**
     * Realizar petición HTTP
     */
    async makeRequest(endpoint, method = 'GET', data = null) {
        const url = `${this.serverUrl}${endpoint}`;
        const options = {
            method: method,
            headers: {
                'Content-Type': 'application/json',
            }
        };
        
        if (data && method !== 'GET') {
            options.body = JSON.stringify(data);
        }
        
        let attempt = 0;
        while (true) {
            try {
                const response = await fetch(url, options);
                if (!response.ok) {
                    const status = response.status;
                    const statusText = response.statusText;
                    // Reintentos para errores temporales del proxy/upstream
                    if (attempt < this.maxRetries && [503, 502, 504, 429].includes(status)) {
                        attempt++;
                        await new Promise(r => setTimeout(r, this.retryDelay * attempt));
                        continue;
                    }
                    throw new Error(`HTTP ${status}: ${statusText}`);
                }
                return await response.json();
            } catch (error) {
                // Reintentar también ante errores de red
                if (attempt < this.maxRetries) {
                    attempt++;
                    await new Promise(r => setTimeout(r, this.retryDelay * attempt));
                    continue;
                }
                throw error;
            }
        }
    }
    
    /**
     * Navegar a URL
     */
    async navigate(url) {
        if (!this.isConnected) {
            throw new Error('No conectado al servidor');
        }
        
        this.onLog(`Navegando a: ${url}`);
        const result = await this.makeRequest('/api/navigate', 'POST', { url });
        
        if (result.success) {
            this.onLog(`Navegación exitosa: ${result.message || 'OK'}`);
            // Tomar screenshot automáticamente después de navegar
            setTimeout(() => this.takeScreenshot(), 1000);
        } else {
            this.onLog(`Error navegando: ${result.error}`);
        }
        
        return result;
    }
    
    /**
     * Tomar screenshot
     */
    async takeScreenshot() {
        if (!this.isConnected) {
            throw new Error('No conectado al servidor');
        }
        
        // Comentado para reducir spam: this.onLog('Tomando screenshot...');
        const result = await this.makeRequest('/api/screenshot', 'POST');
        
        if (result.success) {
            // Comentado para reducir spam: this.onLog('Screenshot tomado exitosamente');
            if (result.screenshot) {
                this.onScreenshotUpdate(result.screenshot);
            }
        } else {
            this.onLog(`Error tomando screenshot: ${result.error}`);
        }
        
        return result;
    }
    
    /**
     * Click en coordenadas
     */
    async click(x, y) {
        if (!this.isConnected) {
            throw new Error('No conectado al servidor');
        }
        
        this.onLog(`Haciendo click en (${x}, ${y})`);
        const result = await this.makeRequest('/api/click', 'POST', { x, y });
        
        if (result.success) {
            this.onLog(`Click exitoso en (${x}, ${y})`);
            // Tomar screenshot automáticamente después del click
            setTimeout(() => this.takeScreenshot(), 500);
        } else {
            this.onLog(`Error en click: ${result.error}`);
        }
        
        return result;
    }
    
    /**
     * Escribir texto
     */
    async type(text) {
        if (!this.isConnected) {
            throw new Error('No conectado al servidor');
        }
        
        this.onLog(`Escribiendo texto: "${text}"`);
        const result = await this.makeRequest('/api/type', 'POST', { text });
        
        if (result.success) {
            this.onLog(`Texto escrito exitosamente: "${text}"`);
            // Tomar screenshot automáticamente después de escribir
            setTimeout(() => this.takeScreenshot(), 500);
        } else {
            this.onLog(`Error escribiendo texto: ${result.error}`);
        }
        
        return result;
    }
    
    /**
     * Presionar tecla
     */
    async pressKey(key) {
        if (!this.isConnected) {
            throw new Error('No conectado al servidor');
        }
        
        this.onLog(`Presionando tecla: ${key}`);
        const result = await this.makeRequest('/api/key', 'POST', { key });
        
        if (result.success) {
            this.onLog(`Tecla presionada exitosamente: ${key}`);
            // Tomar screenshot automáticamente después de presionar tecla
            setTimeout(() => this.takeScreenshot(), 500);
        } else {
            this.onLog(`Error presionando tecla: ${result.error}`);
        }
        
        return result;
    }
    
    /**
     * Inicializar navegador
     */
    async initBrowser() {
        if (!this.isConnected) {
            throw new Error('No conectado al servidor');
        }
        
        this.onLog('Inicializando navegador...');
        const result = await this.makeRequest('/api/init', 'POST');
        
        if (result.success) {
            this.onLog('Navegador inicializado exitosamente');
        } else {
            this.onLog(`Error inicializando navegador: ${result.error}`);
        }
        
        return result;
    }
    
    /**
     * Obtener estado del servidor
     */
    async getStatus() {
        const result = await this.makeRequest('/api/status');
        return result;
    }
}

// Exportar para uso global
window.PyRockHTTP = PyRockHTTP;