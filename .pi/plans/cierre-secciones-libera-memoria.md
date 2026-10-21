# Plan: Cerrar una sección debe liberar su navegador (RAM que no baja)

> Created by `plan-mode-trae` skill — Plan Mode of Trae IDE, adapted to Pi.
> Path: this file · Language: es · Created: 2026-10-21

## Summary

Cerrar una sección en el panel borra el registro pero puede dejar el contexto de Firefox vivo: `dispose` se traga cualquier error de `context.close()` sin log, sin reintento y sin verificación, así que el contexto queda en el navegador y el operador ya no lo ve. Además, cada sondeo de IP abre un contexto desechable que se cierra mientras la medición sigue en vuelo, y esos contextos se acumulan aunque cierres todas las secciones. Se agrega visibilidad (RSS real y conteo de contextos vivos) y se arregla el ciclo de vida de ambos cierres.

## Current State Analysis

> Filled from Phase 1 exploration. Must reference real files and patterns read.

- **Project**: PyRock — Node 22 + Express, un proceso Camoufox (Firefox) con un contexto por sección, proxy por contexto; corre en Dokploy con Supervisor (Node + `proxy-scraper`) en una imagen.
- **Affected area**: `src/sessions.js` (ciclo de vida de la sección), `src/network-ip.js` y `src/server.js` (contexto de sondeo), `src/server.js` (endpoint de diagnóstico nuevo).
- **Existing patterns**:
  - `DELETE /api/sessions/:id` (`src/server.js:609`) → `sessions.close(id)` (`src/sessions.js:100`).
  - `dispose(section)` (`src/sessions.js:28`) cierra el controlador y luego `closeContext(section.context)`; el cierre real es `context => context.close()` (`src/engines/camoufox.js:441`).
  - `onClosed` (`src/server.js:270`) cancela la recuperación y llama `network.forget(id)`, que libera la IP reservada (`src/network/manager.js:108` → `src/network/reservations.js:12`).
  - El preview en vivo está bien acotado: un frame en vuelo por espectador y `stopProducer()` cuando no quedan espectadores (`src/screencast.js:175-205`).
  - El historial de IP está acotado a 5 entradas (`src/server.js:576`).
- **Evidencia observada** (Dokploy Monitoring, imagen adjunta): memoria **4.94 GiB de 7.75 GiB** con subida monótona de ~4 GB sin bajar; CPU 292%. El panel muestra `4.94GiB` mientras el operador ya cerró secciones.
- **Defecto 1 — el cierre de sección nunca falla de forma visible** (`src/sessions.js:33-35`):
  ```js
  try { await closeContext(section.context); } catch { /* Browser shutdown may already have closed the context. */ }
  ```
  El `catch` vacío descarta cualquier fallo. La sección ya salió del `Map` en `sessions.js:105`, así que un contexto que no se cerró queda invisible para el operador ("ya no lo veo"), sin log, sin reintento y sin verificación. No existe ninguna prueba que compruebe que un fallo de cierre se reporte o se recupere.
- **Defecto 2 — el contexto de sondeo se abandona mientras la medición sigue viva** (`src/network-ip.js:38-50` + `src/server.js:80-86`):
  `measureExitIp` corre la medición como una promesa `work` y la compite con un temporizador mediante `Promise.race`. Cuando gana el temporizador, el `finally` cierra la *página* de sondeo mientras `page.goto` sigue en vuelo, y `work` **no se cancela**: sigue intentando los otros servicios de IP. `probeProxy` cierra el contexto en su `finally` con otro `catch` vacío, sobre un contexto cuya página sigue navegando; ese cierre puede fallar y el contexto sobrevive en Firefox.
  Con 7 secciones y búsquedas gratuitas de hasta 200 candidatos (`MAX_EXAMINED` en `src/network/assigner.js:5`, plazo de 120 s), esto se repite cientos de veces por hora **con independencia de cuántas secciones cierres**.
- **No hay ninguna métrica de memoria en el código**: no existe `process.memoryUsage()` ni lectura de `/proc` en `src/`, `public/` ni `ops/`. Por eso "consume mucho" no se puede acotar hoy.
- **Restricciones**: sin conexión directa (todo sale por proxy), no desactivar TLS, no exponer credenciales; `.env` no se edita desde acá; el servidor solo admite un arranque por archivo de prueba (un test de servidor por archivo); `camoufox-js` lanza Firefox, así que el PID del navegador no está exposed y hay que leerlo de `/proc` (Debian: el contenedor tiene `/proc`).

## Proposed Changes

