# Dockerfile OPTIMIZADO para Browserless Completo
# Usa la imagen completa con TODAS las funcionalidades
FROM ghcr.io/browserless/browserless:latest

# Variables de entorno para máximo rendimiento
ENV CONCURRENT=2
ENV TIMEOUT=60000
ENV KEEP_ALIVE=true
ENV ENABLE_CORS=true
ENV ENABLE_API_GET=true
ENV HOST=0.0.0.0
ENV PORT=3000

# Funcionalidades avanzadas habilitadas
ENV FUNCTION_BUILT_INS=["url","pdf","screenshot","content","stats"]
ENV PREBOOT_CHROME=true
ENV ENABLE_DEBUGGER=false
ENV ENABLE_HEAP_DUMP=false
ENV ENABLE_XVFB=true

# Configuraciones de seguridad y rendimiento
ENV DEMO_MODE=false
ENV MAX_PAYLOAD_SIZE=30MB
ENV CHROME_REFRESH_TIME=3600000

# Puerto expuesto
EXPOSE 3000

# Healthcheck para verificar que el servicio está funcionando
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/config || exit 1
