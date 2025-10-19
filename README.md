# 🚀 PyRock - Automatización con Puppeteer y Docker

**PyRock** es una aplicación de control remoto de navegador que utiliza **Puppeteer** para automatización web y **WebSocket** para comunicación en tiempo real. Permite controlar un navegador de forma remota a través de una interfaz web moderna, optimizada para ejecutarse en contenedores Docker.

## ✨ Características

- 🌐 **Control remoto de navegador** con Puppeteer
- 📡 **Comunicación en tiempo real** via WebSocket
- 🖱️ **Control de mouse y teclado** desde la interfaz web
- 📸 **Capturas de pantalla en vivo** cada 1 segundo
- 🎨 **Interfaz moderna y responsiva**
- 🐳 **Optimizado para Docker** con Chrome headless
- 🔄 **Recuperación automática** del navegador
- 📋 **Monitoreo de salud** del navegador
- 🛡️ **Configuración de seguridad** para contenedores

## 🛠️ Tecnologías Utilizadas

- **Node.js 18** - Runtime de JavaScript
- **Express.js** - Framework web
- **Puppeteer** - Automatización de navegadores Chrome
- **WebSocket (ws)** - Comunicación bidireccional
- **HTML5/CSS3/JavaScript** - Frontend moderno
- **Docker** - Containerización con Chrome headless

## 📂 Estructura del Proyecto

```
PyRock/
├── public/
│   ├── index.html              # Frontend con interfaz de control
│   ├── script.js               # Lógica del cliente WebSocket
│   ├── styles.css              # Estilos de la interfaz
│   ├── PyRockCommands.js       # Comandos de automatización
│   ├── PyRockScriptParser.js   # Parser de scripts
│   └── screenshot.png          # Captura de pantalla actual
├── server.js                   # Servidor principal con Express y WebSocket
├── package.json                # Configuración de dependencias
├── Dockerfile                  # Configuración optimizada para Docker
├── .dockerignore              # Archivos a ignorar en Docker
└── README.md                  # Documentación del proyecto
```

## 🚀 Instalación y Uso

### Opción 1: Ejecución con Docker (Recomendado)

1. **Construir la imagen Docker**
   ```bash
   npm run docker:build
   ```

2. **Ejecutar el contenedor**
   ```bash
   npm run docker:run
   ```

3. **Abrir en el navegador**
   ```
   http://localhost:3000
   ```

### Opción 2: Ejecución Local

#### Prerrequisitos
- **Node.js** 18+ instalado
- **Chrome/Chromium** instalado en el sistema

#### Pasos de Instalación

1. **Instalar dependencias**
   ```bash
   npm install
   ```

2. **Ejecutar en modo desarrollo**
   ```bash
   npm run dev
   ```

3. **Ejecutar en modo producción**
   ```bash
   npm start
   ```

4. **Abrir en el navegador**
   ```
   http://localhost:3000
   ```

## 🎮 Uso de la Aplicación

### Controles Disponibles

1. **Navegación**
   - Ingresa una URL en el campo de texto
   - Haz clic en "Navegar" para ir a la página

2. **Control de Mouse**
   - Haz clic en cualquier parte de la captura de pantalla
   - Los clics se envían al navegador controlado

3. **Control de Teclado**
   - Escribe texto en el campo correspondiente
   - Presiona teclas especiales (Enter, Tab, etc.)

4. **Capturas de Pantalla**
   - Se actualizan automáticamente cada segundo
   - Puedes forzar una captura manual

### Comandos WebSocket

La aplicación soporta los siguientes comandos via WebSocket:

- `navigate` - Navegar a una URL
- `click` - Hacer clic en coordenadas específicas
- `type` - Escribir texto
- `key` - Presionar teclas especiales
- `screenshot` - Capturar pantalla
- `status` - Verificar estado del navegador
- `init` - Reinicializar navegador

## 🐳 Configuración Docker

### Variables de Entorno

- `NODE_ENV` - Entorno de ejecución (production/development)
- `PORT` - Puerto del servidor (default: 3000)

### Características Docker

- **Chrome headless** preinstalado
- **Usuario no-root** para seguridad
- **Optimizaciones** para contenedores
- **Recuperación automática** del navegador
- **Monitoreo de salud** integrado

## 🔧 Desarrollo

### Scripts Disponibles

```bash
npm start          # Ejecutar en producción
npm run dev        # Ejecutar en desarrollo
npm run docker:build  # Construir imagen Docker
npm run docker:run    # Ejecutar contenedor
npm run docker:dev    # Ejecutar con volumen montado
```

### Estructura de Archivos

- `server.js` - Servidor principal con toda la lógica
- `public/` - Archivos estáticos del frontend
- `Dockerfile` - Configuración optimizada para Docker
- `.dockerignore` - Exclusiones para Docker build

## 🛡️ Seguridad

- Ejecución con usuario no-root en Docker
- Configuración segura de Chrome/Puppeteer
- Validación de URLs y parámetros
- Manejo de errores robusto

## 📝 Logs y Monitoreo

La aplicación incluye:
- Logs detallados con emojis para fácil identificación
- Monitoreo automático de salud del navegador
- Recuperación automática en caso de fallos
- Métricas de estado via endpoint `/health`

## 🤝 Contribución

1. Fork el proyecto
2. Crea una rama para tu feature (`git checkout -b feature/AmazingFeature`)
3. Commit tus cambios (`git commit -m 'Add some AmazingFeature'`)
4. Push a la rama (`git push origin feature/AmazingFeature`)
5. Abre un Pull Request

## 📄 Licencia

Este proyecto está bajo la Licencia MIT - ver el archivo [LICENSE](LICENSE) para detalles.

## 🆘 Soporte

Si encuentras algún problema o tienes preguntas:

1. Revisa los logs del contenedor: `docker logs <container_id>`
2. Verifica el estado de salud: `http://localhost:3000/health`
3. Reinicia el contenedor si es necesario

---

**Desarrollado con ❤️ por LMiguelGJ**