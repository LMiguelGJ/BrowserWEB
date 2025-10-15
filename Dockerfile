# Usa la imagen Firefox con interfaz web
FROM jlesage/firefox

# Ejecuta como usuario no root (corrige permisos en plataformas seguras)
ENV USER_ID=1000
ENV GROUP_ID=1000

# Desactiva necesidad de privilegios extra
ENV ENABLE_CJK_FONT=1
ENV DISPLAY=:0

EXPOSE 5800

# No requiere CMD, pero lo agregamos por compatibilidad
CMD ["/init"]
