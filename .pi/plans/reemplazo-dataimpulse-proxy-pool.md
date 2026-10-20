# Plan: proxy híbrida por sección — gratuitas primero, DataImpulse de respaldo

> Plan Mode · Solo planificación; pendiente de aprobación.
> Ubicación: `.pi/plans/reemplazo-dataimpulse-proxy-pool.md`
> Ajuste de rutas tras la reorganización: el backend vive en `src/`; `server.js` raíz es solo entrada compatible. Las referencias históricas siguientes a `engines/camoufox.js`, `sessions.js` y `server.js` corresponden ahora a `src/engines/camoufox.js`, `src/sessions.js` y `src/server.js`; los nuevos módulos `network/` se crearán en `src/network/`. Docker usa copia explícita/lista permitida: al implementar este plan habrá que incorporar `ops/` y `vendor/` donde se necesiten para el build/runtime.

## Summary

Priorizar proxies públicos obtenidos de `jhao104/proxy_pool`, verificando una IP pública distinta para cada sección antes de permitir navegación. Solo si la búsqueda gratuita se agota o alcanza su límite de tiempo sin una salida válida y distinta, recurrir a DataImpulse. Si falla cualquiera de las dos, conservar la identidad de la sección y restaurar su navegación dentro de los límites del estado recuperable, comenzando nuevamente por las gratuitas.

El usuario eligió **todo dentro de una sola imagen/contenedor**: PyRock, Redis y los procesos de proxy_pool. No se implementa ni despliega nada al aprobar únicamente este documento: hace falta aprobación explícita de ejecución.

## Current State Analysis

Archivos examinados:

- `engines/camoufox.js`: un navegador Camoufox; un contexto por sección. `sectionProxy()` deriva puertos sticky de DataImpulse; `launch()` también usa `PYROCK_PROXY` y opcionalmente GeoIP. Cambiar la proxy exige crear otro contexto; no se asumirá cambio en caliente del contexto existente.
- `sessions.js`: manager con creación, cierre, restart, adopción de popups y controlador de preview reutilizable. `restart()` actualmente descarta contexto/estado; no sirve sin modificaciones para recuperación conservando navegación. Sus operaciones se serializan.
- `server.js`: inicialización, recuperación global y routing por `session`; navegación con reintentos; panel `/api/network` y medición gratuita. La medición fue corregida mediante `src/network-ip.js`: usa una pestaña temporal en el mismo contexto/proxy y muestra errores por sección, sin depender del CSP/CORS de la página del usuario. No hay gestor de asignación ni recuperación de proxy.
- `package.json`: Node >=22, Camoufox y Playwright; suite `node --test test/*.test.js`.
- `Dockerfile`: única imagen Node 22 Bookworm, usuario no-root, Camoufox y codecs. Hoy ejecuta solo `node server.js`.
- `public/script.js`: panel Red, medición al abrir y estado de preview; muestra configuración DataImpulse, no asignaciones de un pool.
- `.dockerignore`: permite solo manifiestos npm, entrada, `src/` y `public/`; habrá que extenderlo explícitamente para el upstream Python vendorizado y configuración de procesos, manteniendo secretos y temporales fuera.

Fuentes previas: https://github.com/jhao104/proxy_pool y su README. Su validación de disponibilidad no demuestra HTTPS funcional, IP exclusiva ni compatibilidad con el sitio destino. Las IPs gratuitas no son necesariamente residenciales ni confiables.

## Assumptions & Decisions

