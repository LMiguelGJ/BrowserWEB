# Plan: proxy híbrida por sección — proxy-scraper gratuito primero, DataImpulse de respaldo

> Plan Mode · Solo planificación; pendiente de aprobación.
> Ubicación: `.pi/plans/reemplazo-dataimpulse-proxy-pool.md` (nombre histórico; el proveedor gratuito pasó de `proxy_pool` a `proxy-scraper`).
> Ajuste de rutas tras la reorganización: el backend vive en `src/`; `server.js` raíz es solo entrada compatible. Las referencias a `engines/camoufox.js`, `sessions.js` y `server.js` equivalen a `src/engines/camoufox.js`, `src/sessions.js` y `src/server.js`. Los módulos nuevos del plan van en `src/network/`.
> Revisión 2: reemplaza `jhao104/proxy_pool` (con Redis y API Flask) por `maximilianfeix/proxy-scraper` (sin base de datos, validación estricta y API compatible con `proxy_pool`).

## Summary

Obtener de `maximilianfeix/proxy-scraper` un proxy público **verificado con TLS y con salida propia** por sección, usarlo como proxy del contexto de Camoufox de esa sección y comprobar en el navegador que la salida es pública y distinta de las demás. Solo si el pool gratuito no entrega una salida válida y distinta dentro de su plazo, recurrir a DataImpulse con su puerto sticky por sección. Si falla cualquiera de las dos, conservar la identidad de la sección y restaurar su navegación dentro de los límites del estado recuperable, comenzando de nuevo por las gratuitas.

El usuario eligió **todo dentro de una sola imagen/contenedor**: PyRock y el servicio de proxy-scraper. No se implementa ni despliega nada al aprobar únicamente este documento: hace falta aprobación explícita de ejecución.

## Current State Analysis

Archivos examinados (rutas actuales):

- `src/engines/camoufox.js`: un navegador Camoufox; un contexto por sección. `sectionProxy()` deriva puertos sticky de DataImpulse; `launch()` también usa `PYROCK_PROXY` y opcionalmente GeoIP. Cambiar la proxy exige crear otro contexto; no se asumirá cambio en caliente del contexto existente. Ya existe un interceptor de `page.route` opcional para rastreadores (`PYROCK_BLOCK_ADS`).
- `src/sessions.js`: manager con creación, cierre, restart, adopción de popups y controlador de preview reutilizable. `restart()` descarta contexto/estado; no sirve sin modificaciones para recuperación conservando navegación. Sus operaciones se serializan.
- `src/server.js`: inicialización, recuperación global y routing por `session`; navegación con reintentos; panel `/api/network` y `/api/network/measure` con error por sección.
- `src/network-ip.js`: mide la IP de salida navegando a un servicio de IP en una **pestaña temporal del mismo contexto/proxy**, con TLS estricto, cadena de servicios de respaldo, límite total y cierre garantizado de la pestaña. Es el helper que reutiliza esta integración para confirmar la salida real de cada sección.
- `public/script.js`: panel Red; medición automática al abrir; muestra `IP sin medir` / `Medición fallida` / `Última IP`.
- `package.json`: Node >=22, Camoufox y Playwright; suite `node --test test/*.test.js`.
- `Dockerfile`: única imagen Node 22 Bookworm, usuario no-root, Camoufox, codecs ffmpeg y **ya instala `python3`, `make` y `g++`**. Hoy ejecuta solo `node server.js` y copia de forma explícita manifiesto, entrada, `src/` y `public/`.
- `.dockerignore`: lista permitida de runtime; habrá que admitir explícitamente lo que agregue el servicio.
- `.env`: ignorado por Git; contiene hoy las credenciales de DataImpulse y `PYROCK_PROXY_STICKY_BASE`. Ahí vivirá también la contraseña del pool, nunca versionada.

### Evidencia medida en esta máquina (Camoufox real, sin DataImpulse)

