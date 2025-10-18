FROM alpine:latest

# Instalar tinyproxy y ca-certificates
RUN apk add --no-cache tinyproxy ca-certificates

# Configuración de tinyproxy
RUN printf "Port 8080\n\
Listen 0.0.0.0\n\
Timeout 600\n\
MaxClients 50\n\
Allow 0.0.0.0/0\n\
DisableViaHeader Yes\n\
LogLevel Info\n\
ConnectPort 443\n\
ConnectPort 8443\n\
ConnectAllow 0.0.0.0/0\n" > /etc/tinyproxy/tinyproxy.conf

EXPOSE 8080

CMD ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
