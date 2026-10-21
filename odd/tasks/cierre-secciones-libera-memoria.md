# Cerrar una sección debe liberar su navegador — ODD execution

Objetivo: que cerrar una sección libere de verdad su contexto de navegador y que la RAM del servidor no crezca de forma monótona.
Plan aprobado: `.pi/plans/cierre-secciones-libera-memoria.md`. Baseline: `aa6994e` en `main`. Entrega: commit por unidad de trabajo, suite completa, push y deploy. Runner: `npm test`.

## Specs

S1. Petición del usuario, verbatim: «crea en plan para ocorregir esto imeditamete pues lo que pasa ahora es que me esta llenando la ram de mi server y esto esta mal».
S2. Petición del usuario, verbatim: «lo que pasa es que consume mucho […] porque aunque le doy a cerrar secion en la vista pues este nevegador aun se queda levantado consumiendo ram y ya no lo veo».
S3. Decisión del usuario, verbatim: «solo es eso, nada corrigue eso y ya». Alcance: solo liberar el navegador al cerrar una sección; **fuera** tope de RAM, reinicio automático del navegador y corte de secciones por memoria.
S4. Autorización de ejecución, verbatim: «ejecuta el plan tal cual usando odd y modo yolo».
S5. Cerrar una sección nunca traga el fallo del cierre del contexto: reintenta una vez, registra el fallo y no bloquea el cierre del panel. Un error de «target closed» no cuenta como fallo.
S6. La medición de IP abandonada se detiene de verdad: la página de sondeo se cierra esperando a que termine el trabajo, sin navegación viva.
S7. `GET /api/diagnostics` es de solo lectura y expone la RAM real del proceso Camoufox y de Node (leída de `/proc`), los contextos vivos, los fallos de cierre y los contadores de sondeos, sin credenciales.
S8. El panel Red muestra la memoria real y avisa cuando una sección no liberó su contexto.

## Tasks

T1 | S5 | `src/sessions.js`: cierre con reintento, log y registro `closeFailures` | tests primero en `test/sessions.test.js`
T2 | S6 | `src/network-ip.js`: abortar la medición abandonada y esperar al trabajo antes de cerrar la página | tests primero en `test/network-hybrid.test.js`
T3 | S7 | `src/server.js`: cierre del contexto de sondeo con reintento + contadores + `GET /api/diagnostics` | tests primero en `test/runtime-packaging.test.js` (un test de servidor por archivo)
T4 | S8 | `public/index.html` + `public/script.js`: memoria real y aviso de contexto no liberado en el panel Red | tests primero en `test/preview-client.test.js`
T5 | S1-S8 | suite completa, documentación, commit, push y deploy con verificación de RAM antes/después | —

## Log

L1. Petición original del usuario, verbatim: «crea en plan para ocorregir esto imeditamete pues lo que pasa ahora es que me esta llenando la ram de mi server y esto esta mal».
L2. Aclaración del usuario, verbatim: «lo que pasa es que consume mucho […] porque aunque le doy a cerrar secion en la vista pues este nevegador aun se queda levantado consumiendo ram y ya no lo veo», y «solo es eso, nada corrigue eso y ya».
L3. Autorización, verbatim: «ejecuta el plan tal cual usando odd y modo yolo».
L4. Evidencia de la Fase 1 (leída del código, no supuesto):
- Defecto 1, `src/sessions.js:33-35`: `try { await closeContext(section.context); } catch { /* ... */ }` descarta cualquier fallo; la sección ya salió del `Map` en `sessions.js:105`, así que un contexto vivo queda invisible. Ningún test cubre ese fallo.
- Defecto 2, `src/network-ip.js:38-50` + `src/server.js:80-86`: `measureExitIp` compite `work` contra un temporizador con `Promise.race`; al ganar el temporizador, el `finally` cierra la página con `page.goto` en vuelo y `work` sigue intentando los servicios siguientes. `probeProxy` cierra el contexto con otro `catch` vacío. Con `MAX_EXAMINED = 200` y 120 s de plazo por sección, se repite cientos de veces por hora.
- Medición: no existe `process.memoryUsage()` ni lectura de `/proc` en `src/`, `public/` ni `ops/`.
L5. Señal del usuario (imagen de Dokploy Monitoring): memoria 4.94 GiB de 7.751 GiB, subida monótona desde ~4 GB sin bajar; CPU 292%.
L6. Advertencia que se conserva durante la ejecución: si Firefox no devuelve la RSS al sistema tras `context.close()`, el número no bajará aunque el contexto muera bien. `GET /api/diagnostics` es lo que lo decide con dos lecturas; si es así, la solución real (reiniciar el proceso de Camoufox sin secciones) queda fuera del alcance pedido en S3 y seFrozenza para el usuario.