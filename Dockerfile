# Dockerfile simplificado para Sevalla (puerto 8080)
FROM zenika/alpine-chrome:latest

# Variables básicas para suprimir errores D-Bus
ENV NO_AT_BRIDGE=1
ENV DBUS_SESSION_BUS_ADDRESS=""
ENV DISPLAY=""

# Puerto dinámico para Sevalla
ENV PORT=8080

# Usuario no-root
USER chrome
WORKDIR /app

# Exponer puerto 8080 para Sevalla
EXPOSE 8080

# Comando simplificado con puerto dinámico
CMD chromium-browser \
    --headless=new \
    --no-sandbox \
    --disable-gpu \
    --disable-dev-shm-usage \
    --disable-features=ChromeBrowserCloudManagement \
    --remote-debugging-address=0.0.0.0 \
    --remote-debugging-port=${PORT}
