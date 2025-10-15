# Dockerfile corregido para tu setup actual
FROM ghcr.io/browserless/chromium:latest

# Variables de entorno actualizadas (las tuyas estaban desactualizadas)
ENV CONCURRENT=1                   
ENV TIMEOUT=30000                  
ENV KEEP_ALIVE=true                
ENV ENABLE_CORS=true
ENV ENABLE_API_GET=true
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000
