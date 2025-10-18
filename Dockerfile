FROM alpine:latest

RUN apk add --no-cache tinyproxy curl busybox-extras

RUN echo "\
Port 8080\n\
Listen 0.0.0.0\n\
Timeout 600\n\
MaxClients 20\n\
Allow 0.0.0.0/0\n\
DisableViaHeader On\n\
LogLevel Notice\n\
" > /etc/tinyproxy/tinyproxy.conf

EXPOSE 8080 80

CMD sh -c "tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf"