1. Requisito literal: «si ip proxy deja de funcionar a medio camino esta debe buscar una ip buena otra vez para mantener esa seccion y restaurar su conexion».
2. La IP puede cambiar durante recuperación; las secciones listas deben tener salidas públicas distintas verificadas. Endpoint o puerto distinto no basta.
3. No se garantiza inventario gratuito suficiente. Por sección, tomar una instantánea de los candidatos elegibles disponibles al comenzar la búsqueda y recorrerla sin repetir endpoints, hasta obtener una salida válida y distinta, agotar la lista o cumplir **60 s de plazo total** (incluye consulta al pool, espera de turno y sondeos). No hay límite de tres candidatos gratuitos. El plazo puede vencer antes de probarlos todos: registrar ese motivo, no afirmar que todos fallaron. Solo tras ese resultado negativo puede intentarse DataImpulse; pool vacío o API del pool inaccesible tras su timeout también son resultados negativos explícitos. Nunca usar conexión directa.
4. Recuperación significa mantener ID/nombre/controlador, URL y estado web recuperable. Se conservarán cookies, localStorage y sessionStorage por origen cuando puedan leerse antes del fallo; IndexedDB se incluirá si la versión instalada lo soporta y una prueba lo demuestra. Nunca se prometerán DOM, formularios no guardados, conexiones WebSocket/WebRTC ni sesión remota ininterrumpidos.
5. No repetir automáticamente clicks, tipeo, envíos de formularios, POST ni comandos de scripts. Reabrir solo una URL HTTP(S) mediante GET; pantallas resultantes de operaciones no reproducibles requieren intervención. Puede existir un breve corte o login nuevo exigido por el sitio al cambiar IP.
6. No instalar certificados de proxies públicos, desactivar TLS ni usar `ignoreHTTPSErrors`. No recomendar cuentas sensibles sobre este sistema. No persistir snapshots de sesión ni mostrarlos en logs/API.
7. Conservar `PYROCK_PROXY` y `PYROCK_PROXY_STICKY_BASE` como configuración privada del respaldo DataImpulse, nunca como proxy global de arranque, recolección o validación gratuita. Las credenciales solo se cargan en memoria cuando corresponde el respaldo y nunca salen por logs/API. El modo híbrido requiere base sticky válida para asignar puertos por sección y comprobar la IP real: no reutilizar el puerto rotativo 823 como identidad estable. Si falta configuración válida del respaldo, esperar con motivo explícito, sin usarlo de manera parcial ni editar/revelar `.env`. No aplicar GeoIP global basado en DataImpulse a secciones gratuitas.
8. El alcance es tráfico HTTP(S)/WSS sobre proxies HTTP con CONNECT. No se da por protegido UDP/WebRTC por poner una proxy al contexto. Antes de habilitar navegación, probar y configurar el motor para impedir salidas web directas (incluidos WebRTC, bypass local y DNS de destinos); si no puede demostrarse, bloquear la entrega como segura. Un relay TURN TCP puede ser necesario; browser.lol podría no funcionar con proxies gratuitos.
9. Se conserva el único Dockerfile, sin añadir Docker Compose ni servicios externos. Se acepta mayor consumo de RAM y complejidad de supervisión.
10. Las salidas gratuitas no tienen cargo DataImpulse, pero el respaldo sí consume saldo por tráfico, incluidos sus sondeos y reconexiones. También siguen existiendo ancho de banda del servidor, cómputo y límites gratuitos. No garantizar disponibilidad, velocidad o aceptación por el destino.
11. Decisión del usuario: «revisar todos los candidatos disponibles en ese momento, con un límite de tiempo. Si ninguno funciona con una IP distinta, usar DataImpulse».
12. Decisión del usuario: «Mantener DataImpulse hasta que falle o cierres la sección: menos interrupciones, pero sigue consumiendo saldo». No buscar una gratuita para migrar una sección pagada sana. Si falla DataImpulse, iniciar un nuevo ciclo gratuito antes de volver a intentar el respaldo. Un reinicio técnico que restaura una sección pagada sana conserva su proveedor; cerrar y crear una sección nueva empieza por gratuitas.

## Proposed Changes

### 1. Empaquetado — `Dockerfile`, nuevos `ops/supervisord.conf`, `ops/proxy-pool-settings.py`, `ops/requirements-proxy-pool.lock`, `vendor/proxy_pool/` y `README.md`

