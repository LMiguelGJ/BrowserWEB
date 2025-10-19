/**
 * PyRockCommands.js - Librería de comandos para PyRock
 * Versión: 1.0.0
 * Descripción: Librería JavaScript para controlar PyRock de forma modular
 */

class PyRockCommands {
    constructor() {
        this.ws = null;
        this.isConnected = false;
        this.logCallback = null;
        this.statusCallback = null;
        
        // Configuración por defecto
        this.config = {
            serverUrl: 'ws://localhost:3000',
            autoReconnect: true,
            reconnectDelay: 3000,
            maxReconnectAttempts: 5,
            logLevel: 'info' // 'debug', 'info', 'warn', 'error'
        };
        
        this.reconnectAttempts = 0;
    }

    /**
     * Configurar la librería
     * @param {Object} options - Opciones de configuración
     */
    configure(options = {}) {
        this.config = { ...this.config, ...options };
        return this;
    }

    /**
     * Establecer callback para logs
     * @param {Function} callback - Función que recibe (message, type)
     */
    onLog(callback) {
        this.logCallback = callback;
        return this;
    }

    /**
     * Establecer callback para cambios de estado
     * @param {Function} callback - Función que recibe (connected, message)
     */
    onStatusChange(callback) {
        this.statusCallback = callback;
        return this;
    }

    /**
     * Log interno
     * @private
     */
    _log(message, type = 'info') {
        if (this.logCallback) {
            this.logCallback(message, type);
        } else {
            console.log(`[PyRock ${type.toUpperCase()}] ${message}`);
        }
    }

    /**
     * Actualizar estado de conexión
     * @private
     */
    _updateStatus(connected, message = '') {
        this.isConnected = connected;
        if (this.statusCallback) {
            this.statusCallback(connected, message);
        }
    }

