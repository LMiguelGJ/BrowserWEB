# Plan: Browser sections with a left sidebar

> Created by `plan-mode-trae`. Planning only; implementation requires explicit approval.
> Path: `.pi/plans/secciones-de-navegador.md` · Artifact language: English (user-facing UI copy stays Spanish, as in the current app).

## Summary

Replace the single shared browser page with several independent **sections**. Each section is an isolated Chromium context with its own page and cookies. A new left sidebar lists them, adds new ones, switches between them and closes them. Preview, mouse, keyboard, navigation and scripts act on the active section. Existing session-less API calls keep working.

## Current State Analysis

- `server.js` holds one global `browser`, one global `page`, one `previewController`, one `lastScreenshot` and one `lastAction` (top of file). `initBrowserOnce()` closes and relaunches the whole browser, builds one page (viewport 1366x768, UA/header overrides, `evaluateOnNewDocument`) and wires `disconnected`/`close` to the controller. `initBrowser()` serializes every browser change through `initQueue` and honors `shuttingDown`.
- Every action helper (`navigateToUrl`, `takeScreenshot`, `clickAt`, `typeText`, `pressKey`) reads the global `page`. `navigateToUrl` restarts the whole browser on `Target closed` / `Protocol error`. The REST routes take no section identifier. `stopServer()` closes the controller, WebSocket clients, awaits `initQueue`, then closes the browser. `startServer()` launches the browser before listening.
- The preview WebSocket is `/ws/preview` with a same-host Origin guard (`previewUpgradeAllowed`); every viewer attaches to the single controller. `screencast.js` is already per-page by construction (`createScreencastController({ getPage })`), so one controller per section needs no change to it.
- `public/PyRockHTTP.js` builds the preview URL in `previewUrl()`, sends every REST call through `makeRequest()`, and exposes `navigate/click/type/pressKey/takeScreenshot/initBrowser/getStatus`. On a preview socket close it always schedules a reconnect.
- `public/script.js` creates the client and the script parser in the `load` handler, runs scripts through one global `isScriptRunning`/`scriptParser`, and draws click indicators with `getIndicatorPosition`. `PyRockScriptParser.executeCommand()` calls `this.pyRock.*` and, for clicks, draws an indicator on `#preview`.
- Tests: `test/preview-lifecycle.test.js` fakes `puppeteer.launch` with a browser that only has `close()` and `newPage()`; `test/preview.integration.test.js` and the client tests call the REST API without any section identifier; the client harness (`createHarness`, `createScriptHarness`) lives inside `test/preview-client.test.js` (729 lines).
- Puppeteer 24.43.1 is installed. Verified against the official docs and the installed type definitions: `browser.createBrowserContext()` returns a context that does not share cookies or cache; `context.newPage()` creates a page in it; `context.close()` closes all its pages; `Browser` emits `disconnected` on close or crash.
- Layout: `.container` is centered at `max-width: 1400px`. The empty strip on the left exists only when the viewport is wider than about 1584px. The right-side tabs already reserve space with `@media (max-width: 1500px)`.

## Proposed Changes

### A. API contract (the interface between the backend and the client slices)

