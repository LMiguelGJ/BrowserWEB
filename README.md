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
├── sessions.js                 # Secciones y contextos aislados del navegador
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

5. **Secciones de navegador**
   - Usa la barra izquierda para agregar secciones, cambiar entre ellas y cerrar una sección con confirmación. Siempre debe quedar al menos una sección abierta.
   - Cada sección tiene su propia página y cookies; los controles, el preview y el reinicio actúan sobre la sección seleccionada. Un script continúa en la sección donde empezó aunque cambies la selección.
   - Los nombres opcionales tienen entre 1 y 24 caracteres; el nombre inicial es `Sección N`. La selección activa se recuerda en este navegador web, pero las secciones viven solo en memoria del servidor y se pierden al reiniciarlo.
   - Todas las secciones comparten un único proceso Chromium, así que comparten su CPU, memoria y dirección IP de red. El máximo predeterminado es 5 secciones; se configura con `MAX_SESSIONS` (valores aceptados: 1–10).

6. **Registro y scripts (paneles laterales)**
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
| `GET /api/sessions` | Listar secciones e indicar `default` y `max` |
| `POST /api/sessions` | Crear una sección; acepta `{ "name": "Cuenta" }` opcional |
| `DELETE /api/sessions/:id` | Cerrar una sección (no se puede cerrar la última) |
| `POST /api/init` | Reiniciar la sección activa o, si se omite `session`, todas las secciones |

Las rutas de control existentes aceptan `session` en el cuerpo JSON de las solicitudes POST o en la query de las GET. Si se omite, el servidor usa la sección predeterminada. Por ejemplo, `POST /api/navigate` con `{ "url": "https://example.com", "session": "s2" }` dirige la navegación a `s2`. El preview usa `/ws/preview?session=s2` para mostrar una sección concreta; sin `session`, muestra la predeterminada. El WebSocket usa el mismo puerto que HTTP: `ws://localhost:3000/ws/preview` en local y `wss://<dominio>/ws/preview` con HTTPS. El cliente deriva esta URL de `serverUrl`. No se expone el endpoint CDP de Chrome.

Hay **un proceso Chromium compartido** y varias secciones independientes, cada una con su propio `BrowserContext` y página. Las cookies, el almacenamiento web y la caché están aislados entre secciones; CPU, memoria y dirección IP de red son compartidas. Las secciones se mantienen en memoria del servidor, no persisten tras reiniciarlo, y su cantidad máxima se controla con `MAX_SESSIONS` (predeterminado: 5; rango admitido: 1–10). Varios visores pueden observar una sección; cerrar un visor no cierra la sección ni el navegador. Cada visor confirma el renderizado y recibe el fotograma más reciente disponible, sin acumular una cola de imágenes. No hay capturas automáticas por REST como respaldo: si falla el streaming, la captura manual permanece disponible.

### Proxy y diagnóstico del preview

- El proxy debe permitir el upgrade a WebSocket y mantener la conexión en `/ws/preview`, conservando Host/Origin del dominio público. El visor acepta conexiones del mismo host; esto **no reemplaza autenticación**.
- En las herramientas de desarrollo del navegador, buscá la conexión WebSocket y sus mensajes. No deberían aparecer consultas periódicas a `/api/screenshot`.
- Si REST funciona pero no llegan fotogramas, revisá el upgrade WebSocket, el estado del navegador y los logs del servidor. Una página estática puede no emitir nuevos fotogramas y no implica un fallo.
- Verificar el preview en local no demuestra que el proxy de producción admita `wss`. Esa comprobación debe realizarse por separado antes de declarar corregido el despliegue.

## 🐳 Configuración Docker

### Variables de Entorno

- `NODE_ENV` - Entorno de ejecución (production/development)
- `PORT` - Puerto del servidor (default: 3000)
- `MAX_SESSIONS` - Máximo de secciones de navegador (default: 5; valores válidos: 1–10; otros valores usan el default)
- `CAMOUFOX_HEADLESS` - Modo del navegador: `true` (default), `false` o `virtual` (Xvfb, el que usa la imagen Docker)
- `CAMOUFOX_OS` - Sistema operativo simulado en la huella (default: el del host)
- `CAMOUFOX_LOCALE` - Locale de la huella (default: `es-ES`)
- `PYROCK_PROXY` - Proxy para el navegador, por ejemplo `http://usuario:clave@host:puerto` o `socks5://host:puerto`. Hace que la IP de salida parezca la de una persona en vez de la de un centro de datos, que es lo que más pesa en la detección de bots.
- `PYROCK_GEOIP` - Con `1`, la geolocalización de la huella (latitud, longitud, zona horaria) se calcula a partir de la IP del proxy, para que no se contradiga. `camoufox-js` avisa cuando se usa un proxy sin esto.

### Motor: Camoufox

[Camoufox](https://github.com/daijro/camoufox) es un Firefox anti-detección que se controla con Playwright, y es el **único motor** de PyRock. Cada sección sigue siendo un contexto aislado (cookies y storage propios), pero el navegador enmascara su huella a nivel de código nativo, así que PyRock no inyecta parches de Chrome ni cabeceras al estilo Chrome: se contradirían.

- El preview usa `page.screencast` (hasta 25 fps en Firefox) y, si el build no lo expone, capturas por sondeo.
- El frame se pide al tamaño CSS real de la página: el cliente mapea el clic sobre la imagen a coordenadas de página usando el tamaño en píxeles de la imagen, así que ambos tienen que coincidir exactamente.
- **Estado:** el camino migrado (adaptador, puente de frames, aislamiento por sección, recuperación ante caída del navegador) está probado con un navegador real en los tests de integración. **El binario de Camoufox no se probó localmente**: la primera ejecución real es en el servidor. El comando `npx camoufox-js fetch` del Dockerfile tampoco está verificado.
- Un motor nuevo no arregla la reputación de la IP: Cloudflare también puntúa la IP del servidor. Para eso está `PYROCK_PROXY` (proxy residencial).

### Entrada humanizada

`/api/click` camina el cursor por una trayectoria grabada de una persona real (cursory-js, 60 Hz, máximo 1,5 s) antes de hacer clic, y `/api/type` escribe con retardo variable por tecla. Envía `humanize: false` en el cuerpo para el comportamiento instantáneo.

El humanizador de Camoufox es de arranque y no admite desactivarse por petición, así que PyRock lo desactiva al lanzar el navegador y usa el suyo, que sí respeta `humanize: false`.

### Características Docker

- **Camoufox headless** preinstalado (binario descargado en el build)
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