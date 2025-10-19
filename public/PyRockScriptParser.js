/**
 * PyRockScriptParser.js - Parser básico para scripts de PyRock
 * Versión: 1.0.0
 * Descripción: Parser simple que traduce comandos de script a métodos de PyRockHTTP
 */

class PyRockScriptParser {
    constructor(pyRockHTTP, visualIndicatorFunctions = null) {
        this.pyRock = pyRockHTTP;
        this.commands = [];
        this.currentLine = 0;
        this.visualIndicators = visualIndicatorFunctions;
        
        // Para manejar bucles
        this.loopStack = []; // Pila de bucles activos
    }

    /**
     * Cargar y parsear archivo de script
     * @param {string} scriptContent - Contenido del archivo de script
     */
    loadScript(scriptContent) {
        const lines = scriptContent.split('\n');
        this.commands = [];
        this.loopStack = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Ignorar líneas vacías y comentarios
            if (!line || line.startsWith(';')) {
                continue;
            }
            
            try {
                const command = this.parseLine(line);
                if (command) {
                    this.commands.push({
                        ...command,
                        lineNumber: i + 1,
                        originalLine: line
                    });
                }
            } catch (error) {
                console.error(`Error en línea ${i + 1}: ${error.message}`);
                throw new Error(`Error en línea ${i + 1}: ${error.message}`);
            }
        }
        