- A section is `{ id, name, url, state }`. `id` is `s1`, `s2`, ... assigned from a counter that never reuses a number. `name` is a trimmed string of 1 to 24 characters, default `Sección N`. `url` is the page's current URL or `''`. `state` is `ready` or `unavailable`.
- `GET /api/sessions` → `200 { success, sessions: [...], default, max }`. `default` is the id of the oldest remaining section, or `null` when none exist. `max` is the section limit.
- `POST /api/sessions` with `{ name? }` → `201 { success, session }`. Errors use `{ success: false, error }`: `400` invalid name, `409` limit reached, `503` browser unavailable or shutting down.
- `DELETE /api/sessions/:id` → `200 { success }`, `404` unknown id, `409` when it is the last section.
- Existing routes `/api/navigate`, `/api/click`, `/api/type`, `/api/key`, `/api/screenshot` (POST and GET), `/api/status` and `/api/init` accept an optional `session`: JSON body field for POST, query parameter for GET. Omitted means the default section. An unknown id returns `404 { success: false, error: 'Sección no encontrada' }`. Every other status code and response shape stays as it is today.
- `POST /api/init` with `session` restarts only that section (closes its context, opens a fresh context and page, same id and name). Without `session` it restarts the browser as today and recreates every existing section with the same id and name and a blank page (or creates `s1` when none exist).
- Preview: `/ws/preview?session=<id>`. The Origin and path guard is unchanged. An omitted id means the default section. An unknown id is accepted, receives `{ type: 'status', state: 'unavailable', message: 'Sección no encontrada' }` and is closed with code `4404`. A viewer is attached to exactly one section.

### B. Backend — `sessions.js` (new) and `server.js`

- `sessions.js` exports `createSessionManager(options)` with injected `openPage`, `closeContext` and `createController` so it can be tested with fakes. It owns the id counter, the ordered registry, the limit, the name rules, the default-section rule and the "at least one section" invariant. Public behavior: `list`, `get`, `getDefault`, `create`, `close`, `restart`, `restartAll`, `markUnavailable`, `closeAll`. Each section holds `{ id, name, context, page, controller, lastScreenshot, state }`.
- `server.js` keeps the single browser. A lazy `ensureBrowser()` launches it with the existing `getBrowserConfig()` and wires `disconnected` to `markUnavailable('Browser disconnected')` (ids and names are kept so `restartAll` can rebuild them). Opening a section runs `browser.createBrowserContext()`, `context.newPage()` and the **existing page setup moved unchanged** into `configurePage(page)`. If setup fails, the context is closed before rethrowing so nothing leaks.
- Every browser or section mutation (launch, create, close, restart, restartAll) goes through one serialized queue, the generalization of today's `initQueue`. Each step re-checks `shuttingDown`, and a browser or context finished during shutdown is closed. `stopServer()` keeps its order: mark shutting down, close every controller, close the WebSocket clients, await the queue, close the browser, close the HTTP server, and stay idempotent.
- The action helpers take a section. On `Target closed` / `Protocol error`, `navigateToUrl` restarts only that section, or all sections if the browser itself is gone. Its retry and backoff logic is untouched.
- One screencast controller per section: `createScreencastController({ getPage: () => section.page })`. `page.once('close')` marks only that controller unavailable. Closing a section closes its controller first, then its context.
- Limit: `MAX_SESSIONS` environment variable, default 5, clamped to 1–10, invalid values fall back to 5.
- `lastAction` stays global. `lastScreenshot` moves into each section.

### C. Client — `public/PyRockHTTP.js`

- Add `sessionId` (default `null`, meaning the server default). All REST action methods add `session` when it is set. `initBrowser({ all })` omits `session` when `all` is true; `connectOnce()` uses `all: true` for its automatic start. Add `listSessions()`, `createSession(name)` and `closeSession(id)`.
- `previewUrl()` appends `?session=<encoded id>` when set. `switchSession(id)` sets the id, detaches and closes the current preview socket, resets the backoff, clears the reconnect timer and opens a new socket for the new section. It is a no-op when the id is unchanged. Frames or ACKs from the old socket stay ignored through the existing `isCurrentSocket` check.
- A preview close with code `4404` does not reconnect; it reports `unavailable` and calls a new `onSessionGone(id)` callback. A `404` response on an action for the active section calls the same callback. `makeRequest` exposes the HTTP status on the thrown error.
- `forSession(id)` returns `Object.create(this)` with its own `sessionId`, so a script can be bound to a section without copying client state.

### D. UI — `public/index.html`, `public/script.js`, `public/styles.css`

