# Dockerfile mínimo para zenika/alpine-chrome optimizado para Sevalla
# Recursos: 0.3 CPU / 0.3 RAM (aproximadamente 300MB)
FROM zenika/alpine-chrome:latest

# Variables de entorno para optimización de memoria
ENV CHROME_BIN=/usr/bin/chromium-browser
ENV CHROME_PATH=/usr/bin/chromium-browser
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Optimización de memoria para Node.js (si se usa)
ENV NODE_OPTIONS="--max-old-space-size=256"

# Flags de Chrome optimizados para recursos limitados
ENV CHROME_FLAGS="\
--headless=new \
--no-sandbox \
--disable-gpu \
--disable-dev-shm-usage \
--disable-extensions \
--disable-plugins \
--disable-background-networking \
--disable-background-timer-throttling \
--disable-renderer-backgrounding \
--disable-backgrounding-occluded-windows \
--disable-features=TranslateUI \
--disable-ipc-flooding-protection \
--memory-pressure-off \
--max_old_space_size=256 \
--aggressive-cache-discard \
--disable-web-security \
--disable-features=VizDisplayCompositor \
--disable-background-networking \
--disable-sync \
--disable-default-apps \
--disable-extensions \
--disable-translate \
--hide-scrollbars \
--mute-audio \
--no-first-run \
--safebrowsing-disable-auto-update \
--disable-client-side-phishing-detection \
--disable-component-update \
--disable-domain-reliability \
--window-size=1280,720"

# Configuración de usuario no-root para seguridad
USER chrome

# Directorio de trabajo
WORKDIR /app

# Puerto por defecto para debugging remoto (opcional)
EXPOSE 9222

# Comando por defecto con flags optimizados
CMD ["chromium-browser", \
     "--headless=new", \
     "--no-sandbox", \
     "--disable-gpu", \
     "--disable-dev-shm-usage", \
     "--disable-extensions", \
     "--disable-plugins", \
     "--disable-background-networking", \
     "--disable-background-timer-throttling", \
     "--disable-renderer-backgrounding", \
     "--disable-backgrounding-occluded-windows", \
     "--memory-pressure-off", \
     "--max_old_space_size=256", \
     "--aggressive-cache-discard", \
     "--window-size=1280,720", \
     "--remote-debugging-address=0.0.0.0", \
     "--remote-debugging-port=9222"]
