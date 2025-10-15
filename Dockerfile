FROM browserless/chromium:latest

# Configurar modo gratuito básico
ENV MAX_CONCURRENT_SESSIONS=1
ENV CONNECTION_TIMEOUT=30000
ENV ENABLE_DEBUGGER=false
ENV PREBOOT_CHROME=true

EXPOSE 3000

CMD ["node", "build/index.js"]
