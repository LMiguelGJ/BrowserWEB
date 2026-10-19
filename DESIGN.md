---
name: PyRock
description: Cabina master-control para operar secciones de navegador automatizado
colors:
  console-deep: "#0e0f11"
  console-panel: "#141518"
  console-raised: "#1e2024"
  console-line: "#2a2d33"
  ink-hi: "#f2f3f5"
  ink-mid: "#9aa0a8"
  ink-low: "#8a9099"
  tally-red: "#e5484d"
  action-blue: "#2563eb"
  action-blue-deep: "#1d4ed8"
  danger-red: "#c5323b"
  warn-amber: "#d9a406"
  ok-green: "#3d9a50"
  ink-on-accent: "#ffffff"
  warn-on-accent: "#1d1b16"
  text-error: "#f1a1a4"
  text-success: "#8fc99a"
  action-blue-tint: "rgba(37, 99, 235, 0.12)"
typography:
  display:
    fontFamily: "Barlow, 'Segoe UI', system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.01em"
  heading:
    fontFamily: "Barlow, 'Segoe UI', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.14em"
  body:
    fontFamily: "Barlow, 'Segoe UI', system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  body-sm:
    fontFamily: "Barlow, 'Segoe UI', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
  caption:
    fontFamily: "Barlow, 'Segoe UI', system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  micro:
    fontFamily: "Barlow, 'Segoe UI', system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: "normal"
  data:
    fontFamily: "'JetBrains Mono', Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "0.02em"
  data-sm:
    fontFamily: "'JetBrains Mono', Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "0.02em"
rounded:
  sm: "6px"
  md: "10px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "14px"
  lg: "20px"
  xl: "28px"
components:
  button-primary:
    backgroundColor: "{colors.action-blue}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    height: "38px"
  tally-source-active:
    backgroundColor: "{colors.console-raised}"
    textColor: "{colors.ink-hi}"
    rounded: "{rounded.md}"
---
# PyRock — Design System

## Overview

Mundo visual: **master control de broadcast**. El panel es una consola de conmutación de video: cada sección de navegador es una fuente con tally, la vista previa es el monitor de programa, y los controles viven en un rack a la derecha. Todo se decide desde la escena: un solo operador experto, sesiones de horas en escritorio → consola oscura, contraste cómodo, cero cromía decorativa. La cromía existe solo con trabajo: tally rojo = al aire, azul = acción primaria, ámbar = advertencia, verde = OK.

## Colors

- Fondo de consola en tres planos: `console-deep` (gaps, tras el monitor), `console-panel` (superficies), `console-raised` (elementos interactivos).
- `console-line` separa rack units; jamás un glow decorativo.
- Texto: `ink-hi` para datos y títulos, `ink-mid` para etiquetas, `ink-low` solo para estados apagados.
- Semánticos: `tally-red` (sección al aire / en vivo), `action-blue` (acción primaria), `danger-red` (destructivo), `warn-amber` ( Enter/Tab/Escape: llaves que actúan), `ok-green` (conectado/éxito).

## Typography

- **Barlow** (UI y display): voz industrial de consola; headings en 600 con tracking amplio en mayúsculas.
- **JetBrains Mono** (datos): todo lo que se mide — uptime, reloj, coordenadas, frames, logs, badges — va en mono con `font-variant-numeric: tabular-nums`.
- Prohibido: emoji o glifos Unicode como sistema de íconos; los íconos son SVG de trazo uniforme.

## Layout

- Grid de consola: barra superior fija (56–60px), riel de fuentes a la izquierda (280px), monitor de programa al centro, rack de controles a la derecha (340px), deck de conmutación abajo.
- La preview es dueña absoluta del alto disponible: ningún módulo le roba viewport. Sin esquinas de safe-area: el usuario las rechazó.
- Responsive: bajo 1100px el rack pasa abajo del monitor; bajo 760px el riel de fuentes colapsa a fila horizontal.

## Elevation & Depth

- Sin sombras difusas de tarjeta; la jerarquía la dan los tres planos de fondo y las hairlines.
- Solo el tally activo proyecta luz (`box-shadow` suave del propio `tally-red`): es una luz funcional de la sala, no decoración.

## Shapes

- Radios bajos (6–10px): equipamiento, no juguete.
- Sin marcas de esquina ni ornamentos dentro del monitor: el usuario las rechazó explícitamente; el marco limpio es parte del mundo.

## Components

- **Fuente (source row):** fila de rack con tally, nombre completo, uptime en mono; la activa lleva tally encendido y borde `tally-red`.
- **Monitor de programa:** fondo `console-deep`, etiqueta `PROGRAMA · <sección>` arriba, estado de carga/error centrado, sin marcas de esquina (preferencia explícita del usuario).
- **Botones:** altura 38px, `console-raised`, borde `console-line`; primario `action-blue`; destructivo `danger-red`; teclas modificadoras en ámbar.
- **Deck:** bus de estado `PVW→PGM` + pestañas de paneles (log/scripts) como llaves de router.

## Do's and Don'ts

- Don't: gradientes decorativos, glass, cards de icono+título+texto, emojis como íconos, glows cero-offset.
- Do: cada color con trabajo; datos en mono; estados por trama y luz, no por color solo.
- Do: el monitor de programa es full-bleed a propósito: el video toca sus bordes (los tests de indicador proyectan contra su rect real); no le agregues inset.
