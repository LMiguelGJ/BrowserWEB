FROM alpine:3.20

RUN apk add --no-cache tinyproxy bash curl

RUN mkdir -p /etc/tinyproxy

# Archivo de configuración correcto
RUN echo "User nobody" > /etc/tinyproxy/tinyproxy.conf && \
    echo "Group nobody" >> /etc/tinyproxy/tinyproxy.conf && \
    echo "Port 8888" >> /etc/tinyproxy/tinyproxy.conf && \
    echo "Timeout 600" >> /etc/tinyproxy/tinyproxy.conf && \
    echo "LogLevel Info" >> /etc/tinyproxy/tinyproxy.conf && \
    echo "LogFile /var/log/tinyproxy.log" >> /etc/tinyproxy/tinyproxy.conf && \
    echo "Allow 0.0.0.0/0" >> /etc/tinyproxy/tinyproxy.conf && \
    echo "ConnectPort 443" >> /etc/tinyproxy/tinyproxy.conf && \
    echo "ConnectPort 80" >> /etc/tinyproxy/tinyproxy.conf && \
    echo "MaxClients 100" >> /etc/tinyproxy/tinyproxy.conf && \
    echo "StartServers 5" >> /etc/tinyproxy/tinyproxy.conf && \
    echo "MinSpareServers 5" >> /etc/tinyproxy/tinyproxy.conf && \
    echo "MaxSpareServers 20" >> /etc/tinyproxy/tinyproxy.conf

RUN mkdir -p /var/log && touch /var/log/tinyproxy.log

EXPOSE 8888

CMD ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
