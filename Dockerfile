# Dockerfile optimizado con wstunnel para HTTP sobre WebSocket
FROM node:18-alpine

RUN npm install -g wstunnel

WORKDIR /app

EXPOSE 8080

CMD ["wstunnel", "-s", "0.0.0.0:8080"]