- Markup: a fixed `<nav class="session-bar" aria-label="Secciones">` with a `+` button (`id="sessionAdd"`, `aria-label="Agregar sección"`) and a `<ul id="sessionList">` rendered by JavaScript. Each entry is a button (index number above the name truncated to 4 characters, full name in `title` and `aria-label`) plus a `✕` close button. The active entry has `aria-current="true"` and the `active` class. Names are inserted with `textContent`, never `innerHTML`.
- Add: `+` opens an inline name field at the top of the list. Enter creates the section (an empty name uses the default), Escape or blur cancels, and the new section becomes active. The `+` button is disabled with a tooltip when the list reaches `max`. A `409` from the server is logged as an error.
- Switch: clicking an entry calls `switchSession`, stores the id in `localStorage` (`pyrock.activeSession`), hides the previous image with the loading text "⏳ Cargando sección…", resets the pending-render state, and fills the URL field from the section's `url`. The first frame appears immediately because a new viewer already receives the latest frame.
- Close: two clicks. The first turns the `✕` into a confirm state for 3 seconds, the second closes. The last remaining section has no usable close button. Closing the active section activates its neighbor.
- Refresh: the list is reloaded after connecting, after create and close, when the tab becomes visible again, and from `onSessionGone`. The stored active id is set before the first preview socket opens; an id that no longer exists recovers to the server default through the `4404` path.
- Scripts: `executeScript()` captures the active section id, points the parser at `pyrock.forSession(id)` for that run and restores it in the existing cleanup. Click indicators from a script are drawn only while that section is the active one. A section closed mid-script surfaces as the existing script error.
- The restart button now restarts the active section only; its label becomes "🔄 Reiniciar sección".
- CSS: `.session-bar` is `position: fixed` on the left edge, `z-index` above the side panels, with 56px entries, an accent for the active one, and the `✕` visible on hover and `:focus-within`. Add `@media (max-width: 1600px) { .container { padding-left: 92px; } }` so the bar never covers content. The existing `max-width: 1500px` rule that reserves the right side stays unchanged.

### E. Tests (test-first)

- `test/helpers/client-harness.js` (new): move `createHarness` and `createScriptHarness` out of `test/preview-client.test.js` with no behavior change. The existing 52 tests must still pass before anything else changes.
- `test/sessions.test.js` (new): the manager and the HTTP API with a fake Puppeteer. Cover create/list/close, name rules, the limit, refusing to close the last section, default routing for session-less calls, per-section routing of click/type/key/navigate/screenshot, `404` for unknown ids, restart of one section, `restartAll` keeping ids and names, a browser disconnect marking sections unavailable, one controller per section, the preview upgrade with `session` and the `4404` close, and shutdown racing create/close/restart with no leaked context or browser.
- `test/preview-lifecycle.test.js`: extend the fake browser with `createBrowserContext()` returning `{ newPage, close }`. Its assertions do not change.
- `test/sessions-client.test.js` (new): the session parameter on every request, the preview URL with `session`, `switchSession` replacing the socket without reconnect noise, `4404` and `404` recovery, `forSession` binding, the sidebar markup and CSS, add/switch/close flows with the two-step confirm, `aria-current`, the limit state, the stored active id, script binding and indicator suppression, and name rendering through `textContent`.
- `test/sessions.integration.test.js` (new): real Chromium, two sections with distinct fixture pages. Check cookie isolation, that actions reach only the active section, that each section streams its own frames, that restarting one section leaves the other untouched, and that a killed browser followed by `/api/init` restores the ids and names.

### F. Docs — `README.md`

- Document sections, the sidebar, the new endpoints and the `session` parameter, `MAX_SESSIONS`, that sections live in server memory and are lost on a server restart, and that all sections share one Chromium process and its CPU and memory.

## Assumptions & Decisions

