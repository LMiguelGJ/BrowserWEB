# Usar Alpine Linux como base
FROM alpine:3.15.4 as build

# Definir la versión de Squid
ENV SQUID_VER 5.5

# Instalar dependencias necesarias
RUN set -x && \
    apk add --no-cache \
    gcc \
    g++ \
    libc-dev \
    curl \
    gnupg \
    libressl-dev \
    perl-dev \
    autoconf \
    automake

# Descargar e instalar Squid
RUN curl -fsSL http://www.squid-cache.org/Versions/v${SQUID_VER%.*}/squid-${SQUID_VER}.tar.gz | tar xz -C /tmp && \
    cd /tmp/squid-${SQUID_VER} && \
    ./configure --prefix=/usr --with-openssl --enable-ssl-crtd && \
    make && \
    make install

# Copiar el archivo de configuración de Squid
COPY squid.conf /etc/squid/squid.conf

# Exponer el puerto del proxy
EXPOSE 443

# Comando para ejecutar Squid
CMD ["squid", "-N", "-f", "/etc/squid/squid.conf"]
