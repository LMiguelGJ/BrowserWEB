FROM alpine:latest

RUN apk add --no-cache tinyproxy

# Crear configuración limpia para tinyproxy
RUN printf "Port 8080\n\
Listen 0.0.0.0\n\
Timeout 600\n\
MaxClients 20\n\
Allow 0.0.0.0/0\n\
DisableViaHeader Yes\n\
LogLevel Info\n" > /etc/tinyproxy/tinyproxy.conf

EXPOSE 8080

CMD ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
