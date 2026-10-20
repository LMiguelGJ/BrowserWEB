# Plan: Pool gratuito amplio — muchas IP distintas listas para usar

> Creado por la skill `plan-mode-trae` — Plan Mode de Trae IDE, adaptado a Pi.
> Ruta: `.pi/plans/pool-gratis-amplio.md` · Idioma: español · Creado: 2026-10-20

## Summary

Relajar los filtros de calidad del pool de `proxy-scraper` y dejar que la app consuma también proxies SOCKS (siempre con TLS verificado) para multiplicar el número de salidas públicas distintas y utilizables, y mostrar en el panel Red el tamaño real del inventario del pool.

## Current State Analysis

> Todo lo de abajo sale de la exploración de Fase 1 (lectura de archivos del repo y del log real del contenedor desplegado).

- **Project**: PyRock — Node 22 + Express, motor Camoufox/Firefox controlado con Playwright. Una sola imagen Docker (`Dockerfile`) donde Supervisor (`ops/supervisord.conf`) levanta dos procesos: `proxy-scraper` (pool) y `server.js` (PyRock). El pool se sirve en `127.0.0.1:8899` con autenticación Basic (`PROXY_SCRAPER_SERVE_PASSWORD`).
- **Affected area**:
  - `ops/supervisord.conf:10` — flags actuales del pool: `--recheck live --want 200 --serve --serve-host 127.0.0.1 --serve-refill 6 --no-datacenter --no-blocklisted`.
  - `src/network/proxy-pool.js:8` — `POP_PATH = '/pop?protocol=http&https=1'`.
  - `src/network/proxy-pool.js:15` — `parseCandidate` rechaza todo lo que no sea `http:` (`reject('not_http')`), y rechaza URL con credenciales y host no público.
  - `src/network/assigner.js` — busca salida gratuita, mide la IP de salida real en el navegador (`src/network-ip.js`) y reserva la IP para que ninguna otra sección la use (`src/network/reservations.js`).
  - `src/engines/camoufox.js:358` — el proxy asignado a la sección se pasa tal cual a `browser.newContext({ proxy })`; Playwright acepta esquemas `http://`, `socks4://` y `socks5://`.
  - `src/network/manager.js` — estado por sección (proveedor, IP, motivo) y `summary()` con `pool: { status, reason, at }`.
  - `public/script.js` — render del panel Red (`renderNetwork`).
- **Existing patterns**: ODD con seguimiento en `odd/tasks/`, commits por unidad de trabajo, test-first (RED→GREEN) con `node --test`, cliente del pool como wrapper fino de la API de `proxy-scraper` (`/pop`, `/report`), medición en navegador como última palabra, y reglas ya fijadas: una IP pública distinta por sección, nunca conexión directa, recuperación acotada sin reproducir acciones.
- **Constraints**: TLS obligatorio para poder visitar sitios `https://` (browser.lol lo es); el pool solo escucha en loopback; nunca exponer credenciales en el estado visible; sin fallback a conexión directa; la búsqueda gratuita tiene plazo (`PYROCK_FREE_SEARCH_TIMEOUT_MS`, 60 s por defecto) y DataImpulse actúa de respaldo.

### Números reales (del log del contenedor desplegado, corrida 17:39)

| Etapa | Cantidad |
|---|---|
| Lista viva re-chequeada (`--recheck live`) | 1.148 |
| Funcionan desde la red del servidor | 548 (47,7 %) |
| **Descartados por `--no-datacenter`** | 321 (58,6 %) |
| **Descartados por `--no-blocklisted`** | 189 (34,5 %) |
| Quedan con los filtros actuales | **163** |
| **De esos, los que tunelizan HTTPS con TLS verificado** | **41 (7,5 %)** ← el pool utilizable |
| Reparto de los 548 que funcionan | http 151 · socks4 43 · **socks5 354** |
| Objetivo de la corrida actual (`--want 200`) | alcanzado 163/200 — el límite no fue el goal, fue el filtro |

**Diagnóstico**: el app pide solo `protocol=http`, así que de 548 candidatos que funcionan solo puede tomar los 151 HTTP; y de esos, únicamente los que pasan `https=1`. Relajar `protocol=http` en la petición conserva la garantía de TLS y multiplica por ~3,6 los candidatos elegibles.

### Endpoints del pool que confirman el diseño (documentación del propio proyecto)

- `/pop` — como `/get`, pero **el proxy sale del pool** (por eso hace falta `--serve-refill`).
- `/count` — «totals by type and country» → sirve para mostrar el inventario real en el panel.
- `/all?protocol=socks5&limit=20` — los mejores SOCKS5 disponibles.
- Los filtros `country`, `protocol`, `https=1`, `anonymity`, `max_latency` funcionan en `/get`, `/pop` y `/all`.
- La API y la página de estado piden la contraseña en Basic auth.

