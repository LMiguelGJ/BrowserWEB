# Dockerfile mínimo para PhantomJS en Sevalla (puerto 8080)
FROM wernight/phantomjs:latest

# Puerto dinámico para Sevalla
ENV PORT=8080

# Directorio de trabajo (opcional)
WORKDIR /app

# Exponer puerto 8080
EXPOSE 8080

# Iniciar PhantomJS WebDriver escuchando en 0.0.0.0:PORT
# Nota: usamos shell para expandir ${PORT}
CMD ["sh", "-c", "phantomjs --webdriver=0.0.0.0:${PORT} --webdriver-loglevel=INFO"]