| Prueba | Resultado |
| --- | --- |
| `proxy-scraper`: `/pop?protocol=http&https=1` × 3 → 3 contextos Camoufox | **3 salidas distintas**: `103.237.102.191`, `104.28.196.79`, `45.155.125.254`; **idénticas en la segunda ronda**; 3 de 3 supervivientes |
| `proxy-scraper`: `/pop?type=https` (trae SOCKS) → 3 contextos | **3 de 3 fallaron** (1 `NS_ERROR_CONNECTION_REFUSED`, 2 timeouts de 20 s) |
| Lista plana de Monosans (HTTP) | 3 salidas distintas, pero **murieron en segundos**: las rondas siguientes y la reconexión fallaron |
| Monosans, 14 candidatas | 11 fallaron al primer intento |
| `proxy_pool` (jhao104), 41 candidatas | **1 de 41** respondió; la API valida HTTPS con `verify=False` |
| API del pool sin credenciales | `401` con `WWW-Authenticate: Basic realm="proxy-scraper"` |
| Pool rotativo con `session-NAME` | **no dio salidas distintas** entre dos sesiones (misma IP con y sin contraseña, con `weighted` y con `round-robin`); el anclaje de una misma sesión sí funcionó |
| Suministro de proxies con TLS verificado | fluctuó 18 → 4 → 16 → 11 → **0** en minutos |
| Metadatos del propio pool | 23,4 % de los aciertos salen de datacenters y 13,1 % de IPs listadas en SpamCop |

### Contrato de `proxy-scraper` verificado en su repositorio

- Paquete PyPI `proxy-scraper-cli` **1.30.0**; Python >= 3.9; dependencias `rich` y `certifi` (uvloop opcional con extra `fast`; el extra `mcp` **no** se necesita). Sin base de datos: el estado aprendido vive en un directorio de usuario.
- API de pool en el mismo puerto del servidor: `/get`, `/pop`, `/all`, `/count`, `/delete` y **`/report?proxy=IP:PORT&ok=0`**. Es compatible con `proxy_pool` salvo `last_time`, `anonymous` booleano y `source` fijo.
- Filtros aplicables a `/get`, `/pop` y `/all`: `protocol`, `https`, `anonymity`, `country`, `max_latency`, `format`.
- Verificación del propio proxy: **certificado TLS que valida**, una **segunda petición a otro sitio que debe mostrar la misma IP de salida** y una **página estática que debe llegar byte a byte**. Resultado con `exit_ip`, `country`, `anonymity` (elite/anonymous/transparent), `asn`, `org`, `hosting` y latencia.
- Operador: `--recheck live --want N --serve --serve-host 127.0.0.1 --serve-refill 6`; el servidor escucha en loopback salvo `--serve-host`, y con `PROXY_SCRAPER_SERVE_PASSWORD` exige autenticación.
- El propio autor advierte: de la lista de una hora, ~25 % sigue en pie un día después; de 3,6 millones de comprobaciones, **54 % de los proxies que respondieron la primera petición no pasaron la segunda**.

## Assumptions & Decisions