- Incorporar Redis, Python con venv y supervisión de procesos al Dockerfile existente; mantener Node 22, Camoufox, codecs y usuario no-root.
- Vendorizar upstream en `vendor/proxy_pool/`, conservando licencia y commit completo de procedencia; fijar dependencias Python verificadas en lock, sin instalar `main` flotante. Revisar contrato vigente de API y arranque en ese commit antes de integrar.
- Supervisar cuatro procesos: Redis, API proxy_pool, scheduler de recolección/validación y PyRock. Apagado SIGTERM con espera y cierre limpio de procesos, contextos y temporizadores. Evitar bucles de reinicio sin límites.
- Redis y API proxy_pool escuchan exclusivamente en loopback (puertos internos 6379 y 5010); solo PyRock 3000 se expone. Redis es efímero; no agregar volumen obligatorio.
- Ordenar arranque y comprobar dependencias. PyRock puede servir UI/health con pool vacío, pero nunca abrir páginas externas sin proxy validada.
- Configuración: `PYROCK_PROXY_MODE=hybrid`, `PYROCK_PROXY_POOL_URL=http://127.0.0.1:5010`, `PYROCK_FREE_SEARCH_TIMEOUT_MS=60000` (entero entre 10000 y 300000; rechazar valores inválidos). El endpoint interno queda fijado para producción, no configurable por clientes web. Conservar `PYROCK_PROXY` y `PYROCK_PROXY_STICKY_BASE` solo para respaldo; no hacer llamadas pagadas al construir la imagen o comprobar disponibilidad gratuita.
- Documentar actualización upstream, límites, diagnóstico y recursos requeridos medidos, no supuestos.

### 2. Asignación — nuevo `network/proxy-pool.js`

- Encapsular listado/adquisición y lectura de la API upstream verificada; usar su endpoint de listado para poder descartar candidatos ya usados, en vez de pedir repetidamente el mismo candidato aleatorio.
- Aceptar solo candidatos HTTP CONNECT con IP pública y puerto válido. Rechazar credenciales arbitrarias, loopback, redes privadas/link-local, metadatos cloud y endpoints malformados; no permitir que un cliente pase su propia URL de proxy.
- Comprobar HTTPS y salida con una página de sondeo dentro del contexto candidato, antes de cargar el sitio del usuario. Usar navegación a un servicio de IP (no fetch en la página del usuario), TLS estricto y validar la respuesta con parser de IP.
- Servicios iniciales: ipify y icanhazip como respaldo. Timeouts cancelables: 5 s para API y 8 s por sondeo, ambos recortados por el plazo global gratuito de 60 s. Recorrer la instantánea completa de candidatos elegibles sin tope artificial de cantidad hasta éxito o agotamiento/plazo; concurrencia máxima de 2 validaciones globales, con turnos equitativos entre secciones. Al vencer el plazo, cancelar sondeos pendientes y descartar resultados tardíos antes de habilitar respaldo; una sección cancelada/cerrada no activa tráfico pago.
- Mantener reservas atómicas de IP normalizada, endpoint, propietario, fecha de validación y generación. Dos creaciones/recuperaciones simultáneas no pueden publicar la misma IP. Rechazar duplicados y confirmar en el contexto que finalmente se adopta, no en una conexión ajena del servidor.
- Cuarentena local de 10 minutos para candidatos fallidos; liberar reservas al cerrar sección. No eliminar globalmente una proxy del upstream por un error aislado de un sitio.
- Guardar resultado de la búsqueda gratuita por sección/generación: candidatos examinados, pendientes, duración y motivo (`pool_empty`, `pool_unavailable`, `candidates_exhausted` o `deadline_exceeded`). Nunca cambiar al respaldo por el primer candidato fallido, un error aislado del sitio ni el fallo de un único servicio de medición.
- Añadir `network/proxy-fallback.js` para DataImpulse. Solo se invoca después del resultado negativo gratuito vigente. Reservar puertos sticky exclusivos en 10000–20000, empezando por base + número de sección y buscando puertos libres adicionales si hay IP duplicada; nunca modificar asignaciones sanas de otras secciones. Validar HTTPS/IP en el contexto candidato y aplicar la misma reserva global de IP usada por gratuitas.
- Limitar cada intento de respaldo a 3 candidatos de puerto y 30 s totales, sin cargas del sitio hasta comprobar IP válida y distinta. Puertos diferentes no garantizan IP diferente. Si el respaldo falta, falla o no ofrece IP única, la sección queda `waiting`; nunca utilizar una IP duplicada ni conexión directa.
- La existencia de credenciales no habilita verificaciones pagadas anticipadas: ni health-check de un respaldo inactivo, ni recolección del pool ni consultas gratuitas pasan por DataImpulse.

