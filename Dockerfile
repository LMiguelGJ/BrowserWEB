# Dockerfile ALTERNATIVO para Sevalla
# Usa puerto estándar de Browserless con configuración robusta
FROM browserless/chrome:latest

# Variables de entorno robustas
ENV CONCURRENT=2
ENV TIMEOUT=60000
ENV KEEP_ALIVE=true
ENV ENABLE_CORS=true
ENV HOST=0.0.0.0
ENV PORT=3000

# Configuraciones para estabilidad
ENV PREBOOT_CHROME=true
ENV DEMO_MODE=false
ENV MAX_PAYLOAD_SIZE=50000000
ENV ENABLE_HEAP_DUMP=false
ENV ENABLE_DEBUG_VIEWER=false

# Configuraciones de Chrome
ENV CHROME_ARGS="--no-sandbox,--disable-setuid-sandbox,--disable-dev-shm-usage,--disable-gpu"

EXPOSE 3000

# Comando de inicio explícito
CMD ["node", "build/index.js"]
