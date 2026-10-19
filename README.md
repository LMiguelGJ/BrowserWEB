# 🚀 PyRock - Automatización con Puppeteer y Docker

**PyRock** es una aplicación de control remoto de navegador que utiliza **Puppeteer** para automatización web, **REST** para los controles y **WebSocket/CDP** para el preview en vivo. Permite controlar un navegador de forma remota a través de una interfaz web moderna, optimizada para ejecutarse en contenedores Docker.

## ✨ Características

- 🌐 **Control remoto de navegador** con Puppeteer
- 📡 **Preview en vivo** por WebSocket con fotogramas CDP de Chrome
- 🖱️ **Control de mouse y teclado** desde la interfaz web
- 📸 **Captura manual** por REST, sin polling automático de imágenes
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
│   ├── script.js               # Interfaz y renderizado del preview
│   ├── styles.css              # Estilos de la interfaz
│   ├── PyRockHTTP.js           # Controles REST y conexión del preview
│   ├── PyRockScriptParser.js   # Parser de scripts
│   └── config.js               # URL del servidor y consulta de estado
├── server.js                   # Servidor Express y WebSocket en el mismo puerto
├── screencast.js               # Ciclo de vida CDP y control de flujo del preview
├── test/                       # Pruebas unitarias y de integración local
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
   - Presiona teclas especiales (Enter, Tab, Escape)
   - Usa la cruz de flechas (↑ ← ↓ →) para mover el cursor o desplazarte

4. **Preview y captura manual**
   - Chrome emite fotogramas JPEG al visor cuando están disponibles; no se garantiza una tasa fija de FPS ni se transmite audio.
   - El visor conserva la imagen anterior al perder la conexión y muestra su estado de reconexión.
   - El botón de captura manual sigue solicitando una imagen nueva por REST.

5. **Registro y scripts (paneles laterales)**
   - Las pestañas 📋 y 📜 del borde derecho abren, deslizándose, el registro de actividad y el control de scripts.
   - El panel se superpone: no mueve la vista previa ni los controles, así que los clics siguen mapeados igual.
   - Se cierra con ✕, con Escape o volviendo a pulsar su pestaña. Abrir una pestaña cierra la otra.
   - Un script sigue ejecutándose con su panel cerrado.
   - Si llega un error mientras el registro está cerrado, aparece un punto rojo en 📋 hasta que lo abras.

### Transporte y límites

Todos los controles conservan su API HTTP:

| Ruta | Acción |
|------|--------|
| `POST /api/navigate` | Navegar a una URL |
| `POST /api/click` | Hacer clic en coordenadas |
| `POST /api/type` | Escribir texto |
| `POST /api/key` | Presionar una tecla |
| `POST /api/screenshot` | Crear una captura manual |
| `GET /api/screenshot` | Obtener la última captura manual guardada, no una imagen nueva |
| `GET /api/status` | Consultar el estado |
| `POST /api/init` | Reinicializar el navegador |

El preview usa `/ws/preview` en el mismo puerto que HTTP: `ws://localhost:3000/ws/preview` en local y `wss://<dominio>/ws/preview` con HTTPS. El cliente deriva esta URL de `serverUrl`. No se expone el endpoint CDP de Chrome.

Hay **un navegador y una página compartidos**, no sesiones independientes. Varios visores pueden observarlos; cerrar un visor no cierra el navegador. Cada visor confirma el renderizado y recibe el fotograma más reciente disponible, sin acumular una cola de imágenes. No hay capturas automáticas por REST como respaldo: si falla el streaming, la captura manual permanece disponible.

### Proxy y diagnóstico del preview

- El proxy debe permitir el upgrade a WebSocket y mantener la conexión en `/ws/preview`, conservando Host/Origin del dominio público. El visor acepta conexiones del mismo host; esto **no reemplaza autenticación**.
- En las herramientas de desarrollo del navegador, buscá la conexión WebSocket y sus mensajes. No deberían aparecer consultas periódicas a `/api/screenshot`.
- Si REST funciona pero no llegan fotogramas, revisá el upgrade WebSocket, el estado del navegador y los logs del servidor. Una página estática puede no emitir nuevos fotogramas y no implica un fallo.
- Verificar el preview en local no demuestra que el proxy de producción admita `wss`. Esa comprobación debe realizarse por separado antes de declarar corregido el despliegue.

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
npm test           # Pruebas unitarias e integración con Chromium local
npm run dev        # Ejecutar en desarrollo
npm run docker:build  # Construir imagen Docker
npm run docker:run    # Ejecutar contenedor
npm run docker:dev    # Ejecutar con volumen montado
```

Las pruebas de integración levantan un servidor temporal en loopback y navegadores aislados con páginas locales; no necesitan sitios externos ni datos reales. Requieren las dependencias instaladas y el Chromium de Puppeteer disponible. Una falta de Chromium es una prueba fallida, no una verificación omitida silenciosamente.

### Estructura de Archivos

- `server.js` - Servidor principal y controles REST
- `screencast.js` - Transmisión CDP y limpieza del preview
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