### File 1 — `src/sessions.js`
- **What**: que `dispose` nunca trague el error de cierre: registrar el fallo, reintentar una vez y dejar el error registrado en un contador consultable.
- **Why**: es la causa directa de "cerré la sección y el navegador sigue levantado". Hoy el `catch` vacío (`src/sessions.js:34`) hace que un cierre fallido sea indistinguible de uno exitoso.
- **How**:
  1. Extraer el cierre a `async function closeSectionContext(section)` con esta forma exacta:
     ```js
     async function closeSectionContext(section) {
         const context = section.context;
         if (!context) return { closed: true, attempts: 0 };
         for (let attempt = 1; attempt <= 2; attempt++) {
             try { await closeContext(context); section.context = null; return { closed: true, attempts: attempt }; }
             catch (error) {
                 // Un contexto ya cerrado por el navegador lanza al cerrarlo de nuevo: no es un fallo.
                 if (/closed|detached|target closed|has been closed/i.test(error?.message || '')) {
                     section.context = null; return { closed: true, attempts: attempt, alreadyClosed: true };
                 }
                 if (attempt === 2) { recordCloseFailure(section.id, error); return { closed: false, attempts: attempt, error: error.message }; }
             }
         }
     }
     ```
  2. `recordCloseFailure(id, error)` acumula en un `Map` acotado (`closeFailures`, máximo 50 entradas; la más antigua se descarta cuando se supera el tope) y **loguea una línea** `WARN: no se pudo cerrar el contexto de la sección <id>: <mensaje>`.
  3. El logger se toma del que ya recibe el servidor; si no hay ninguno, se usa `console.warn` (Supervisor ya captura la salida de consola).
  4. `dispose` llama a `closeSectionContext` y **no** re-lanza: `close()` ya devolvió éxito para el operador; el detalle va al log y al endpoint de diagnóstico. La última sección sigue protegida por el 409 existente (`src/sessions.js:104`).
  5. Exponer `closeFailures()` en el retorno del gestor para que el diagnóstico los lea.

### File 2 — `src/network-ip.js`
- **What**: que la medición abandonada se detenga de verdad y que la página de sondeo se cierre esperando a que el trabajo termine.
- **Why**: hoy el `Promise.race` abandona `work` (`src/network-ip.js:38-50`) y el cierre posterior compite con un `goto` en vuelo; el contexto sobrevive en Firefox (defecto 2).
- **How**:
  1. Añadir un `abort` explícito: `const controller = new AbortController()` y pasar `signal: controller.signal` a cada `page.goto`; en el `finally`, llamar `controller.abort()` antes de cerrar la página, para que el `goto` en vuelo termine en `AbortError` en vez de seguir.
  2. En el `finally`, **esperar al trabajo antes de cerrar**: `await work.catch(() => {})` y recién después `await probe.close()`. El `expired = true` actual ya impide que el bucle siga con el siguiente servicio; con `abort` + `await work` no queda ninguna navegación viva.
  3. Dejar el mensaje de timeout igual (`IP measurement timed out`) para no cambiar el contrato que consumen `assigner` y `server`.

### File 3 — `src/server.js`
- **What**: (a) que `probeProxy` no se trague el fallo de cierre del contexto de sondeo, con el mismo reintento-una-vez y log; (b) un endpoint de diagnóstico de solo lectura.
- **Why**: (a) repite el `catch` vacío del defecto 1 (`src/server.js:84`) en la ruta más caliente; (b) sin números no se puede probar el arreglo ni saber cuál de los dos defectos domina.
- **How**:
  1. `probeProxy` reutiliza un helper `closeContextOnce(context, etiqueta)` con la misma lógica de reintento+log del punto 1, para no duplicar el código.
  2. Nuevo `GET /api/diagnostics` (solo lectura, sin credenciales, sin datos sensibles) con:
     - `node: { rss, heapUsed, external }` de `process.memoryUsage()`;
     - `processes`: recorrer `/proc/*/stat`, quedarse con los hijos del PID de Node (campo 4 = ppid) y leer `VmRSS` de `/proc/<pid>/status`; clasificar cada hijo como `camoufox` (el que tiene `firefox`/`camoufox` en `/proc/<pid>/cmdline`) o `proxy-scraper`;
     - `sections`: `{ total, contexts: <contextos vivos contados por el gestor>, closeFailures: sessions.closeFailures() }`;
     - `probes`: `{ created, closed, failed }` contadores que incrementa `probeProxy`.
     Si `/proc` no existe (entorno local), `processes` va como `null` y el resto del payload sigue siendo válido.

### File 4 — `public/index.html` + `public/script.js`
- **What**: mostrar en el panel Red, junto al estado de las secciones, la memoria real del navegador y del proceso Node, y un aviso cuando una sección no pudo liberar su contexto.
- **Why**: el operador necesita ver que cerrar una sección libera memoria; hoy el fallo es invisible.
- **How**:
  1. `renderNetwork`/panel: una línea con `Camoufox <rss> · Node <rss>` leída de `/api/diagnostics` cada 10 s solo mientras el panel está abierto (reutilizar el `setInterval` que ya usa el panel; nada de polling con el panel cerrado).
  2. Si `closeFailures` trae entradas, una línea de aviso `No se liberó el contexto de <sección>` con el mensaje, en el mismo lugar donde hoy se muestran los motivos de `fallback_failed`.
  3. Un test del harness de cliente que cubra ambas líneas.

