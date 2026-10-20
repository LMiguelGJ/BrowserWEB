# PyRock — imagen única sobre Camoufox (Firefox anti-detección, controlado con Playwright).
#
# Build:  docker build -t pyrock .
# Run:    docker run -p 3000:3000 pyrock
#
# Node 22: camoufox-js exige Node >= 22. Debian slim (glibc): el binario de Firefox
# que trae Camoufox no corre sobre musl/Alpine.
#
# El binario parcheado (~1.3 GB) se descarga en el build y queda horneado en la
# imagen, para que el contenedor arranque sin red.
#
# Las librerías de ffmpeg NO son opcionales: Firefox decodifica H.264 con el
# libavcodec DEL SISTEMA, y sin él un stream remoto (avc1) no se decodifica
# nunca — el visor queda listo pero no pinta un frame y el preview se ve blanco.
FROM node:22-bookworm-slim

# Dependencias de sistema para el Firefox de Camoufox, más las herramientas de
# compilación que necesita better-sqlite3 (dependencia nativa de camoufox-js).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        fonts-liberation \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libatspi2.0-0 \
        libcairo2 \
        libcups2 \
        libdbus-1-3 \
        libexpat1 \
        libfontconfig1 \
        libgbm1 \
        libglib2.0-0 \
        libgtk-3-0 \
        libnspr4 \
        libnss3 \
        libpango-1.0-0 \
        libpangocairo-1.0-0 \
        libx11-6 \
        libx11-xcb1 \
        libxcb1 \
        libxcomposite1 \
        libxcursor1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxi6 \
        libxrandr2 \
        libxrender1 \
        libxss1 \
        libxtst6 \
        xauth \
        xvfb \
        xdg-utils \
        libavcodec59 \
        libavformat59 \
        libavutil57 \
        libswresample4 \
        libswscale6 \
        libpostproc56 \
        python3 \
        make \
        g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Usuario no-root desde el principio: el binario del navegador se descarga en su
# HOME, así que en runtime sigue siendo accesible.
RUN groupadd --gid 1001 nodejs && useradd --uid 1001 --gid nodejs --create-home pyrock \
    && chown pyrock:nodejs /app
USER pyrock
ENV HOME=/home/pyrock

COPY --chown=pyrock:nodejs package.json package-lock.json ./
# El Chromium de Puppeteer no hace falta (ya es sólo dependencia de desarrollo).
# npm corre como el usuario pyrock: usa su caché en $HOME. Un --mount=type=cache
# sobre /home/pyrock/.npm crearía la caché como root y npm fallaría con 243.
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm ci --omit=dev --no-audit --no-fund

# Descarga del binario de Camoufox en el build (como el usuario de runtime).
RUN npx camoufox-js fetch

# Only runtime files enter the image; local tooling, tests and examples stay out.
COPY --chown=pyrock:nodejs server.js ./
COPY --chown=pyrock:nodejs src/ ./src/
COPY --chown=pyrock:nodejs public/ ./public/

ENV NODE_ENV=production \
    CAMOUFOX_HEADLESS=virtual

EXPOSE 3000

CMD ["node", "server.js"]
