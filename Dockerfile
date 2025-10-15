# Dockerfile MINIMALISTA para Sevalla
# Solo configuraciones esenciales
FROM browserless/chrome:1-chrome-stable

# Solo las variables ESENCIALES
ENV PORT=8080
ENV HOST=0.0.0.0

# Puerto para Sevalla
EXPOSE 8080