1. Requisito literal: «si ip proxy deja de funcionar a medio camino esta debe buscar una ip buena otra vez para mantener esa seccion y restaurar su conexion».
2. La IP puede cambiar durante recuperación; las secciones listas deben tener salidas públicas distintas verificadas. Endpoint o puerto distinto no basta.
3. **La fuente gratuita es la API de pool de `proxy-scraper`**, no su servidor rotativo. Se toma **un proxy explícito por sección** con `/pop?protocol=http&https=1` y ese proxy se usa **directamente** como proxy del contexto (lo medido: es lo que funcionó en Camoufox). No se usan `session-NAME`, ni `--sticky`, ni el túnel rotativo: no darían salidas distintas por sección.
4. **Solo proxies HTTP.** El filtro `https=1` también admite relays SOCKS que en la prueba no respondieron dentro de Camoufox; `protocol=http` es obligatorio. Los SOCKS quedan fuera de alcance, no "pendientes de probar".
5. **La API del pool exige autenticación Basic** cuando hay contraseña. PyRock la envía desde el entorno; la contraseña nunca sale en logs ni en respuestas de la API.
6. El pool aplica su propia verificación estricta, pero **la última palabra es la medición de PyRock en el navegador** (`src/network-ip.js`): si la salida medida no es pública, no es distinta o falla, el proxy se devuelve con `/report?proxy=…&ok=0` y se pide otro.
7. `/pop` saca el proxy del pool, pero PyRock mantiene **su propia tabla de reservas** (IP normalizada, endpoint, sección, generación, fecha) para garantizar unicidad entre secciones gratuitas y respecto de las de DataImpulse, y para no reusar un proxy liberado.
8. **Plazo gratuito de 60 s por sección** (configurable, `PYROCK_FREE_SEARCH_TIMEOUT_MS`, entero entre 10 000 y 300 000). Se prueban candidatos del pool hasta obtener una salida válida y distinta, agotar el pool o vencer el plazo. El plazo puede vencer antes de agotarlo: se registra ese motivo, sin afirmar que se probaron todos. Pool vacío o API caída tras su timeout también son resultados negativos explícitos.
9. **Nunca usar conexión directa.** Si el pool no da salida y el respaldo no está disponible o falla, la sección queda en `waiting` con motivo visible.
10. **DataImpulse sigue siendo el respaldo**, con su puerto sticky por sección: `PYROCK_PROXY` y `PYROCK_PROXY_STICKY_BASE` se conservan como configuración privada, nunca como proxy global de arranque, recolección ni validación gratuita. La base sticky debe ser válida para poder comprobar la IP real: no se reutiliza el puerto rotativo 823 como identidad estable. Si falta configuración válida del respaldo, esperar con motivo explícito.
11. Recuperación significa mantener ID/nombre/controlador, URL y estado web recuperable. Se conservarán cookies, localStorage y sessionStorage por origen cuando puedan leerse antes del fallo. Nunca se prometerán DOM, formularios no guardados, conexiones WebSocket/WebRTC ni sesión remota ininterrumpidos.
12. No repetir automáticamente clicks, tipeo, envíos de formularios, POST ni comandos de scripts. Reabrir solo una URL HTTP(S) mediante GET; puede existir un corte o un login nuevo exigido por el sitio al cambiar IP.
13. No instalar certificados de proxies públicos, desactivar TLS ni usar `ignoreHTTPSErrors`. No recomendar cuentas sensibles sobre este sistema. No persistir snapshots de sesión ni mostrarlos en logs/API.
14. El alcance es tráfico HTTP(S)/WSS sobre proxies HTTP con CONNECT. No se da por protegido UDP/WebRTC por poner una proxy al contexto. Antes de habilitar navegación, probar y configurar el motor para impedir salidas web directas (incluidos WebRTC, bypass local y DNS de destinos); si no puede demostrarse, bloquear la entrega como segura. browser.lol podría no funcionar con proxies gratuitos: es una incógnita declarada, no un supuesto favorable.
15. Se conserva el único Dockerfile, sin Docker Compose ni servicios externos: el servicio de `proxy-scraper` corre **dentro de la misma imagen**, en loopback, supervisado junto a PyRock.
16. Decisión del usuario: «revisar todos los candidatos disponibles en ese momento, con un límite de tiempo. Si ninguno funciona con una IP distinta, usar DataImpulse».
17. Decisión del usuario: «Mantener DataImpulse hasta que falle o cierres la sección». No migrar una sección pagada sana a una gratuita. Si falla DataImpulse, iniciar un ciclo gratuito nuevo antes de volver a intentar el respaldo. Cerrar y crear una sección nueva empieza por gratuitas.
18. El suministro gratuito es escaso y volátil (0-18 proxies con TLS verificado en minutos). Es aceptable: una sección que no obtiene salida queda esperando y **no se degrada a conexión directa**. El panel debe mostrar la escasez con honestidad.
19. Sin cargo por GB de DataImpulse en las secciones gratuitas, pero el respaldo sí consume saldo (sondeos y reconexiones incluidos), y el ancho de banda del servidor sigue siendo propio.
20. Filtros de calidad del pool disponibles y deseables: descartar salidas de datacenters y de blocklists cuando el pool lo permita (`--no-datacenter`, `--no-blocklisted` en el servicio; el filtro de la API no los expone, así que la preferencia es del lado del servicio).

