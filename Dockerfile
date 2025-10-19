# Dockerfile simplificado para PyRock
FROM node:18-alpine

# Instalar Chrome y dependencias mínimas
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# Configurar Puppeteer para usar Chromium instalado
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Directorio de trabajo
WORKDIR /app

# Copiar archivos de configuración
COPY package.json ./

# Instalar dependencias (modo simple)
RUN npm install --production --silent

# Copiar código fuente
COPY . .

# Puerto
EXPOSE 3000

# Usuario no-root para seguridad
RUN addgroup -g 1001 -S nodejs && \
    adduser -S pyrock -u 1001 -G nodejs && \
    chown -R pyrock:nodejs /app
USER pyrock

# Comando de inicio
CMD ["node", "server.js"]
