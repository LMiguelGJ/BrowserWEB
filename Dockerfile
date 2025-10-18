FROM alpine:latest

# Instalar Squid y certificados
RUN apk add --no-cache squid ca-certificates

# Crear configuración de Squid mínima para HTTP y HTTPS
RUN printf "\
http_port 8080\n\
http_access allow all\n\
forwarded_for off\n\
via off\n\
cache deny all\n\
request_header_access Allow allow all\n\
request_header_access Authorization allow all\n\
request_header_access WWW-Authenticate allow all\n\
request_header_access Proxy-Authorization allow all\n\
request_header_access Proxy-Authenticate allow all\n\
request_header_access Cache-Control allow all\n\
request_header_access Content-Encoding allow all\n\
request_header_access Content-Length allow all\n\
request_header_access Content-Type allow all\n\
request_header_access Date allow all\n\
request_header_access Expires allow all\n\
request_header_access Host allow all\n\
request_header_access If-Modified-Since allow all\n\
request_header_access Last-Modified allow all\n\
request_header_access Location allow all\n\
request_header_access Pragma allow all\n\
request_header_access Accept allow all\n\
request_header_access Accept-Charset allow all\n\
request_header_access Accept-Encoding allow all\n\
request_header_access Accept-Language allow all\n\
request_header_access Content-Language allow all\n\
request_header_access Mime-Version allow all\n\
request_header_access Retry-After allow all\n\
request_header_access Title allow all\n\
request_header_access Connection allow all\n\
request_header_access Proxy-Connection allow all\n\
request_header_access User-Agent allow all\n\
request_header_access Cookie allow all\n\
request_header_access All deny all\n\
# HTTPS CONNECT\n\
acl SSL_ports port 443 8443\n\
acl Safe_ports port 80 443 1025-65535\n\
acl CONNECT method CONNECT\n\
http_access allow all\n\
" > /etc/squid/squid.conf

EXPOSE 8080

CMD ["squid", "-N", "-f", "/etc/squid/squid.conf"]
