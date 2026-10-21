# Herencia de URL y teclado al crear una sección — ODD execution

Objetivo: que una sección nueva nunca abra en `about:blank`, que el campo de Navegación muestre siempre una URL real (con autocompletado) y que herede de la sección activa lo que el operador ya tenía.
Baseline: `199c128` en `main`. Entrega: commit por unidad de trabajo, push y deploy con la API de Dokploy. Runner: `npm test`.

## Specs

S1. Petición del usuario, verbatim: «ahora cuando creo un nueva seccion no quiero volver a ver esto about:blank no quiero que inicie nunca mas con esto quiero que inicie simpre con esta pagina […] el campo empieza con este valor aunque si el nevegrador si inicia con la web https://browser.lol/».
S2. Petición del usuario, verbatim: «tambien quiero que Control de Teclado nunca empieze con ese hola de simpre».
S3. Decisión del usuario, verbatim: «cre que lo mejor es en vez de harcodear paginas porque no auto completar mejor osea si en mi seccion uno ya tengo vaores en Control de Teclado y Navegación pues pasar eso valores o url a la seccion que se acaba de abrir y navegar hacia alla en automatico». Aprobado: «super me gusta vamos a implemetar esto tal cual con odd».
S4. Punto A: la URL de arranque la tiene el servidor (`PYROCK_START_URL`, default `https://browser.lol/`) y se publica en `/api/status`; la app la usa como valor real, sin URLs inventadas en el HTML.
S5. Punto B: si la URL de la sección está vacía o es `about:blank`, el campo muestra la URL de arranque; cuando la página cargue, manda la URL real.
S6. Punto C: el campo «Control de Teclado» arranca vacío (el placeholder queda como pista).
S7. Punto D: al crear una sección se copian los valores de Navegación y Control de Teclado de la sección activa, se llenan los campos de la nueva y se navega a esa URL; la carga de fondo de la página inicial se cancela sola (gana la última navegación).
S8. Punto E: sin nada que heredar (primera sección o campo vacío) se usa la URL de arranque del servidor y el campo la muestra.
S9. Supuestos confirmados: el texto de Control de Teclado se **copia al campo** pero no se escribe solo en la página; la herencia toma los valores de la sección activa en el momento de crear.

## Tasks

T1 | S4 | A: el servidor publica `startUrl` en `/api/status` y `/api/sessions` | done (test/server-start-url.test.js)
T2 | S5 | B: el campo Navegación nunca muestra `about:blank` | done (test/section-inheritance-client.test.js)
T3 | S6 | C: el campo Control de Teclado arranca vacío; con el campo vacío no se envía nada | done
T4 | S7,S8,S9 | D: la sección nueva hereda los campos y navega (`createInheritingSection`) | done
T5 | S1-S9 | verificación (suite 214/214), documentación, commit, push y deploy | in progress

## Log

L1. Petición original del usuario, verbatim: «ahora cuando creo un nueva seccion no quiero volver a ver esto about:blank […] quiero que inicie simpre con esta pagina […] y otra cosa tambien quiero que Control de Teclado nunca empieze con ese hola de simpre […] cre que lo mejor es en vez de harcodear paginas porque no auto completar mejor osea si en mi seccion uno ya tengo vaores en Control de Teclado y Navegación pues pasar eso valores o url a la seccion que se acaba de abrir y navegar hacia alla en automatico».
L2. Causa real de lo que se veía, leída del código: `public/script.js:662` llena el campo con `section.url || ''`, y al recién crearse la sección esa URL **es** `about:blank` (la página todavía no cargó). El HTML además traía un valor fijo `value="https://example.com/"` (`public/index.html:63`) que no es una URL real y por eso no autocompletaba nada, y `value="hola"` en el campo de teclado (`public/index.html:82`), que no era un placeholder sino un valor por defecto que se mandaba junto con lo que el operador escribía.