## Proposed Changes

### 1. Empaquetado y servicio — `Dockerfile`, nuevo `ops/supervisord.conf`, `README.md`

- Instalar en la imagen el paquete `proxy-scraper-cli==1.30.0` **sin el extra `mcp`** en un venv propio (`/app/.venv`) con `uv`, sin instalar nada global. `python3` ya está en la imagen; no agregar Redis, ni PostgreSQL, ni dependencias de red extra.
- Añadir `supervisor` (paquete Debian) y un `ops/supervisord.conf` con **dos programas**: `proxy-scraper` (prioridad 10) y `node server.js` (prioridad 20), con reinicio controlado, apagado por SIGTERM y espera razonable. Un solo proceso no alcanza: el pool y la app deben reiniciarse por separado.
- El servicio arranca como `proxy-scraper --recheck live --want 200 --serve --serve-host 127.0.0.1 --serve-refill 6 --no-datacenter --no-blocklisted` con `PROXY_SCRAPER_SERVE_PASSWORD` tomada del entorno. Escucha **solo en loopback**; sin `--serve-host 0.0.0.0`. El puerto 8899 no se publica.
- El estado aprendido y el historial viven en `/app/state` (volumen opcional, no obligatorio). Los resultados no se versionan.
- Orden de arranque: proxy-scraper primero; PyRock arranca igual y sirve UI con el pool vacío, pero **nunca abre páginas externas sin proxy validada**. `/health` distingue servicio caído de pool vacío.
- `Dockerfile`: copiar de forma explícita lo que el runtime necesite (`.dockerignore` permite hoy solo manifiestos, entrada, `src/` y `public/`; hay que admitir `ops/` y nada más). El servicio no necesita el código de PyRock.
- `README`: arranque monolítico, variables nuevas, límites medidos, actualización del paquete y diagnóstico. No copiar credenciales ni el `.env`.

### 2. Cliente del pool y asignación — nuevo `src/network/proxy-pool.js` y `src/network/proxy-fallback.js`

- `proxy-pool.js`: cliente HTTP de la API del pool. Autenticación Basic desde el entorno; nunca accepta una URL de proxy del cliente web. Timeouts cancelables: 5 s para la API, 8 s para la medición, recortados por el plazo global de 60 s.
- Flujo por sección: pedir `/pop?protocol=http&https=1` → validar formato (IP pública, puerto válido, sin credenciales) → **medir la salida en el navegador** con `src/network-ip.js` → si es pública y distinta, publicarla; si no, `/report?proxy=…&ok=0` y pedir otra, hasta agotar el plazo o el pool.
- Concurrencia: máximo 2 validaciones globales simultáneas y turnos equitativos entre secciones; una sección cancelada o cerrada no sigue consumiendo intentos.
- Tabla de reservas en PyRock: IP normalizada, endpoint, sección, generación, fecha. Impide que dos secciones compartan salida y que una salida gratuita choque con la de una sección de DataImpulse. No se reusa un proxy liberado.
- `proxy-fallback.js`: DataImpulse. Solo se invoca tras un resultado negativo gratuito vigente. Reserva puertos sticky exclusivos en 10000–20000 (base + número de sección, buscando puertos libres si hay IP duplicada), valida HTTPS e IP en el contexto candidato y aplica la misma tabla de reservas. Máximo 3 candidatos de puerto y 30 s por intento. Si falta configuración, falla o no hay IP única: la sección queda `waiting`, nunca con IP duplicada ni conexión directa.
- Motivos de resultado por sección y generación: `pool_empty`, `pool_unavailable`, `candidates_exhausted`, `deadline_exceeded`, `fallback_unavailable`, `fallback_failed`. El panel los muestra sin inventar que se probaron candidatos no probados.

