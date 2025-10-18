FROM ubuntu:24.04

# Instalar Squid y certificados
RUN apt-get update && \
    apt-get install -y squid ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Configuración mínima de Squid para HTTP y HTTPS público
RUN printf "\
http_port 8080\n\
acl all src 0.0.0.0/0\n\
acl SSL_ports port 443\n\
acl Safe_ports port 80 443 1025-65535\n\
acl CONNECT method CONNECT\n\
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
" > /etc/squid/squid.conf

# Exponer puerto del proxy
EXPOSE 8080

# Ejecutar Squid en primer plano
CMD ["squid", "-N", "-f", "/etc/squid/squid.conf"]
