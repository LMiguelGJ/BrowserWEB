# Configuración de entorno

Qué variables lee PyRock, cuáles poner en cada sitio y cuáles ya no existen.

## Dónde van las variables

| Dónde corre | De dónde saca las variables |
|---|---|
| Contenedor Docker (producción) | De la **plataforma de despliegue**, no de un archivo del repo |
| Local, con `npm start` | Del archivo `.env` de la raíz (ignorado por Git) |

La imagen ya trae estos valores por defecto (`Dockerfile`), y no hace falta repetirlos salvo que quieras cambiarlos:

```
NODE_ENV=production
CAMOUFOX_HEADLESS=virtual
PYROCK_PROXY_MODE=hybrid
PYROCK_PROXY_POOL_URL=http://127.0.0.1:8899
PYROCK_FREE_SEARCH_TIMEOUT_MS=60000
```

## Variables del pool: la parte que más confunde

```bash
# El pool exige autenticación Basic y PyRock envía `any:<valor>`.
# Las dos tienen que ser EXACTAMENTE iguales.
PROXY_SCRAPER_SERVE_PASSWORD=<clave larga y aleatoria>
PYROCK_PROXY_POOL_PASSWORD=<la misma clave>
```

Si difieren, el pool responde `401` y no hay ninguna salida gratuita: el panel muestra `POOL GRATUITO clave incorrecta`. Si coinciden pero el pool todavía no escuchó, muestra `no responde` (arranque en frío) y el app **espera hasta su plazo** en vez de rendirse.

Generá la clave con `openssl rand -hex 16` y poné la misma en la plataforma y en el `.env` local.

## Variables de DataImpulse (respaldo de pago)

```bash
# Las credenciales van en la URL completa; si tienen @ : /, URL-encodearlas.
PYROCK_PROXY=http://USUARIO:CLAVE@gw.dataimpulse.com:823
# Una IP fija por sección: cada sección usa el puerto base + su número
# (s1 -> 10001, s2 -> 10002). El puerto rotativo no sirve: cambia la IP en
# cada petición.
PYROCK_PROXY_STICKY_BASE=10000
# La geolocalización de la huella se calcula desde la IP del proxy.
PYROCK_GEOIP=1
```

## Opcionales

| Variable | Default | Para qué |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor |
| `MAX_SESSIONS` | `5` | Secciones simultáneas (1-10) |
| `PYROCK_GEOIP` | apagado | `1` = geolocalización coherente con la IP del proxy |
| `PYROCK_NETWORK_RETRY_MS` | `30000,60000,120000,300000` | Espera entre reintentos de recuperación |
| `PYROCK_SETTLE_TIMEOUT_MS` | `20000` | Cuánto espera el servidor a que la página *se vea* |
| `PYROCK_BLOCK_ADS` | apagado | `1` corta peticiones de anuncios y analytics; algunas páginas quedan colgadas |
| `CAMOUFOX_OS` | el del host | SO simulado en la huella |
| `CAMOUFOX_LOCALE` | `es-ES` | Locale de la huella |

## Variables que ya no existen

El proyecto usa **Camoufox** (Firefox), no Puppeteer/Chromium. Estas no las lee nadie y conviene borrarlas para no creer que están haciendo algo:

`PUPPETEER_SKIP_CHROMIUM_DOWNLOAD`, `PUPPETEER_EXECUTABLE_PATH` (solo la usa un helper de tests locales), `BROWSER_HEADLESS`, `BROWSER_TIMEOUT`, `WS_HEARTBEAT_INTERVAL`, `LOG_LEVEL`, `SCREENSHOT_QUALITY`, `SCREENSHOT_FORMAT`, `DISABLE_WEB_SECURITY`, `NO_SANDBOX`.

La seguridad del contenedor no viene de esas: viene de Camoufox (`network.proxy.failover_direct=false` y WebRTC solo por proxy) y de ejecutar como usuario no-root.

## Correr el contenedor

```bash
docker run -d --name pyrock \
  -p 3000:3000 \
  --env-file .env \
  -v pyrock-state:/app/state \
  --restart unless-stopped \
  <imagen>
```

- `-v pyrock-state:/app/state`: guarda el estado aprendido del pool y sus resultados. Sin volumen, cada reinicio pierde el historial y el pool arranca de cero.
- **No publiques el 8899**: el pool solo escucha en `127.0.0.1:8899` dentro del contenedor.

## Verificar sin desplegar

```bash
curl -s localhost:3000/api/network | python3 -m json.tool
```

- `pool.status: "ok"` con `pool.count.total`: el pool está caliente y hay salidas.
- `pool.status: "unavailable"` con `reason: "unreachable"`: todavía no escuchó (arranque en frío).
- `reason: "unauthorized"`: las dos contraseñas no coinciden.
- En `sections`, cada una con su `ip` distinta y su `provider` (`free` o `dataimpulse`).
