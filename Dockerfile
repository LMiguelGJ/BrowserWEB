
FROM alpine:3.20

# Instala curl y certificados para HTTPS confiable
RUN apk add --no-cache curl ca-certificates \
    && update-ca-certificates

# Descarga websocat estático compatible con Alpine (musl)
RUN curl -fL -o /usr/local/bin/websocat "https://github.com/vi/websocat/releases/latest/download/websocat.x86_64-unknown-linux-musl" \
    && chmod +x /usr/local/bin/websocat

ENV PORT=8080
EXPOSE 8080

# Servidor WS: por cada conexión ejecuta curl contra proxycheck y devuelve el JSON
CMD ["/usr/local/bin/websocat", "-q", "-t", "ws-l:0.0.0.0:8080", "sh-c:curl -sS https://proxycheck.io/v3"]
