# Dockerfile optimizado con wstunnel para HTTP sobre WebSocket
FROM node:18-alpine

# Instalar wstunnel globalmente
RUN npm install -g wstunnel

# Crear directorio de trabajo
WORKDIR /app

# Exponer puerto 8080
EXPOSE 8080

# Configurar wstunnel como servidor WebSocket simple
# Modo servidor básico que acepta conexiones WebSocket
CMD ["wstunnel", "--server", "0.0.0.0:8080"]