### 3. Motor y estado — `engines/camoufox.js`, `sessions.js`

- Inyectar asignación explícita al crear cada contexto: `provider=free|dataimpulse`, endpoint privado e IP reservada. Sin proxy residencial global ni geolocalización derivada de otro contexto. Conservar fingerprint nativo, humanización, popups y codec.
- Incorporar recuperación serializada por sección y tokens de generación para invalidar callbacks tardíos. No sostener la cola global durante búsquedas gratuitas o de respaldo: reservar/publicar atómicamente y validar fuera de ella. Conservar proveedor pagado sano en reinicios técnicos; los fallos confirmados disparan un ciclo nuevo gratuito → respaldo.
- Añadir `networkState` separado del contrato existente `state`: `waiting`, `validating`, `connected`, `recovering`, `failed`; mantener las APIs previas compatibles mediante campos nuevos.
- Guardar último estado recuperable en memoria: capturar al terminar navegación, cada 60 s para secciones vivas y al iniciar recuperación cuando sea posible; callbacks nunca solapados. Usar APIs del contexto para cookies/localStorage y captura de sessionStorage por origen, con restauración únicamente en su origen.
- Al detectar fallo confirmado: pausar comandos nuevos con error recuperable 503, detener/suspender tráfico del contexto viejo, liberar su salida y recuperar. Conservar snapshot y última URL antes de desecharlo; si no se puede leer, usar el último snapshot y declarar su antigüedad.
- Crear contexto candidato, restaurar estado y URL GET segura, validar salida única, cambiar página con `controller.setPage()` y cerrar recursos viejos. Fallos intermedios no dejan contextos, leases ni timers huérfanos.
- Cierre de sección, reinicio del navegador y apagado cancelan recuperación. Un callback tardío nunca puede recrear una sección cerrada ni publicar una IP vencida.
- El controlador de preview mantiene sus viewers y anuncia indisponibilidad temporal; las otras secciones no se reinician.

### 4. Salud y reconexión — nuevo `network/proxy-health.js`, `server.js`

- Revisar salida cada 120 s por sección, escalonado con jitter hasta 15 s; un único sondeo por sección en curso, con pequeña respuesta y timeout de 8 s. Sondeo mediante página aislada temporal del mismo contexto, cerrada siempre.
- Dos fallos consecutivos confirman pérdida de proxy. Un fallo de un servicio de IP prueba el respaldo; un 403/429 del sitio o un recurso bloqueado no prueba que la proxy murió.
- Errores inequívocos de túnel/conexión de navegación disparan comprobación inmediata; deduplicar con health-check y con reintentos actuales de navegación, sin multiplicar recargas.
- Recuperación: cada ciclo comienza con la instantánea gratuita y su plazo de 60 s; solo tras resultado negativo ejecuta respaldo DataImpulse (máximo 3 candidatos/30 s). Si ambos fallan, estado `waiting`; ciclos nuevos a los 30, 60, 120 y luego 300 s con jitter. Sin recargas ni consultas pagadas ilimitadas rápidas. Si DataImpulse queda conectado, mantenerlo sin búsquedas periódicas de migración gratuita hasta fallo/cierre; sí conservar su control de salud deduplicado.
- Cambios de IP detectados por sondeo actualizan reserva; si colisionan con otra sección, se suspende la sección que cambió y busca reemplazo. No prometer unicidad continua entre mediciones.
- Mantener `/api/network` y `/api/network/measure` como contratos compatibles, agregando `mode=hybrid`, proveedor por sección (`free` o `dataimpulse`), estado, error saneado, fecha, reconexiones y origen de la medición. Para respaldo, incluir motivo/fecha de activación y resumen de búsqueda gratuita; nunca contraseñas. No presentar una IP anterior como vigente mientras se recupera.
- Revisar `/health` para readiness de dependencias sin confundir pool temporalmente vacío con proceso muerto. Ningún secreto ni snapshots en respuestas.