        console.log(`Script cargado: ${this.commands.length} comandos parseados`);
        return this.commands;
    }

    /**
     * Parsear una línea individual
     * @param {string} line - Línea a parsear
     */
    parseLine(line) {
        // Regex para capturar comando y parámetros
        const commandRegex = /^(\w+)\s*\((.*)\)\s*$/;
        const match = line.match(commandRegex);
        
        if (!match) {
            throw new Error(`Sintaxis inválida: ${line}`);
        }
        
        const [, commandName, params] = match;
        
        switch (commandName.toLowerCase()) {
            case 'navigate':
                return this.parseNavigate(params);
            case 'clickat':
                return this.parseClickAt(params);
            case 'send':
                return this.parseSend(params);
            case 'key':
                return this.parseKey(params);
            case 'sleep':
                return this.parseSleep(params);
            case 'loop':
                return this.parseLoop(params);
            case 'endloop':
                return this.parseEndLoop(params);
            default:
                throw new Error(`Comando no reconocido: ${commandName}`);
        }
    }

    /**
     * Parsear Navigate("url")
     */
    parseNavigate(params) {
        const url = this.extractStringParam(params);
        return { type: 'navigate', url };
    }

    /**
     * Parsear ClickAt(x, y)
     */
    parseClickAt(params) {
        const [x, y] = this.extractNumericParams(params, 2);
        return { type: 'click', x, y };
    }

    /**
     * Parsear Send("texto") - versión básica sin teclas especiales
     */
    parseSend(params) {
        const text = this.extractStringParam(params);
        
        // Manejo básico de teclas especiales comunes
        if (text.includes('{ENTER}')) {
            const cleanText = text.replace('{ENTER}', '');
            return { 
                type: 'sequence', 
                commands: [
                    { type: 'type', text: cleanText },
                    { type: 'key', key: 'Enter' }
                ]
            };
        }
        
        if (text.includes('{TAB}')) {
            const cleanText = text.replace('{TAB}', '');
            return { 
                type: 'sequence', 
                commands: [
                    { type: 'type', text: cleanText },
                    { type: 'key', key: 'Tab' }
                ]
            };
        }
        
        if (text.includes('{ESCAPE}')) {
            const cleanText = text.replace('{ESCAPE}', '');
            return { 
                type: 'sequence', 
                commands: [
                    { type: 'type', text: cleanText },
                    { type: 'key', key: 'Escape' }
                ]
            };
        }
        
        // Manejo básico de teclas de control
        if (text === '^a') {
            return { type: 'key', key: 'Control+a' };
        }
        
        if (text === '^c') {
            return { type: 'key', key: 'Control+c' };
        }
        
        if (text === '^v') {
            return { type: 'key', key: 'Control+v' };
        }
        
        // Texto normal
        return { type: 'type', text };
    }

    /**
     * Parsear Key("tecla")
     */
    parseKey(params) {
        const key = this.extractStringParam(params);
        return { type: 'key', key: this.translateKey(key) };
    }

    /**
     * Parsear Sleep(ms)
     */
    parseSleep(params) {
        const ms = this.extractNumericParams(params, 1)[0];
        return { type: 'sleep', ms };
    }

    /**
     * Extraer parámetro string de comillas, backticks o texto plano
     */
    extractStringParam(params) {
        // Limpiar espacios en blanco al inicio y final
        params = params.trim();
        
        // Comillas dobles: "texto"
        let match = params.match(/^"(.*)"$/s);
        if (match) {
            return match[1];
        }
        
        // Comillas simples: 'texto'
        match = params.match(/^'(.*)'$/s);
        if (match) {
            return match[1];
        }
        
        // Backticks: `texto` (para comandos multilínea)
        match = params.match(/^`(.*)`$/s);
        if (match) {
            return match[1];
        }
        
        // Texto sin comillas (para compatibilidad con comandos simples)
        // Solo si no contiene caracteres especiales que indiquen sintaxis compleja
        if (params && 
            !params.includes('|') && 
            !params.includes(';') && 
            !params.includes('`') && 
            !params.includes('"') && 
            !params.includes("'") &&
            !params.includes('(') && 
            !params.includes(')')) {
            return params;
        }
        
        throw new Error(`Parámetro string esperado con comillas: ${params}`);
    }

    /**
     * Extraer parámetros numéricos
     */
    extractNumericParams(params, expectedCount) {
        const numbers = params.split(',').map(p => {
            const num = parseInt(p.trim());
            if (isNaN(num)) {
                throw new Error(`Número esperado: ${p}`);
            }
            return num;
        });
        
        if (numbers.length !== expectedCount) {
            throw new Error(`Se esperaban ${expectedCount} parámetros, se encontraron ${numbers.length}`);
        }
        
        return numbers;
    }

    /**
     * Traducir nombres de teclas
     */
    translateKey(keyName) {
        const keyMap = {
            'ENTER': 'Enter',
            'TAB': 'Tab',
            'ESCAPE': 'Escape',
            'ESC': 'Escape',
            'PAGEDOWN': 'PageDown',
            'PAGEUP': 'PageUp'
        };
        
        return keyMap[keyName.toUpperCase()] || keyName;
    }

    /**
     * Ejecutar script completo
     */
    async executeScript() {
        if (!this.pyRock.isConnectedToServer()) {
            throw new Error('No hay conexión con el servidor PyRock');
        }
        
        console.log(`Ejecutando script con ${this.commands.length} comandos...`);
        
        for (let i = 0; i < this.commands.length; i++) {
            const command = this.commands[i];
            this.currentLine = command.lineNumber;
            
            console.log(`Línea ${command.lineNumber}: ${command.originalLine}`);
            
            try {
                await this.executeCommand(command);
            } catch (error) {
                const errorMsg = `Error ejecutando línea ${command.lineNumber}: ${error.message}`;
                console.error(errorMsg);
                throw new Error(errorMsg);
            }
        }
        
        console.log('Script ejecutado exitosamente');
    }

    /**
     * Ejecutar comando individual
     */
    async executeCommand(command) {
        switch (command.type) {
            case 'navigate':
                return this.pyRock.navigate(command.url);
                
            case 'click':
                // Mostrar indicador visual si está disponible
                if (this.visualIndicators && this.visualIndicators.showClickIndicator && this.visualIndicators.getIndicatorPosition) {
                    const preview = document.getElementById('preview');
                    if (preview && preview.naturalWidth > 0) {
                        const position = this.visualIndicators.getIndicatorPosition(preview, command.x, command.y);
                        this.visualIndicators.showClickIndicator(position.x, position.y);
                    }
                }
                return this.pyRock.click(command.x, command.y);
                
            case 'type':
                return this.pyRock.type(command.text);
                
            case 'key':
                return this.pyRock.pressKey(command.key);
                
            case 'sleep':
                console.log(`Esperando ${command.ms}ms...`);
                return new Promise(resolve => setTimeout(resolve, command.ms));
                
            case 'sequence':
                // Para comandos Send con teclas especiales
                for (const subCommand of command.commands) {
                    await this.executeCommand(subCommand);
                    // Pequeña pausa entre comandos de secuencia
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                break;
                
            case 'loop':
                // Marcar inicio de bucle
                return this.startLoop(command.iterations);
                
            case 'endloop':
                // Procesar fin de bucle
                return this.endLoop();
                
            default:
                throw new Error(`Tipo de comando no implementado: ${command.type}`);
        }
    }



    /**
     * Parsear comando Loop
     * @param {string} params - Parámetros del comando (número de iteraciones)
     */
    parseLoop(params) {
        const iterations = parseInt(params.trim()) || -1; // -1 = infinito
        
        return {
            type: 'loop',
            iterations: iterations
        };
    }

    /**
     * Parsear comando EndLoop
     * @param {string} params - Parámetros del comando
     */
    parseEndLoop(params) {
        return {
            type: 'endloop'
        };
    }

    /**
     * Obtener información del parser
     */
    getInfo() {
        return {
            commandsLoaded: this.commands.length,
            currentLine: this.currentLine,
            supportedCommands: ['Navigate', 'ClickAt', 'Send', 'Key', 'Sleep', 'Loop', 'EndLoop']
        };
    }



    /**
     * Iniciar un bucle
     * @param {number} iterations - Número de iteraciones (-1 para infinito)
     */
    startLoop(iterations) {
        this.loopStack.push({
            startLine: this.currentLine,
            iterations: iterations,
            currentIteration: 0
        });
        console.log(`Iniciando bucle con ${iterations === -1 ? 'infinitas' : iterations} iteraciones`);
    }

    /**
     * Finalizar un bucle
     */
    endLoop() {
        if (this.loopStack.length === 0) {
            throw new Error('EndLoop sin Loop correspondiente');
        }
        
        const loop = this.loopStack[this.loopStack.length - 1];
        loop.currentIteration++;
        
        // Si es bucle infinito o no hemos completado las iteraciones
        if (loop.iterations === -1 || loop.currentIteration < loop.iterations) {
            this.currentLine = loop.startLine;
            console.log(`Bucle: iteración ${loop.currentIteration}${loop.iterations === -1 ? ' (infinito)' : '/' + loop.iterations}`);
        } else {
            // Bucle completado
            this.loopStack.pop();
            console.log(`Bucle completado después de ${loop.currentIteration} iteraciones`);
        }
    }

    /**
     * Validar script básico
     */
    validateScript() {
        const errors = [];
        
        for (const command of this.commands) {
            switch (command.type) {
                case 'navigate':
                    if (!command.url || command.url.length === 0) {
                        errors.push(`Línea ${command.lineNumber}: URL vacía`);
                    }
                    break;
                case 'click':
                    if (command.x < 0 || command.y < 0) {
                        errors.push(`Línea ${command.lineNumber}: Coordenadas inválidas`);
                    }
                    break;
                case 'sleep':
                    if (command.ms < 0) {
                        errors.push(`Línea ${command.lineNumber}: Tiempo de espera inválido`);
                    }
                    break;
            }
        }
        
        return errors;
    }
}

// Exportar para uso en navegador y Node.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PyRockScriptParser;
} else if (typeof window !== 'undefined') {
    window.PyRockScriptParser = PyRockScriptParser;
}