### 3. Motor y estado — `src/engines/camoufox.js`, `src/sessions.js`

- Inyectar la asignación explícita al crear cada contexto: `provider=free|dataimpulse`, endpoint sin credenciales e IP reservada. Sin proxy residencial global ni geolocalización derivada de otro contexto. Conservar fingerprint nativo, humanización, popups y codec.
- Recuperación serializada por sección con tokens de generación para invalidar callbacks tardíos. No sostener la cola global durante validaciones: reservar y publicar atómicamente, medir fuera de ella. Un proveedor pagado sano se conserva en reinicios técnicos; los fallos confirmados disparan un ciclo nuevo gratuito → respaldo.
- `networkState` separado del `state` existente: `waiting`, `validating`, `connected`, `recovering`, `failed`; las APIs previas siguen compatibles mediante campos nuevos.
- Estado recuperable en memoria: captura al terminar navegación, cada 60 s en secciones vivas y al iniciar recuperación cuando sea posible, sin callbacks solapados. Cookies/localStorage por contexto y sessionStorage por origen, restaurado solo en su origen.
- Al detectar fallo confirmado: pausar comandos con error recuperable 503, detener el tráfico del contexto viejo, **devolver el proxy al pool con `/report`**, liberar la salida y recuperar. Conservar snapshot y última URL antes de desechar el contexto; si no se puede leer, usar el último snapshot y declarar su antigüedad.
- Crear contexto candidato, restaurar estado y URL GET segura, medir la salida, cambiar la página con `controller.setPage()` y cerrar los recursos viejos. Los fallos intermedios no dejan contextos, reservas ni temporizadores huérfanos.
- Cierre de sección, reinicio del navegador y apagado cancelan la recuperación. Un callback tardío nunca puede resucitar una sección cerrada ni publicar una IP vencida.
- El controlador de preview conserva sus viewers y anuncia indisponibilidad temporal; las otras secciones no se reinician.

### 4. Salud y reconexión — nuevo `src/network/proxy-health.js`, `src/server.js`

- Revisar la salida cada 120 s por sección, escalonado con jitter hasta 15 s; un único sondeo por sección en curso, respuesta pequeña, timeout de 8 s, con la pestaña temporal de `src/network-ip.js` siempre cerrada.
- Dos fallos consecutivos confirman pérdida de proxy. Un 403/429 del sitio o un recurso bloqueado **no** prueban que la proxy murió: no rotar por ruido.
- Errores inequívocos de túnel o de conexión disparan comprobación inmediata, deduplicada con el health-check y con los reintentos de navegación actuales, sin multiplicar recargas.
- Recuperación: ciclo gratuito con su plazo de 60 s; solo tras resultado negativo, respaldo DataImpulse (3 candidatos/30 s). Si ambos fallan, `waiting` y nuevos ciclos a 30, 60, 120 y luego 300 s con jitter. Sin recargas ni consultas pagadas ilimitadas.
- Si DataImpulse queda conectado, mantenerlo sin búsquedas periódicas de migración gratuita hasta fallo o cierre; sí conservar su control de salud.
- Cambios de IP detectados actualizan la reserva; si colisionan con otra sección, esa sección se suspende y busca reemplazo. No prometer unicidad continua entre mediciones.
- `/api/network` y `/api/network/measure` siguen siendo compatibles y agregan `mode=hybrid`, proveedor por sección (`free`/`dataimpulse`), estado, error saneado, fecha, reconexiones y origen de la medición. Para el respaldo: motivo y fecha de activación. Nunca contraseñas. No presentar una IP anterior como vigente mientras se recupera.
- `/health` distingue proceso caído de pool vacío y de sección esperando.

### 5. Panel — `public/script.js`, `public/index.html`, `public/styles.css`