    /**
     * Conectar al servidor WebSocket
     */
    async connect() {
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(this.config.serverUrl);
                
                this.ws.onopen = () => {
                    this._updateStatus(true, 'Conectado al servidor PyRock');
                    this._log('Conectado al servidor PyRock', 'success');
                    this.reconnectAttempts = 0;
                    resolve(true);
                };

                this.ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        this._handleMessage(data);
                    } catch (error) {
                        this._log(`Error procesando mensaje: ${error.message}`, 'error');
                    }
                };

                this.ws.onclose = () => {
                    this._updateStatus(false, 'Conexión WebSocket cerrada');
                    this._log('Conexión WebSocket cerrada', 'error');
                    
                    if (this.config.autoReconnect && this.reconnectAttempts < this.config.maxReconnectAttempts) {
                        this._attemptReconnect();
                    }
                };

                this.ws.onerror = (error) => {
                    this._log('Error de conexión WebSocket', 'error');
                    reject(error);
                };

            } catch (error) {
                this._log(`Error al conectar WebSocket: ${error.message}`, 'error');
                reject(error);
            }
        });
    }

    /**
     * Intentar reconexión automática
     * @private
     */
    _attemptReconnect() {
        this.reconnectAttempts++;
        this._log(`Intentando reconexión (${this.reconnectAttempts}/${this.config.maxReconnectAttempts})...`, 'info');
        
        setTimeout(() => {
            this.connect().catch(() => {
                if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
                    this._log('Máximo de intentos de reconexión alcanzado', 'error');
                }
            });
        }, this.config.reconnectDelay);
    }

    /**
     * Manejar mensajes del servidor
     * @private
     */
    _handleMessage(data) {
        const { type, message, success, error, screenshot } = data;

        switch (type) {
            case 'status':
                this._log(message || 'Estado recibido', 'info');
                break;

            case 'navigate_result':
                if (success) {
                    this._log(message || 'Navegación exitosa', 'success');
                } else {
                    this._log(error || 'Error navegando', 'error');
                }
                break;

            case 'screenshot_result':
                if (success && screenshot) {
                    this._log('Screenshot capturado', 'success');
                    // Actualizar la imagen del preview
                    const preview = document.getElementById('preview');
                    if (preview) {
                        preview.src = screenshot;
                        const lastUpdate = document.getElementById('lastUpdate');
                        if (lastUpdate) {
                            lastUpdate.textContent = new Date().toLocaleTimeString();
                        }
                    }
                } else {
                    this._log(error || 'Error capturando screenshot', 'error');
                }
                break;

            case 'click_result':
                if (success) {
                    this._log(message || 'Click realizado', 'success');
                } else {
                    this._log(error || 'Error realizando click', 'error');
                }
                break;

            case 'type_result':
                if (success) {
                    this._log(message || 'Texto escrito', 'success');
                } else {
                    this._log(error || 'Error escribiendo texto', 'error');
                }
                break;

            case 'error':
                this._log(message || 'Error del servidor', 'error');
                break;

            default:
                this._log(`Mensaje no reconocido: ${type}`, 'warn');
        }
    }

    /**
     * Enviar comando al servidor
     * @private
     */
    _sendCommand(command) {
        if (!this.isConnected || !this.ws) {
            this._log('No hay conexión con el servidor', 'error');
            return false;
        }

        try {
            this.ws.send(JSON.stringify(command));
            return true;
        } catch (error) {
            this._log(`Error enviando comando: ${error.message}`, 'error');
            return false;
        }
    }

    // ==================== COMANDOS DE NAVEGACIÓN ====================

    /**
     * Navegar a una URL
     * @param {string} url - URL de destino
     */
    navigate(url) {
        if (!url || typeof url !== 'string') {
            this._log('URL inválida', 'error');
            return false;
        }

        this._log(`Navegando a: ${url}`, 'info');
        
        return this._sendCommand({
            type: 'navigate',
            payload: { url: url }
        });

    }

    // ==================== COMANDOS DE MOUSE ====================

    /**
     * Hacer click en coordenadas específicas
     * @param {number} x - Coordenada X
     * @param {number} y - Coordenada Y
     */
    click(x, y) {
        if (typeof x !== 'number' || typeof y !== 'number') {
            this._log('Coordenadas inválidas para click', 'error');
            return false;
        }

        this._log(`Click en (${x}, ${y})`, 'info');
        
        return this._sendCommand({
            type: 'click',
            payload: { x: x, y: y }
        });
    }

    // ==================== COMANDOS DE TECLADO ====================

    /**
     * Escribir texto
     * @param {string} text - Texto a escribir
     */
    type(text) {
        if (!text || typeof text !== 'string') {
            this._log('Texto requerido para escribir', 'error');
            return false;
        }

        this._log(`Escribiendo: "${text}"`, 'info');
        
        return this._sendCommand({
            type: 'type',
            payload: { text: text }
        });
    }

    /**
     * Presionar tecla especial
     * @param {string} key - Tecla a presionar (Enter, Tab, Escape, etc.)
     */
    pressKey(key) {
        if (!key || typeof key !== 'string') {
            this._log('Tecla requerida', 'error');
            return false;
        }

        const success = this._sendCommand({
            type: 'key',
            key: key
        });

        if (success) {
            this._log(`Tecla enviada: ${key}`, 'info');
        }

        return success;
    }

    /**
     * Presionar Enter
     */
    enter() {
        return this.pressKey('Enter');
    }

    /**
     * Presionar Tab
     */
    tab() {
        return this.pressKey('Tab');
    }

    /**
     * Presionar Escape
     */
    escape() {
        return this.pressKey('Escape');
    }

    // ==================== COMANDOS DE SISTEMA ====================

    /**
     * Obtener estado del sistema
     */
    getStatus() {
        const success = this._sendCommand({
            type: 'status'
        });

        if (success) {
            this._log('Solicitando estado del sistema', 'info');
        }

        return success;
    }

    /**
     * Reinicializar navegador
     */
    initBrowser() {
        const success = this._sendCommand({
            type: 'init'
        });

        if (success) {
            this._log('Reinicializando navegador...', 'info');
        }

        return success;
    }

    /**
     * Tomar captura de pantalla
     */
    takeScreenshot() {
        this._log('Solicitando captura de pantalla...', 'info');
        
        return this._sendCommand({
            type: 'screenshot'
        });
    }

    // ==================== COMANDOS COMBINADOS ====================

    /**
     * Ejecutar secuencia de comandos con delays
     * @param {Array} commands - Array de comandos {action, params, delay}
     */
    async executeSequence(commands) {
        if (!Array.isArray(commands)) {
            this._log('Se requiere un array de comandos', 'error');
            return false;
        }

        this._log(`Ejecutando secuencia de ${commands.length} comandos`, 'info');

        for (let i = 0; i < commands.length; i++) {
            const cmd = commands[i];
            
            try {
                // Ejecutar comando
                switch (cmd.action) {
                    case 'navigate':
                        this.navigate(cmd.params.url);
                        break;
                    case 'click':
                        this.click(cmd.params.x, cmd.params.y);
                        break;
                    case 'type':
                        this.type(cmd.params.text);
                        break;
                    case 'key':
                        this.pressKey(cmd.params.key);
                        break;
                    case 'wait':
                        this._log(`Esperando ${cmd.params.ms}ms...`, 'info');
                        break;
                    default:
                        this._log(`Comando no reconocido: ${cmd.action}`, 'warn');
                        continue;
                }

                // Delay si está especificado
                if (cmd.delay && cmd.delay > 0) {
                    await new Promise(resolve => setTimeout(resolve, cmd.delay));
                }

            } catch (error) {
                this._log(`Error ejecutando comando ${i + 1}: ${error.message}`, 'error');
                return false;
            }
        }

        this._log('Secuencia de comandos completada', 'success');
        return true;
    }

    // ==================== UTILIDADES ====================

    /**
     * Desconectar del servidor
     */
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this._updateStatus(false, 'Desconectado');
        this._log('Desconectado del servidor', 'info');
    }

    /**
     * Verificar si está conectado
     */
    isConnectedToServer() {
        return this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    /**
     * Obtener información de la librería
     */
    getInfo() {
        return {
            version: '1.0.0',
            connected: this.isConnectedToServer(),
            config: this.config,
            reconnectAttempts: this.reconnectAttempts
        };
    }
}

// Exportar para uso en navegador y Node.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PyRockCommands;
} else if (typeof window !== 'undefined') {
    window.PyRockCommands = PyRockCommands;
}