- **Needs your confirmation:** the plan assumes each section is an independent browser (own page and cookies), based on your drawing (`Goog`, `Cuen`, `Prue`, controls that act on the active section). If you meant different views of the same page, say so before approving: the sidebar and client half would be reused and the whole backend half dropped.
- Isolation uses one Chromium with one context per section (verified API). Cookies and storage are isolated; CPU, memory and the network address are shared. The default limit of 5 sections guards memory.
- A section is identified by `s<N>`. The default section is the oldest remaining one, and there is always at least one section while the browser is up. Session-less requests keep working, so existing clients, tests and scripts do not break.
- `/api/init` splits in two: with a section it restarts just that one; without one it keeps today's meaning, now preserving every section's id and name. The restart button uses the first form.
- Section state lives only in server memory. The browser remembers only the active id in `localStorage`.
- Names are set when creating a section; renaming and reordering are out of scope. The `+` flow uses an inline field and closing uses an inline two-step confirm, because blocking dialogs (`prompt`/`confirm`) may not work in embedded browser views.
- Staleness between several open UIs is pull-based; there is no server push of the list.
- The page setup moves into `configurePage` unchanged. The anti-bot fingerprint changes discussed for Google are a separate task.
- The change is far above the ~400 changed-line planning heuristic. Splitting it into work units is deliberate (see below).

## Verification

Implementation is test-first. None of the following was run while planning.

- [ ] First, `npm test` passes unchanged after the harness extraction.
- [ ] For each rule in sections B to D, observe RED in the focused file, then GREEN. Existing tests (REST routes, preview stream, direct click, arrow pad, side panels, shutdown races) keep passing.
- [ ] `npm test` once at the end, including the real-Chromium integration test. `node --check` on every changed `.js` file and `git diff --check`.
- [ ] Real-Chromium smoke through the actual UI at 1400px and 1920px wide: create two sections with different pages, click between them and see each one's own content immediately, confirm cookies set in one are absent in the other, and confirm click, type, key and navigate affect only the active section.
- [ ] Close the active section and confirm its neighbor becomes active; confirm the last section cannot be closed; confirm the limit disables `+` (run with `MAX_SESSIONS=2`).
- [ ] Start a script, switch to another section, and confirm the script keeps acting on the section it started in and draws no stray indicator.
- [ ] Restart one section and confirm the other keeps its page; kill the browser process and confirm every section turns unavailable and `/api/init` restores the ids and names.
- [ ] Stop the server while a create is in flight and confirm no browser or context is left open.
- [ ] Inspect screenshots at both widths: the sidebar must not overlap the preview or the controls, and the side tabs on the right must still work.
- [ ] Production proxy behavior for the new query parameter on the WebSocket is not verified locally and is reported separately. No deploy is authorized by approval of this plan.

## ODD routing and delivery

Risk is high (browser lifecycle, concurrency, resource limits), so after the changes' own checks an independent verifier runs once, and native review follows the user-owned switch.

| Slice | Surfaces | Notes |
| ----- | -------- | ----- |
| 1. Backend sections | `sessions.js`, `server.js`, `test/sessions.test.js`, `test/preview-lifecycle.test.js` | Forecast about 600 changed lines including tests |
| 2. Client and sidebar | `test/helpers/client-harness.js`, `public/PyRockHTTP.js`, `public/script.js`, `public/index.html`, `public/styles.css`, `test/preview-client.test.js`, `test/sessions-client.test.js` | Forecast about 700 changed lines including tests |
| 3. Integration and docs | `test/sessions.integration.test.js`, `README.md` | Forecast about 250 changed lines |

Slices 1 and 2 are independent once section A is fixed, so they can run as two parallel bounded writers with disjoint surfaces. The parent then runs slice 3 and the full-suite seam check. Total forecast is about 1500 changed lines, so the recommendation is three work-unit commits; the delivery shape (feature branch or straight to `main`) is your call at execution time. Commits and pushes are not authorized by approving this plan.

## Out of Scope

Renaming or reordering sections; persisting sections across server restarts; per-section log or script history; users, ownership or authentication; per-section viewport sizes; server push of list changes to other open UIs; a mobile layout; the Google/anti-bot fingerprint changes; deploying; commits and pushes.
