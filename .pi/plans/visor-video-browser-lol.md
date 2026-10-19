# Plan: Ver el navegador remoto de browser.lol dentro del preview de PyRock

> Created by `plan-mode-trae` skill — Plan Mode of Trae IDE, adapted to Pi.
> Path: this file · Language: es · Created: 2026-10-19

## Summary

Hacer que, dentro de una sección de PyRock, la prueba gratuita de browser.lol se vea completa: la pestaña de sesión se sigue, el navegador remoto (un `<video>`) aparece en el preview y el panel explica con precisión qué espera cuando la página no carga. Sin login, sin API key y sin reenviar clics al remoto.

## Current State Analysis

> Filled from Phase 1 exploration. Must reference real files and patterns read.

- **Project**: PyRock — panel Node/Express (ES modules en `public/`, CommonJS en el server) que opera navegadores aislados vía Playwright/Camoufox. Repo `C:\Users\luism\OneDrive\Escritorio\BrowserWEB`, rama `main` (último commit `3db170d`), suite de 106 tests en verde.
- **Affected area**:
  - `engines/camoufox.js` (320 líneas): motor. `launch()` (líneas 212-241) arma las opciones de Camoufox (`headless`, `humanize:false`, `os`, `locale`, `proxy`, `geoip`). `openPage()` (243-315) crea el contexto, envuelve la página, registra errores de consola y peticiones fallidas, lleva el registro de peticiones en vuelo (`inFlight` → `page.pendingRequests()`), sigue pestañas del mismo sitio (271-300) y puede bloquear redes de ads (302-311).
  - `engines/camoufox.js:55-110` (`createFrameSession`): puente CDP-compatible. `start()` pide frames a `page.screencast.start({onFrame, size, quality})` con `size` = tamaño CSS real de la página; si `page.screencast` no existe, cae a un sondeo de `page.screenshot()` cada 200 ms (`FALLBACK_POLL_MS`).
  - `engines/camoufox.js:173-190` (`diagnosePage`): devuelve `readyState`, `title`, `textLength`, `spinnerish` y `pending` (peticiones que nunca resolvieron).
  - `server.js` (276 líneas): `navigateToUrl()` (líneas 99-125) navega con `waitUntil:'domcontentloaded'`, `timeout:45000`; al terminar llama `diagnosePage()` y devuelve `{success, message, status, diagnosis}` (líneas 109-114). `clickAt()`/`typeText()`/`pressKey()` (líneas 128-175) implementan el input humanizado.
  - `sessions.js` (139 líneas): `adoptPage()` (32-45) adopta una pestaña nueva del mismo sitio (cambia `section.page`, `controller.setPage`, y evita que el cierre de la página reemplazada tumbe la sección). `open()` (46-66) es el camino normal de creación.
  - `screencast.js` (253 líneas): controlador de frames por CDP (`addViewer`, `setPage`, `setUnavailable`, `close`) con acuse de frames y cierre 4404.
  - `public/script.js` (723 líneas): `showDiagnosis()` (112-134) pinta el motivo en el panel; `navigate()` (136-150) lo invoca con la respuesta; `onScreenshotUpdate()` (437-490) cambia `preview.src` por cada frame; el campo de URL solo se escribe en `activateSession`/`navigate` (línea 360).
  - `Dockerfile` (82 líneas): `node:22-bookworm-slim`, librerías de runtime de Firefox, usuario no-root `pyrock`, `npx camoufox-js fetch` en build, `ENV NODE_ENV=production CAMOUFOX_HEADLESS=virtual`.
  - **Tests**: `test/camoufox-engine.test.js` (20), `test/sessions-popup.test.js` (1), `test/sessions.test.js`, `test/sessions.integration.test.js`, `test/preview.integration.test.js`, fixtures en `test/fixtures/fake-camoufox.js` y `test/helpers/client-harness.js`.
- **Existing patterns**: adaptadores de motor con seam de prueba por variable de entorno (`PYROCK_CAMOUFOX_MODULE`), dobles de `camoufox-js` en `test/fixtures/`, y diagnóstico de página → log del servidor → panel del cliente (`diagnosis` en la respuesta de `navigate`).
- **Constraints**: sin login de browser.lol (prueba gratuita); solo ver el video (sin reenviar input al remoto); el binario de Camoufox y `camoufox-js fetch` siguen sin verificarse localmente; la imagen ya se construyó y corrió en el servidor; el proxy queda fuera de esta prueba (el usuario lo pidió explícitamente); la UI no debe cambiar de layout (solo texto de estado).

### Huecos concretos hallados en la exploración (Phase 1)

