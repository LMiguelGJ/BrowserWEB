FROM alpine:latest

# Instalar tinyproxy y certificados
RUN apk add --no-cache tinyproxy ca-certificates

# Crear configuración limpia para tinyproxy
RUN printf "Port 8080\n\
Listen 0.0.0.0\n\
Timeout 600\n\
MaxClients 20\n\
Allow 0.0.0.0/0\n\
DisableViaHeader Yes\n\
LogLevel Info\n\
# Puertos permitidos para CONNECT (HTTPS)\n\
ConnectPort 443\n\
ConnectPort 8443\n" > /etc/tinyproxy/tinyproxy.conf

EXPOSE 8080

CMD ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
