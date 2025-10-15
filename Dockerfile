# Usa browserless como base
FROM browserless/chrome:latest

# Por defecto expone el puerto 3000
EXPOSE 3000

# Entrypoint estándar
CMD ["--port=3000"]
