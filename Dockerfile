# Dockerfile optimizado con wstunnel para HTTP sobre WebSocket
FROM node:18-alpine

# Instalar wstunnel globalmente
RUN npm install -g wstunnel

# Crear directorio de trabajo
WORKDIR /app

# Exponer puerto 8080
EXPOSE 8080

# Configurar wstunnel como servidor WebSocket que permite túneles HTTP
# --server: modo servidor
# --restrictTo: permitir conexiones a cualquier host (para hacer requests HTTP)
CMD ["wstunnel", "--server", "--restrictTo=0.0.0.0:0", "ws://0.0.0.0:8080"]
