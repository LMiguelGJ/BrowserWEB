FROM dorowu/ubuntu-desktop-lxde-vnc:latest

# Exponer el puerto web VNC
EXPOSE 80

# Opcional: Cambia la resolución si lo necesitas
ENV DISPLAY_WIDTH=1280
ENV DISPLAY_HEIGHT=800

# Lanzar el entorno gráfico
CMD ["/startup.sh"]
