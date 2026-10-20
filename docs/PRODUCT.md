# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Un único operador experto (el dueño del proyecto) trabaja en escritorio, sesiones largas de horas, controlando varias secciones de navegador automatizado a la vez. No hay audiencia secundaria.

## Product Purpose

PyRock es un panel de control local para operar secciones de navegador aisladas (Chromium headless vía Puppeteer/CDP): previsualización en vivo de la sección activa, navegación, control directo de mouse y teclado, ejecución de scripts y logs. El éxito es operar varias secciones aisladas (cookies/propios por sección) con confianza y sin salir del panel.

## Positioning

Cabina de operación local: control directo a nivel de sección con aislamiento real de contexto (cada sección es un BrowserContext propio), algo que un panel genérico de automatización no ofrece.

## Operating Context

- Interfaz en español, servida en localhost junto al proceso Node que controla el navegador.
- Sesiones prolongadas de escritorio: el panel está abierto durante horas; la comodidad visual sostenida importa más que el impacto inicial.
- El operador alterna entre vigilar la vista previa y actuar sobre controles; la preview es el centro de atención constante.

## Capabilities and Constraints

- Sidebar de secciones: crear, cambiar, cerrar (sin tope de secciones; `MAX_SESSIONS` lo fija si se quiere un límite), con confirmación en dos clics.
- Preview en vivo CDP con clic directo en coordenadas; controles de teclado (flechas, escribir, Enter, Tab, Escape); reinicio de sección; logs y scripts por sección en panels laterales derechos.
- Sin autenticación, sin usuarios: es una herramienta personal en localhost.
- Compatibilidad: las llamadas REST sin `session` van a la sección default; no romper ese contrato.

## Brand Commitments

Ninguno confirmado: el usuario otorgó libertad total (nombre e identidad visual actuales no son sagrados).

## Evidence on Hand

- README.md con la API y el flujo de secciones; suite de pruebas 74/74; capturas verificadas en `.pi/verification/` (1400px y 1920px).

## Product Principles

1. El operador experto primero: densidad útil, sin explicaciones de relleno.
2. El estado real siempre visible: conexión, sección activa, última actualización nunca se adivinan.
3. Cómodo durante horas: jerarquía clara y bajo cansancio visual en sesiones largas.
4. La preview manda: todo lo demás sirve al foco en la vista previa activa.

## Accessibility & Inclusion

Contraste suficiente para uso prolongado; estados de foco visibles para operación intensiva de teclado.
