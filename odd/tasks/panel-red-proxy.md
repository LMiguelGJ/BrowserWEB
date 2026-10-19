# Panel "Red" e IP estable por sección — ODD execution

Objective: mostrar en PyRock por dónde sale el navegador y qué IP usa cada sección, con IP **estable por sección**. Baseline `67b3dea` on `main`.
Delivery: work-unit commit on `main` and push (standing authorization); no PR. Runner: `npm test`.

## Specs

S1. User request verbatim: "ahora mira la imagen y donde esta el retangulo rojo vamos a agregar un nuevo tap asi como los demas pero este caso es para ver la informacion de la proxy la ip que usa ahora dime tu que podemos motrar y como se veria recuerda que son varias seciones y la proxy es rotativa".
S2. Decisiones del usuario: **IP estable por sección** y **sin servicios externos** para clasificar la IP.
S3. Tab nuevo "Red" en el deck (el hueco rojo, a la izquierda de "Registro"), con panel lateral como los otros.
S4. El panel muestra: proxy (host:puerto), modo (rotativo / sticky / sin proxy), autenticación (usuario, nunca la clave) y una fila por sección con su última IP medida y la hora.
S5. Con proxy rotativo la IP cambia por petición: lo que se muestra es siempre una foto con su hora, y el modo queda a la vista.
S6. La medición sale **desde la página de cada sección** (su proxy, su contexto): es la IP que vería el sitio. Botón "Medir ahora".
S7. `PYROCK_PROXY_STICKY_BASE` (10000-20000): cada sección usa el puerto `base + N`, o sea su propia IP fija ~30 min. Se usa el mecanismo de puerto sticky del proveedor porque no requiere marcadores en el usuario (el `;` de `sessid` se percent-codifica y el gateway lo rechaza).

## Tasks

T1 | S7 | motor: proxy por contexto con puerto sticky por sección + helpers de parseo | done | `engines/camoufox.js`: `parseProxyTemplate`, `stickyBase`, `sectionProxy`, `buildProxyUrl`, `proxyOrigin`; `openPage(browser, { section })` pasa `newContext({ proxy })` solo si hay base sticky.
T2 | S4,S6 | servidor: `GET /api/network` y `POST /api/network/measure` | done | `server.js`: `networkOverview()` y medición con `page.evaluate(fetch('https://api.ipify.org/'))` por sección, con timeout de 15 s.
T3 | S3,S4 | cliente: tab "Red", panel y estilos | done | `public/index.html` (tab + panel), `public/script.js` (`renderNetwork`, `measureNetwork`, `PANEL_TABS`), `public/styles.css` (`.net-*`).
T4 | S1-S7 | verificación y entrega | done | Suite 121/121; commit `8d5f432` pusheado.

## Log

L1. Diseño: la proxy vive hoy a nivel de navegador, así que todas las secciones la comparten; y con el puerto rotativo cada petición sale por una IP distinta. Por eso el panel muestra siempre "última IP medida + hora" y el modo a la vista, en vez de una IP que parece fija.
L2. La IP estable por sección se resolvió con puertos sticky (10000-20000): el proveedor liga una IP a cada puerto ~30 min, y así cada sección tiene la suya sin tocar el usuario. Se descartó la forma `login__cr.cc;sessid.N` porque `new URL()` la percent-codifica a `%3B` y el gateway rechaza esa forma (verificado: la literal funciona, la codificada no).
L3. La medición se hace desde la página de la sección, no desde el servidor: así usa el proxy y el contexto de esa sección. `api.ipify.org` envía cabeceras CORS, así que la lectura desde la página funciona (verificado).
L4. Sin clasificación residencial/datacenter: se pidió no depender de servicios externos. El panel muestra solo IP, hora y modo.
L5. Aplicado: `python3/make/g++` ya estaban en la imagen; en este trabajo no se tocó el Dockerfile. Pendiente del usuario: fijar `PYROCK_PROXY_STICKY_BASE` en el entorno del servidor para que las secciones tengan IP fija.
