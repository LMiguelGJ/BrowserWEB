FROM dorowu/ubuntu-desktop-lxde-vnc:latest

# Expone el puerto 8080 (Sevalla suele mapear tráfico web aquí)
EXPOSE 8080

# Redirige el tráfico del puerto 8080 al 80 dentro del contenedor
RUN apt-get update && apt-get install -y socat && \
    socat TCP-LISTEN:8080,fork TCP:127.0.0.1:80 &

ENV DISPLAY_WIDTH=1280
ENV DISPLAY_HEIGHT=800

CMD ["/startup.sh"]