### File 5 — `test/sessions.test.js`, `test/network-hybrid.test.js`, `test/screencast.test.js`, `test/preview-client.test.js`
- **What**: pruebas RED→GREEN de cada punto.
- **Why**: hoy ningún test cubre un fallo de cierre de contexto ni el abandono de una medición.
- **How**: casos mínimos y deterministas:
  1. `close()` con `closeContext` que falla una vez y después funciona → la sección se cierra, se reintenta una vez y no queda registrada como fallo.
  2. `close()` con `closeContext` que siempre falla → la sección se cierra igual (el cierre del panel no se bloquea), queda un fallo registrado y un log.
  3. Un error de "target closed" **no** cuenta como fallo.
  4. `measureExitIp` con un servicio que nunca responde → no queda ninguna página de sondeo abierta y el trabajo termina (no sigue intentando el segundo servicio).
  5. `probeProxy` con `context.close()` que falla → reintenta una vez y lo deja registrado en los contadores de diagnóstico.
  6. `GET /api/diagnostics` devuelve el shape esperado (con `/proc` simulado) sin exponer ninguna credencial.

## Assumptions & Decisions

- **Alcance pedido por el usuario**: solo corregir que cerrar una sección libere el navegador. **No** se implementa tope de RAM, ni reinicio automático del navegador, ni corte de secciones por memoria: el usuario dijo explícitamente "solo es eso, nada, corrigue eso y ya".
- **No bloquear el cierre por memoria**: si un contexto se resiste, la sección se cierra igual y el fallo queda registrado y visible. Cerrar desde el panel nunca va a devolver un error al operador por esto.
- **Sin tocar credenciales ni `.env`**: el diagnóstico expone IPs propias y nombres de proceso, nunca usuarios, contraseñas ni cabeceras de proxy.
- **La fuente de verdad de la RAM es el RSS del proceso Camoufox**, leído de `/proc`, no `process.memoryUsage()` de Node (Node no incluye al hijo). Se reportan ambos.
- **No se elimina el sondeo en navegador**: es lo que permite medir la salida real y soporta SOCKS sin dependencias nuevas (`package.json` no trae un agente SOCKS). Se arregla su cierre, no se lo cambia.
- **Dos defectos, un solo arreglo**: el defecto 1 explica "cerré y sigue vivo"; el defecto 2 explica que la memoria suba aunque no cierres nada. El endpoint de diagnóstico existe para decidir con números cuál domina, no para agregar funcionalidad.

## Verification

- [ ] Command(s) to run: `node --test test/sessions.test.js test/network-hybrid.test.js` (RED antes del cambio, GREEN después) y `npm test` para la suite completa.
- [ ] Test(s) added or updated: `test/sessions.test.js`, `test/network-hybrid.test.js`, `test/preview-client.test.js` (líneas de memoria y de aviso).
- [ ] Lint / type check: `npx eslint src test` si el repo lo corre en `package.json`; si no, la suite completa es el chequeo (el repo no tiene lint configurado).
- [ ] Manual UI / API check (en producción, después del deploy):
  1. `GET /api/diagnostics` → ver `processes` con el RSS de Camoufox.
  2. Crear 4 secciones, esperar a que las 4 estén `connected` en `/api/network`, anotar el RSS.
  3. Cerrar 3 secciones desde el panel y esperar 30 s.
  4. `GET /api/diagnostics` otra vez: el RSS de Camoufox debe **bajar** de forma clara y `sections.contexts` debe ser 1.
  5. Repetir el ciclo 3 veces: el RSS no debe crecer de forma monótona.
- [ ] Acceptance criteria:
  - Cerrar una sección nunca deja un contexto vivo en el navegador, o deja un fallo registrado y visible en el panel.
  - El RSS de Camoufox baja al cerrar secciones (verificado con dos lecturas de `/api/diagnostics`).
  - La suite completa pasa; el diagnóstico no expone credenciales.

## Out of Scope

- Tope de RAM, reinicio automático del navegador o corte de secciones por memoria (decisión del usuario: fuera de alcance).
- Cambiar el sondeo de IP a HTTP directo sin navegador (imposible sin un agente SOCKS en `package.json`).
- Reemplazar el historial de IP por sección o los logs: ya están acotados.
- Cualquier cambio en Dokploy (límites del contenedor, resources): hoy la app no define ninguno y no hace falta tocarlo.