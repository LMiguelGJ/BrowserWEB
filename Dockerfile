FROM serjs/go-socks5-proxy:latest

# (Opcional) establece variables de entorno por defecto
ENV PROXY_PORT=1080
ENV PROXY_USER=
ENV PROXY_PASSWORD=

EXPOSE 1080/tcp

CMD ["go-socks5-proxy"]
