# Dockerfile FINAL para Sevalla
# Tag VERIFICADO y ESTABLE
FROM browserless/chrome:1-chrome-stable

# Variables de entorno optimizadas
ENV CONCURRENT=1
ENV TIMEOUT=30000
ENV KEEP_ALIVE=true
ENV ENABLE_CORS=true
ENV HOST=0.0.0.0
ENV PORT=3000

# Configuraciones adicionales
ENV PREBOOT_CHROME=true
ENV DEMO_MODE=false

EXPOSE 3000