### 5. Panel — `public/script.js`, `public/index.html`, `public/styles.css`

- Reutilizar Red, no crear otro panel. Mostrar por sección IP verificada, proxy sin credenciales, fecha, proveedor y estado: conectada, comprobando gratuitas, conectando respaldo, reconectando o esperando proxy. Etiquetas claras «Gratis» y «DataImpulse · consume saldo»; para respaldo mostrar desde cuándo y por qué se activó (incluido plazo agotado, sin afirmar falsamente que se probaron todos).
- Mostrar la IP en su celda propia (los rectángulos solicitados), sin confundir puerto con identidad. Mensaje explícito si faltan IPs únicas.
- Refrescar estado al abrir panel y cada 5 s solo mientras esté abierto; detener sondeo al cerrar. Consultar estado no genera comprobaciones externas nuevas.
- `Medir ahora` usa la misma comprobación deduplicada del gestor, sin competir con recuperación ni rotar una proxy sana.
- Indicar que la reconexión puede recargar el sitio y perder estado no guardado. No añadir controles de optimización ajenos a esta sustitución.

### 6. Tests y documentación

- Nuevos tests deterministas para asignación y salud en `test/proxy-pool.test.js`, `test/proxy-health.test.js`, `test/proxy-recovery.integration.test.js`.
- Extender `test/fixtures/fake-camoufox.js` y fixtures de proxies controlados para fallos, duplicados y cancelación; no depender del inventario público en la suite normal.
- Actualizar `test/camoufox-engine.test.js`, `test/network-panel.test.js`, `test/network-panel-rotating.test.js`, `test/preview-state-client.test.js`, `test/sessions.test.js` y suites de integración según el contrato final, conservando regresiones previas aplicables.
- Actualizar README con arranque monolítico, modo híbrido, plazo gratuito configurable, variables DataImpulse conservadas para respaldo, prioridad gratuita, permanencia en respaldo sano, consumo pago residual, riesgos de proxies públicos, API, health y límites de restauración. Ajustar `.dockerignore` para cachés/estado Python/Redis sin excluir los archivos vendorizados necesarios.

## Verification

1. **Primero pruebas RED por regla**: IPs distintas, failover, conservación de estado recuperable y prohibición de salida directa. GREEN tras implementación, luego suite completa `npm test` preservando exit code/stdout/stderr.
2. Pruebas de API pública: dos secciones concurrentes con candidatos distintos que salen por la misma IP; una sola obtiene la reserva. Pool vacío, candidato inválido y falta de IP única no producen navegación directa ni cambian reservas de otras secciones. Validar exclusividad de IP también entre una sección gratis y otra DataImpulse.
   - Gratis válida antes de agotamiento/plazo: **cero conexiones a DataImpulse**, incluidos sondeos y tráfico de arranque.
   - Más de tres candidatas: una cuarta válida dentro del plazo debe funcionar sin respaldo. Lista agotada, API caída o deadline sin gratuita válida habilitan respaldo con motivo correcto y sin resultados tardíos concurrentes.
   - DataImpulse sano más nueva gratuita disponible: no se migra ni se abre una búsqueda gratuita para esa sección. Fallo confirmado DataImpulse: primero nuevo ciclo gratis; si funciona, no volver al respaldo.
   - DataImpulse sin credenciales/base válida, saldo agotado, TLS inválido o IP duplicada: espera explícita, sin bypass ni violación de unicidad. Simular tráfico pago con fixture; pruebas reales DataImpulse requieren autorización específica de consumo.