- Reutilizar Red. Mostrar por sección: IP verificada en su celda propia, proxy sin credenciales, puerto, fecha, **proveedor** (`Gratis` / `DataImpulse · consume saldo`) y estado (conectada, comprobando gratuitas, conectando respaldo, reconectando, esperando proxy).
- Si una sección espera por escasez del pool, decirlo con su motivo; no fingir que se probaron candidatos no probados.
- Refrescar al abrir el panel y cada 5 s solo mientras esté abierto; detener sondeos al cerrar. Consultar el estado no genera comprobaciones externas.
- `Medir ahora` usa la misma comprobación deduplicada del gestor, sin competir con la recuperación ni rotar un proxy sano.
- Indicar que la reconexión puede recargar el sitio y perder estado no guardado. No añadir controles de optimización ajenos a esta sustitución.

### 6. Tests y documentación

- Nuevos tests deterministas en `test/proxy-pool.test.js` (cliente del pool con un pool falso: unicidad, deadlines, `401`, `/report`), `test/proxy-health.test.js` y `test/proxy-recovery.integration.test.js`.
- Extender `test/fixtures/fake-camoufox.js` y los fixtures de proxies para fallos, duplicados y cancelación. La suite normal **no** toca internet: el pool falso y los proxies de fixture son locales; los candidatos de loopback solo se permiten por inyección de tests.
- Actualizar `test/camoufox-engine.test.js`, `test/network-panel.test.js`, `test/network-panel-rotating.test.js`, `test/preview-state-client.test.js`, `test/sessions.test.js` y las suites de integración según el contrato final, conservando las regresiones aplicables.
- Script opt-in de humo real, fuera de la suite: reutilizar el patrón ya probado en `temp/monosans-integration/feasibility.test.cjs` (pool real + Camoufox + IPs distintas + medición de salida) y anotarlo en el README como opcional y con consumo de tráfico real.
- README: arranque monolítico, variables nuevas (`PYROCK_PROXY_POOL_URL`, `PYROCK_PROXY_POOL_PASSWORD`, `PYROCK_FREE_SEARCH_TIMEOUT_MS`), DataImpulse conservado para respaldo, prioridad gratuita, permanencia en respaldo sano, consumo pago residual, riesgos de proxies públicos, API, health y límites de restauración. Ajustar `.dockerignore` para admitir `ops/` y excluir el estado de Python.

## Verification

1. **Primero pruebas RED por regla**: IPs distintas, failover, conservación de estado recuperable y prohibición de salida directa. GREEN tras implementación y luego suite completa `npm test` preservando exit code, stdout y stderr.
2. Pruebas del cliente del pool con pool falso:
   - Dos secciones concurrentes que reciben el mismo proxy: solo una lo publica; la otra pide otro.
   - Pool vacío, `401`, respuesta malformada o proxy con IP no pública: la sección queda `waiting` o `failed` **sin** conexión directa y sin tocar reservas ajenas.
   - `protocol=http` obligatorio: una respuesta con `socks5://` se rechaza.
   - Cada fallo de medición produce exactamente un `/report?proxy=…&ok=0`.
   - Gratis válida antes de agotar el plazo: **cero conexiones a DataImpulse**, incluidos sondeos y tráfico de arranque.
   - DataImpulse sano con nueva gratuita disponible: no se migra ni se abre una búsqueda gratuita para esa sección. Fallo confirmado de DataImpulse: primero ciclo gratuito; si funciona, no volver al respaldo.
   - DataImpulse sin credenciales o base sticky válida, con IP duplicada o sin IP única: espera explícita, sin bypass ni violación de unicidad. El tráfico pago se simula con fixture; pruebas reales de DataImpulse requieren autorización específica de consumo.
