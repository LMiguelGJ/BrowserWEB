FROM alpine:3.20
RUN apk add --no-cache curl && \
    curl -L https://github.com/vi/websocat/releases/latest/download/websocat.x86_64-unknown-linux-musl -o /usr/local/bin/websocat && \
    chmod +x /usr/local/bin/websocat
EXPOSE 8080
CMD ["websocat", "-s", "0.0.0.0:8080"]
