# Dockerfile para Sevalla - Imagen pública garantizada
# Usa la imagen oficial de Docker Hub
FROM browserless/chrome:1.61.0

# Variables de entorno básicas que funcionan
ENV CONCURRENT=2
ENV TIMEOUT=60000
ENV KEEP_ALIVE=true
ENV ENABLE_CORS=true
ENV HOST=0.0.0.0
ENV PORT=3000

# Configuraciones adicionales
ENV PREBOOT_CHROME=true
ENV DEMO_MODE=false
ENV MAX_PAYLOAD_SIZE=30MB

# Puerto expuesto
EXPOSE 3000

# Healthcheck simple
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/ || exit 1
