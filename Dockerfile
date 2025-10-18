# Imagen base de SOCKS5
FROM serjs/go-socks5-proxy:latest

# Configuración sin autenticación y puerto 8080
ENV REQUIRE_AUTH=false
ENV PROXY_PORT=8080

# Exponer el puerto TCP
EXPOSE 8080/tcp

# Comando por defecto
CMD ["go-socks5-proxy"]
