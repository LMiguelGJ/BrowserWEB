/**
 * Configuración de PyRock
 * Cambia estas variables según tu entorno
 */
window.PyRockConfig = {
    // URL del servidor - cambia esto por la URL de tu servidor en la nube
    // Ejemplos:
    // - Local: 'http://localhost:3000'
    // - Nube: 'https://tu-servidor.com' o 'http://tu-ip:3000'
    serverUrl: 'https://browserweb-gn7u4.sevalla.app',
    
    // Intervalo para consultar estado del servidor
    statusPollIntervalMs: 30000, // 30 segundos
    
    // Configuración de timeouts
    requestTimeout: 10000, // 10 segundos
    
    // Configuración de reintentos
    maxRetries: 3,
    retryDelay: 1000, // 1 segundo
    
    // Debug mode
    debug: false
};

// Función para detectar automáticamente si estamos en desarrollo o producción
function autoDetectServerUrl() {
    const hostname = window.location.hostname;
    const port = window.location.port;
    const protocol = window.location.protocol;
    
    // Si estamos en localhost, usar localhost
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return `${protocol}//${hostname}:3000`;
    }
    
    // Si estamos en un dominio, usar el mismo dominio
    if (port) {
        return `${protocol}//${hostname}:${port}`;
    } else {
        return `${protocol}//${hostname}`;
    }
}

// Activar detección automática del serverUrl
window.PyRockConfig.serverUrl = autoDetectServerUrl();

console.log('🔧 PyRock Config cargado:', window.PyRockConfig);