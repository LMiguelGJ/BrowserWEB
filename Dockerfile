# Dockerfile MINIMAL para Sevalla
# Imagen base confiable y pública
FROM browserless/chrome:1.60.1

# Variables esenciales
ENV CONCURRENT=1
ENV TIMEOUT=30000
ENV KEEP_ALIVE=true
ENV ENABLE_CORS=true
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000