1. **El campo de URL queda desactualizado**: `public/script.js:360` solo escribe la URL al activar o navegar; cuando la sección adopta la pestaña de sesión, el campo sigue con la URL vieja (en la captura del usuario quedó vacío).
2. **No se dice con qué mecanismo corre el preview**: `createFrameSession` elige `page.screencast` o el sondeo de 200 ms, y el operador no lo sabe. Si Camoufox no expone `page.screencast`, el preview va a 5 fps y parece "lento" sin explicación.
3. **El aviso de página en blanco es de una sola vez**: se calcula al terminar `navigate`; si la app sigue arrancando, el aviso queda viejo y no se actualiza.
4. **"Navegación exitosa" no significa "página visible"**: con `waitUntil:'domcontentloaded'` la navegación resuelve cuando el HTML está listo, aunque la app tarde minutos en hidratar; el preview queda en blanco sin explicación.
5. **El estado ICE del stream remoto es invisible**: el `<video>` de browser.lol recibe un stream (WebRTC/MSE); si el stream no negocia desde el contenedor, el video no aparece y hoy no hay ninguna señal de por qué.
6. **El códec del build de Camoufox en la imagen no está verificado**: el Firefox de Playwright sí decodifica H.264 (`canPlayType` "probably"), pero Debian slim no trae ffmpeg y el build de Camoufox es otro.

## Proposed Changes

### File 1 — `server.js`

- **What**: que la navegación espere a que la página *se vea*, no solo a que llegue el HTML, y que la respuesta describa el estado real.
- **Why**: hoy `navigateToUrl` (línea 102) resuelve en `domcontentloaded` y devuelve "Navegación exitosa" con el preview en blanco; el operador no tiene forma de saber si la app sigue arrancando (hueco 4).
- **How**:
  - Después del `goto`, esperar hasta `PYROCK_SETTLE_TIMEOUT_MS` (por defecto 20000) a que `diagnosePage` reporte `readyState === 'complete'` y `textLength > 0`; si se agota el tiempo, devolver `success: true` **con** `diagnosis` (no con un error) y un `settled: false`.
  - Añadir `previewMode` al estado de la sección: `'screencast'` o `'poll'`, informado por el motor (hueco 2).
  - Reusar `diagnosePage` (ya existe) como la única fuente de verdad; no duplicar lógica de "está cargando" en el cliente.

### File 2 — `engines/camoufox.js`

- **What**: exponer el modo de preview y la URL viva de la página, y reportar el modo por log una vez por página.
- **Why**: sin esto el operador no puede distinguir "preview por screencast" de "preview por sondeo" (hueco 2), y el cliente no puede mostrar la URL de la pestaña adoptada (hueco 1).
- **How**:
  - En `createFrameSession.start()` registrar en un flag local qué camino se tomó y devolverlo; `wrapPage` expone `page.previewMode()`.
  - Añadir `page.currentUrl()` (delegando en `page.url()`), y `page.pendingRequests()` ya existe.
  - Registrar una vez por página: `preview por screencast` o `preview por sondeo (200 ms)`.

### File 3 — `sessions.js`

- **What**: que la adopción de una pestaña notifique el cambio a la vista (URL nueva) y que `publicSession` exponga la URL viva y el modo de preview.
- **Why**: el cliente necesita la URL de la pestaña que quedó activa (hueco 1); hoy `publicSession` (línea 17) ya expone `url`, pero el cliente no lo vuelve a leer.
- **How**:
  - `publicSession` sigue exponiendo `url`; añadir `previewMode`.
  - `adoptPage()` (línea 32) deja el `state` en `ready` (ya lo hace) y no requiere más cambios de estado; el cambio de URL lo ve el cliente al refrescar la lista.

### File 4 — `public/script.js` + `public/index.html` + `public/styles.css`

- **What**: que el panel refleje la URL real de la sección activa y que el aviso de "cargando" se actualice solo mientras la página sigue arrancando.
- **Why**: el campo de URL vacío y el aviso viejo hacen que el problema parezca del preview cuando en realidad es de la página (huecos 1 y 3).
- **How**:
  - Refrescar la lista de sesiones cada 3 s (intervalo existente no hay: hoy solo se refresca por acción) y, para la sección activa, escribir su `url` en el campo de URL solo si cambió (no pisar lo que el usuario está tipeando).
  - `showDiagnosis()` (línea 112) se vuelve refrescable: si la respuesta trae `settled: false`, mostrar el estado y reintentar la consulta cada 2 s hasta 60 s.
  - Mostrar una línea de estado cuando la sección adoptó otra pestaña: "Se siguió una pestaña nueva: <host>".
  - `index.html`: reutilizar `#previewHint` (ya existe) para el estado de carga; sin markup nuevo salvo un `<span>` de modo de preview en el encabezado del monitor.

