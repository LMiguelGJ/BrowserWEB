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

# Comando en formato JSON (evita warning) con single-process
CMD ["sh", "-c", "chromium-browser --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --disable-features=ChromeBrowserCloudManagement --single-process --remote-debugging-address=0.0.0.0 --remote-debugging-port=${PORT}"]
