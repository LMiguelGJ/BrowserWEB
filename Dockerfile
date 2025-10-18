FROM alpine:latest

RUN apk add --no-cache tinyproxy curl busybox-extras

# Configurar Tinyproxy
RUN echo "\
Port 8080\n\
Listen 0.0.0.0\n\
Timeout 600\n\
MaxClients 20\n\
Allow 0.0.0.0/0\n\
DisableViaHeader On\n\
LogLevel Notice\n\
" > /etc/tinyproxy/tinyproxy.conf

# Crear una pequeña página HTML de prueba
RUN echo "<h1>Tinyproxy activo 🚀</h1>" > /var/www/index.html

# Exponer puertos
EXPOSE 8080 80

# Ejecutar ambos procesos: tinyproxy y servidor web
CMD sh -c "tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf & busybox httpd -f -p 80 -h /var/www"