### File 5 — `test/` (cobertura de lo anterior)

- **What**: tests que fijen el comportamiento nuevo.
- **Why**: los cambios de settling, modo de preview y URL adoptada no pueden quedar solo verificados a mano en un servidor remoto.
- **How**:
  - `test/camoufox-engine.test.js`: el modo de preview se reporta (`screencast` cuando la página lo expone, `poll` cuando no) y `page.currentUrl()` devuelve la URL.
  - `test/sessions-popup.test.js`: tras adoptar una pestaña, `GET /api/sessions` expone la URL de la pestaña nueva y el `previewMode`.
  - `test/sessions.test.js`: la navegación devuelve `diagnosis` y `settled` en la respuesta de `POST /api/navigate`.

## Assumptions & Decisions

- **Sin login**: la prueba gratuita de browser.lol crea sesión sin cuenta; el flujo es *crear sesión → la pestaña de share se abre → PyRock la sigue*. No se implementa manejo de tokens ni API key.
- **Solo ver**: los clics del panel caen sobre el `<video>`; no se reenvía input al navegador remoto. Queda fuera de alcance.
- **Sin proxy en esta prueba**: el usuario pidió la prueba sin proxy; `PYROCK_PROXY` queda documentado pero no se usa para esta validación.
- **El preview muestra el video sin código nuevo**: verificado en el pipeline real (Playwright + `page.screencast`): un `<video>` reproduciendo generó 119 frames, 108 distintos. El plan no toca la captura, solo la observabilidad.
- **La imagen ya construye y corre**: se asume que `docker build` funciona (el usuario ya lo ejecutó); el plan no cambia el `Dockerfile` salvo que la verificación lo justifique (ver contingencias).
- **Sin refactor del motor**: la arquitectura Camoufox + `screencast.js` no se toca; el cambio es de *estado y observabilidad*.
- **Idioma del plan y de los textos**: español (último input del usuario).

## Verification

- [ ] Command(s) to run: `npm test` (debe quedar en verde con los tests nuevos) y `node --check server.js && node --check engines/camoufox.js`
- [ ] Manual UI / API check: en la instancia desplegada, sin `PYROCK_PROXY` → sección nueva → `https://browser.lol` → elegir Chrome → URL de destino → "Iniciar sesión" → **la pestaña de sesión se sigue** (el panel lo dice) → **el preview muestra el navegador remoto como video** → el campo de URL muestra la URL de la sesión.
- [ ] Manual UI / API check: `docker compose logs -f` debe mostrar `preview por screencast` (o `por sondeo`) y la línea `Estado de la página: {...}` con `pending` cuando algo no resuelve.
- [ ] Test(s) added or updated: `test/camoufox-engine.test.js`, `test/sessions-popup.test.js`, `test/sessions.test.js`
- [ ] Lint / type check: `node --check` sobre los JS tocados (el proyecto no tiene linter de JS configurado más allá de lo que corre el editor).
- [ ] Acceptance criteria: (1) el `<video>` del navegador remoto se ve en el preview; (2) el campo de URL refleja la pestaña activa real; (3) si el video no aparece, el panel dice por qué (petición pendiente / códec / stream) en vez de mostrar un blanco mudo.

### Contingencias (si el video sigue sin verse, en este orden)

1. **Stream sin negociar**: medir el estado ICE desde la página del visor (`pc.getStats()` → `iceConnectionState`), y confirmar que el contenedor tiene salida UDP. Si falla, la sesión se crea vía la API de browser.lol (fuera de alcance) o se usa un relay TCP.
2. **Códec ausente en el build de Camoufox**: agregar las librerías de ffmpeg a la imagen (`libavcodec`/`libavformat`/`libavutil`/`libswresample`/`libswscale`) y reconstruir. Solo si el paso 1 está limpio.
3. **Preview a 5 fps**: si el log dice `preview por sondeo`, el build de Camoufox no expone `page.screencast`; medir si el stream de browser.lol se ve a esa tasa o evaluar un muestreo más fino.

## Out of Scope

- Enviar clics/teclado al navegador remoto de browser.lol.
- Proveedor de browser.lol de primera clase vía su API v7 (`POST /v7/vm/create`, `GET /v7/vm/data`, `POST /v7/vm/remove`).
- Login, API key ni cualquier manejo de credenciales de browser.lol.
- Proxy en esta prueba (la configuración sticky por puerto 10000-20000 ya quedó documentada en el README).
- Reemplazar el motor Camoufox o revertir a Chromium.