3. Integración con Camoufox real y proxies locales controlados: cortar proxy A durante navegación y con página en reposo; restaurar sección A con proxy C, misma ID/cookies/storage/URL y preview recuperado. Sección B conserva IP y estado. Los endpoints locales de fixtures solo se permiten en inyección de tests, nunca candidatos productivos.
4. Registrar en el sitio de prueba que no se repite un POST/click, que los comandos durante recuperación responden 503 y que cerrar sección/apagar durante failover no la resucita. Probar popup adoptado y callbacks de página vieja.
5. Verificar fallo único del servicio de IP, respaldo, TLS inválido, destino 403, timeouts cancelados y cuarentena; no rotar por ruido ni generar rondas paralelas. Tests con relojes inyectados, sin esperas reales de minutos.
6. Construir `docker build -t pyrock:proxy-pool .` y ejecutar localmente en entorno aislado; comprobar cuatro procesos como no-root, puertos internos no publicados, terminación SIGTERM, readiness y recuperación de dependencias. No desplegar producción durante estas pruebas.
7. Smoke opt-in con pool público: obtener al menos dos salidas verificadas distintas, cortar una salida y observar reconexión. Si no existe inventario suficiente, declarar prueba bloqueada; no fingir éxito con mocks.
8. Verificar egress HTTPS/WSS, DNS y WebRTC con destinos controlados: sin proxy válida no hay salida web directa. Probar browser.lol separadamente; IP HTTP distinta no demuestra aislamiento de su video WebRTC ni del navegador remoto alojado por browser.lol.
9. Diagnósticos LSP de archivos modificados y verificación independiente por tratar asignación concurrente, secretos, red y empaquetado. Revisar el candidato según el switch RDD, sin reconstruir autoridad nativa.
10. Conservar compatibilidad: `/api/*`, parámetro `session`, default sin session, `MAX_SESSIONS`, preview y cierre WS `4404`. No declarar entrega validada si falta prueba de aislamiento o recuperación real.

## Execution Order / Review Scope

1. Empaquetado reproducible y contrato upstream; pruebas de arranque aislado.
2. Pool, validación y reservas únicas; integración al motor sin recuperación automática todavía.
3. Recuperación con estado, health, cancelación y pruebas de concurrencia.
4. Panel y documentación; integración real y validación final.

Es probable que supere 400 líneas. Separar en esas unidades revisables; si posteriormente se piden PRs, recomendar PRs encadenadas. Este plan no autoriza commits, push, PR ni despliegue.

## Out of Scope

- Proxies residenciales garantizadas, IP fija, país garantizado o navegación sensible segura sobre proxies públicos.
- Prometer continuidad de video/WebSocket, formularios o sesión remota después de cambiar IP.
- Rotar/revelar credenciales DataImpulse, editar `.env`, instalar certificados ajenos o desactivar validación TLS. Su lectura privada desde entorno para respaldo sí queda contemplada para la futura implementación.
- Publicar Redis/API del pool, añadir otros servicios de pago, VPN Gate o Tor. DataImpulse es el único respaldo comercial contemplado, exclusivamente tras búsqueda gratuita negativa.
- Optimización de imágenes, anuncios, FPS, caché o presupuesto de tráfico: trabajo distinto.
- Implementación, instalación, commits, push o deploy durante el modo plan.

## Phase Status

- Fase 1 completada: exploración de archivos reales y patrones existentes.
- Fase 2 completada: el usuario eligió «Todo dentro de una sola imagen», búsqueda gratuita limitada en tiempo y permanencia en DataImpulse hasta fallo/cierre. No quedan preguntas pendientes para este plan.
- Fase 3 completada: documento generado.
- Fase 4: notificación lista; ejecución pendiente de aprobación explícita. Ninguna fase omitida.