## Proposed Changes

### Archivo 1 — `ops/supervisord.conf`

- **What**: cambiar la línea `command=` del programa `proxy-scraper`.
- **Why**: los dos filtros de calidad se llevan el 93 % de los candidatos que funcionan (`--no-datacenter` 321 y `--no-blocklisted` 189 de 548), y `--recheck live` limita el examen a la lista viva de 1.148 en vez de las ~726 fuentes que el propio scraper indexa. Además, el objetivo de 200 y el timeout de 8 s dejan fuera proxies de 5-7 s de latencia que sí funcionan.
- **How**: una sola línea, sin tocar el resto (loopback, Basic Auth, `PROXY_SCRAPER_HOME`, prioridades, `stopasgroup`/`killasgroup`):

```
command=/app/.venv/bin/proxy-scraper --want 1000 -t 12 --serve --serve-host 127.0.0.1 --serve-refill 1
```

  Cambios puntuales: se quitan `--recheck live`, `--no-datacenter`, `--no-blocklisted`; `--want 200` → `--want 1000`; se agrega `-t 12` (timeout por proxy, default 8 s); `--serve-refill 6` → `--serve-refill 1` (repuesto horario en vez de cada 6 h). Se conservan `--serve --serve-host 127.0.0.1` y la contraseña por Basic auth.

  Consecuencia asumida: el arranque en frío pasa de ~28 s a una corrida completa de fuentes (minutos). El repuesto horario sigue alimentando el pool desde la lista viva.

### Archivo 2 — `src/network/proxy-pool.js`

- **What**: (a) pedir los candidatos en dos fases, HTTP primero y SOCKS después; (b) aceptar los esquemas `http:`, `socks5:` y `socks4:`; (c) agregar una lectura del inventario con `/count`.
- **Why**: hoy `POP_PATH` pide `protocol=http` y `parseCandidate` descarta lo que no sea `http:`. El pool tiene 354 SOCKS5 y 43 SOCKS4 funcionando, y `https=1` ya garantiza que tunelizan TLS. Además, `/pop` saca el proxy del pool, así que hace falta saber cuántos quedan.
- **How**:
  1. Reemplazar `POP_PATH` por una lista ordenada de peticiones:
     `['/pop?protocol=http&https=1', '/pop?protocol=socks5&https=1', '/pop?protocol=socks4&https=1']`.
     `pop()` las prueba en orden y devuelve el primer candidato válido; si la primera responde `empty` pasa a la siguiente; si todas están vacías devuelve `empty`. Un `unavailable` (pool caído) se devuelve tal cual, sin pasar a la fase siguiente.
  2. En `parseCandidate`, aceptar `http:`, `socks5:` y `socks4:`; el `server` conserva el esquema (`socks5://1.2.3.4:1080`) porque Playwright lo necesita así. Se siguen rechazando las URL con credenciales, los hosts no públicos y los puertos inválidos. Si el body trae `type`, tiene que coincidir con el esquema de la URL.
  3. Agregar `count()`: `GET /count` con la misma cabecera Basic Auth, devolviendo los totales por tipo (o `null` si el pool no responde). Se usa solo para mostrar, nunca para decidir.

### Archivo 3 — `src/network/manager.js` y `src/server.js`

- **What**: llevar el inventario del pool al estado que ya se publica (`summary().pool` y por lo tanto `/api/network` y `/health`).
- **Why**: el operador necesita ver cuántas IP hay disponibles ahora, no solo si el pool responde.
- **How**: en `createNetworkManager`, leer `/count` al crear el manager y refrescarlo cada vez que el pool responde (en el mismo camino que ya actualiza `lastPool`). Guardar `{ total, byType }` en `lastPool` y exponerlo como `pool.count`. Si la lectura falla, `count` queda en `null` y el panel omite ese dato.

### Archivo 4 — `public/script.js`

- **What**: mostrar el inventario en la fila `POOL GRATUITO`.
- **Why**: es la respuesta directa a «cuántas IP hay listas para usar».
- **How**: en `renderNetwork`, la fila pasa a `ok · 312 (http 150 · socks5 162)`, o `ok · 312` si el pool no devuelve el detalle por tipo. Con el pool caído o vacío se mantiene el texto actual (`no responde`, `vacío`). Solo modo híbrido.

### Archivo 5 — `src/engines/camoufox.js`

