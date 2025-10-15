# Dockerfile CORREGIDO para Sevalla
# Configuración específica para la plataforma Sevalla
FROM browserless/chrome:1-chrome-stable

# Variables de entorno para Sevalla
ENV CONCURRENT=1
ENV TIMEOUT=30000
ENV KEEP_ALIVE=true
ENV ENABLE_CORS=true
ENV HOST=0.0.0.0
ENV PORT=8080

# Configuraciones adicionales
ENV PREBOOT_CHROME=true
ENV DEMO_MODE=false
ENV MAX_PAYLOAD_SIZE=30000000

# Puerto que espera Sevalla
EXPOSE 8080

# Healthcheck para verificar que el servicio está listo
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:8080/ || exit 1