3. Integración con Camoufox real y proxies controlados: cortar el proxy A durante navegación y en reposo; restaurar la sección A con el proxy C conservando ID, cookies, almacenamiento y URL, con el preview recuperado; la sección B conserva salida y estado. Solo se permiten endpoints locales de fixture por inyección de tests.
4. Registrar en el sitio de prueba que no se repite un POST ni un click, que los comandos durante recuperación responden 503 y que cerrar la sección o apagar durante un failover no la resucita. Probar popup adoptado y callbacks de página vieja.
5. Verificar fallo único del servicio de IP, respaldo, TLS inválido, destino 403, timeouts cancelados y cuarentena; no rotar por ruido ni generar rondas paralelas. Tests con relojes inyectados, sin esperas reales de minutos.
6. `docker build -t pyrock:proxy-pool .` y ejecución local aislada: comprobar los dos procesos supervisados como usuario no-root, puerto 8899 sin publicar, terminación por SIGTERM, readiness y recuperación de dependencias. No desplegar producción en estas pruebas.
7. **Smoke opt-in contra el servicio real** (no en la suite): obtener al menos dos salidas verificadas distintas medidas **en el navegador**, repetir la medición para confirmar estabilidad y cortar una salida para observar la reconexión. Si el pool no da inventario suficiente, declarar la prueba bloqueada; no simular éxito con mocks.
8. Verificar egress HTTPS/WSS, DNS y WebRTC con destinos controlados: sin proxy válida no hay salida web directa. Probar browser.lol por separado; una IP HTTP distinta no demuestra aislamiento del video WebRTC ni del navegador remoto alojado por browser.lol.
9. Diagnósticos LSP de los archivos modificados y verificación independiente, por tratarse asignación concurrente, secretos, red y empaquetado. Revisar el candidato según el switch RDD, sin reconstruir autoridad nativa.
10. Conservar compatibilidad: `/api/*`, parámetro `session`, default sin sesión, `MAX_SESSIONS`, preview y cierre WS `4404`. No declarar entrega validada si falta la prueba de aislamiento o de recuperación real.

## Execution Order / Review Scope

1. Empaquetado reproducible y servicio `proxy-scraper` en la imagen; arranque aislado y healthcheck.
2. Cliente del pool, reservas únicas y medición en navegador; integración al motor **sin** recuperación automática todavía.
3. Recuperación con estado, health, `/report`, cancelación y pruebas de concurrencia.
4. Panel y documentación; integración real y validación final.

Es probable que supere 400 líneas. Separar en esas unidades revisables; si posteriormente se piden PRs, recomendar PRs encadenadas. Este plan no autoriza commits, push, PR ni despliegue.

## Out of Scope

- Proxies residenciales garantizadas, IP fija, país garantizado o navegación sensible segura sobre proxies públicos.
- Prometer continuidad de video/WebSocket, formularios o sesión remota después de cambiar IP.
- Rotar o revelar credenciales de DataImpulse o del pool, editar `.env`, instalar certificados ajenos o desactivar validación TLS. Su lectura privada desde el entorno para el respaldo sí queda contemplada para la futura implementación.
- El **servidor rotativo** de proxy-scraper y el anclaje por `session-NAME`: medido, no da salidas distintas por sección.
- Proxies **SOCKS** y UDP/WebRTC a través de proxies gratuitos: no funcionan en la prueba y quedan fuera de alcance.
- El **servidor MCP** de proxy-scraper: es para agentes de IA (Claude, Cursor), no para el runtime de PyRock.
- Publicar el puerto del pool, añadir Redis u otras bases de datos, servicios de pago adicionales, VPN Gate o Tor. DataImpulse es el único respaldo comercial contemplado, exclusivamente tras un resultado gratuito negativo.
- Optimización de imágenes, anuncios, FPS, caché o presupuesto de tráfico: trabajo distinto.
- Implementación, instalación, commits, push o deploy durante el modo plan.

## Phase Status

- Fase 1 completada: exploración de archivos reales y patrones existentes, más medición en vivo con Camoufox y con el CLI real de `proxy-scraper`.
- Fase 2 completada: el usuario eligió «Todo dentro de una sola imagen», búsqueda gratuita con límite de tiempo y permanencia en DataImpulse hasta fallo o cierre. La revisión 2 sustituyó el proveedor gratuito por `proxy-scraper` y fijó el uso de su API de pool. No quedan preguntas pendientes.
- Fase 3 completada: documento regenerado con la evidencia medida.
- Fase 4: notificación lista; ejecución pendiente de aprobación explícita. Ninguna fase omitida.