- **What**: **sin cambios previstos**; el proxy ya viaja verbatim a `browser.newContext({ proxy })` (`src/engines/camoufox.js:358`) y Playwright acepta `socks4://`/`socks5://`.
- **Why**: el bloqueo real no está en el motor sino en el filtro del cliente del pool (Archivo 2). Si la validación real muestra que Playwright rechaza el esquema, el arreglo es en `proxy-pool.js` (mapear el esquema), no aquí.
- **How**: la medición en el navegador (`src/network-ip.js`) ya funciona como puerta: un SOCKS que Camoufox no puede usar nunca devuelve una IP pública, así que el candidato se descarta solo, sin ensuciar el pool (gracias a que solo se reporta cuando el proxy rechaza la conexión).

### Archivo 6 — Pruebas (test-first, RED→GREEN)

- `test/network-core.test.js`: (a) el cliente pide HTTP primero y pasa a SOCKS5 cuando HTTP se agota; (b) acepta un candidato `socks5://` y conserva el esquema en `server`; (c) sigue rechazando esquemas desconocidos, URL con credenciales y hosts no públicos.
- `test/runtime-packaging.test.js`: fija los flags nuevos del pool (sin `--no-datacenter`, sin `--no-blocklisted`, sin `--recheck live`, con `--want 1000`, `-t 12` y `--serve-refill 1`) y que sigue limitedo a loopback con contraseña.
- `test/preview-state-client.test.js`: el panel muestra el inventario por tipo cuando el pool lo informa.
- `test/network-hybrid.integration.test.js` (o archivo nuevo propio): una sección obtiene una salida SOCKS5 del pool falso y la mide como IP pública distinta.

## Assumptions & Decisions

- Decisión del usuario: **relajar los dos filtros de calidad** (pool de 163 → ~548, ×3,4) aceptando más captcha en sitios con anti-bot.
- Decisión del usuario: **habilitar SOCKS4/SOCKS5 con validación real**, no a ciegas.
- **El filtro `https=1` se conserva**: sin TLS el navegador no puede abrir sitios `https://`; un proxy que no tuneliza TLS no es "IP lista para usar" para este caso de uso.
- **HTTP primero, SOCKS como surtido extra**: pedir SOCKS solo cuando el pool HTTP está vacío evita que los 397 candidatos SOCKS (muchos de ellos lentos o inservibles) consuman el plazo de 60 s antes de probar los HTTP que ya funcionaban.
- **Sin credenciales en los candidatos**: los proxies gratuitos del pool no las tienen; si un candidato trae usuario/clave se sigue descartando.
- **La IP pública distinta por sección no se toca**: cada sección conserva la suya y el pool no reparte la misma salida.
- **El respaldo DataImpulse se mantiene** como último recurso: el plan agranda el surtido gratuito, no cambia la política gratis-primero.
- **El arranque en frío del pool pasa a ser una corrida completa de fuentes (minutos)**: durante ese tiempo el app espera hasta su plazo gratuito en lugar de rendirse (comportamiento ya implementado) y, si se agota, cae a DataImpulse.
- **Más IP significa más captcha**: es reputación de la salida, no un defecto del código; con DataImpulse (residencial) el problema no aparece.

## Verification

- [ ] Pruebas enfocadas: `node --test test/network-core.test.js test/runtime-packaging.test.js test/preview-state-client.test.js test/network-hybrid.test.js test/network-request.integration.test.js`
- [ ] Suite completa: `npm test`
- [ ] Lint/diagnóstico: `node --check src/network/proxy-pool.js && node --check src/network/manager.js` y `git diff --check`
- [ ] Prueba real de SOCKS en navegador (no mock): en la instancia desplegada, con el pool ya caliente, pedir un candidato SOCKS5 (`/pop?protocol=socks5&https=1`) y comprobar que Camoufox abre una página `https://` y que `src/network-ip.js` devuelve una IP pública distinta. Si no funciona, se revierte el Archivo 2 a HTTP y el pool sigue agrandado por los flags.
- [ ] Aceptación (tras el redeploy del usuario): el log del contenedor muestra un pool con **≥ 400 hits** (antes 163) y `/api/network` trae `pool.count`; se crean **5 secciones** y las 5 muestran **IP públicas distintas** en `/api/network`; al menos una sección con salida `socks5://`.

## Out of Scope

- No se cambia la política gratis-primero, ni la regla de una IP distinta por sección, ni la prohibición de conexión directa, ni la recuperación acotada.
- No se "arregla" el anti-bot: es el historial de la IP, no el código.
- No se despliega ni se hace push: eso lo decide el usuario.
- No se agrega un botón para pedir el proveedor de pago a propósito (el pedido manual sigue siendo solo-gratuito).
- No se cambia la imagen Docker más allá de los flags del pool.
