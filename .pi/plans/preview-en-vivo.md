# Plan: Minimal live browser preview

> Created by `plan-mode-trae` — read-only planning; implementation requires explicit approval.
> Path: `.pi/plans/preview-en-vivo.md` · Artifact language: English.

## Summary

Replace automatic screenshot polling with a CDP JPEG screencast delivered over a same-port WebSocket, keeping the current image element and all browser controls on REST. Preserve explicit manual screenshots; do not add browser sessions, external automation connections, recording, or redesign.

## Current State Analysis

- `server.js` owns one global Puppeteer browser/page, a 1366×768 viewport, Express routes, and an existing `http.createServer(app)`. Startup, `/api/init`, and critical navigation errors can initialize or replace the browser; SIGINT/SIGTERM close it.
- `POST /api/screenshot` creates a JPEG and updates `lastScreenshot`; `GET /api/screenshot` only returns that stored image. `public/PyRockHTTP.js` polls GET without creating a fresh image: this explains a stale/empty preview independently of polling frequency.
- `public/PyRockHTTP.js` also schedules POST screenshots after navigation, clicks, typing, and key presses. Its HTTP connection state gates existing REST controls.
- `public/script.js` creates PyRockHTTP in its load handler. `onScreenshotUpdate` sets `preview.src`, handles image load/error, and updates the timestamp. Click indicators depend on image natural dimensions.
- `public/config.js` derives the HTTP server URL from the current location and sets screenshot polling to 5000 ms and status polling to 30000 ms. `public/index.html` advertises one-second refresh; that copy is obsolete.
- `package.json` declares Puppeteer and Express but no direct `ws` dependency or test command. No test suite was identified. Initial git status contained unrelated untracked `.codegraph/` and `script.txt`; preserve them.
- Public Puppeteer documentation confirms `page.createCDPSession()`, `send()`, and `detach()`. CDP uses `Page.startScreencast`, `Page.screencastFrame`, `Page.screencastFrameAck`, and `Page.stopScreencast`.
- Explorer Docker findings were inconsistent and are not accepted as evidence of missing files or broken Docker. No container execution is necessary for this preview plan.

## Proposed Changes

### 1. `package.json` and generated `package-lock.json`
- Add `ws` as a direct runtime dependency, using the current compatible stable 8.x release verified when installing; generate the npm lockfile rather than editing it manually.
- Add `test` = `node --test test/*.test.js`. Use Node's built-in runner and dependency injection rather than adding a testing framework.
- Do not update unrelated dependency ranges or change the Node engine contract in this slice. If the existing declared runtime cannot run the installed dependencies, report that as a separate blocker, not an implicit upgrade.

### 2. New `screencast.js`
- Extract a small CommonJS controller with injected page access and WebSocket server, solely to isolate stream lifecycle and enable deterministic tests. Keep browser automation routes in `server.js`.
- Maintain one CDP producer for the existing page, shared among viewers; viewers do not create independent browser sessions. Serialize start/stop/replacement operations and invalidate stale callbacks with a generation counter.
- Attach the frame listener before sending `Page.startScreencast` with JPEG quality 60, maxWidth 1366, maxHeight 768, everyNthFrame 1. Do not resize the page or alter coordinate mapping.
- Start on the first viewer when a page is available; stop/detach when the last viewer leaves. On page close/browser disconnect, release listeners and notify viewers. On successful browser replacement, start on the new page if viewers remain. Failed starts produce a visible preview error, not unhandled rejections or a screenshot fallback loop.
- Acknowledge every CDP frame promptly with its CDP sessionId, including deliberately dropped frames. This ACK is distinct from the viewer's rendering ACK.
- Bounded backpressure: retain only the newest pending frame globally; allow at most one frame awaiting a rendering ACK per viewer. Send the latest frame after that viewer ACKs the previous one. Also check socket OPEN state and bufferedAmount before sending; do not queue application frames behind an outstanding frame. Close an unresponsive viewer after 10 seconds awaiting ACK, clearing its timers/state. A healthy viewer must not wait for a slow viewer.
- Use a small JSON protocol: server `{type:'frame', id, data}` (JPEG data URL), `{type:'status', state:'starting'|'live'|'unavailable', message?}`, and `{type:'error', message}`; client `{type:'ack', id}`. IDs are monotonically increasing within the controller, never reused after browser replacement. Ignore stale/duplicate ACKs; reject malformed input without executing any browser command.
- Cleanup is idempotent: stop producer, remove listeners, detach CDP, clear ACK timers and pending frames. Catch expected errors from an already-closed target; do not hide unrelated errors.

### 3. `server.js`
- Attach a WebSocket endpoint `/ws/preview` to the existing HTTP server/port; no second listener and no public raw CDP endpoint. Disable WebSocket compression and bound inbound messages to 1 KiB because clients send ACKs only.
- Reject browser upgrade requests with an Origin host different from the request Host; allow only this preview path. This is a narrow cross-origin check, not authentication. Do not add credentials or change REST access policy in this slice.
- Wire controller teardown before browser replacement, restart after the new page is fully configured, browser/page failure notifications, and shutdown before browser.close(). Mark the old page unavailable during replacement so late connections cannot restart a stream on it.
- Preserve REST paths, payloads, success/error handling, browser viewport, manual screenshot storage, and navigation/mouse/keyboard behavior.

### 4. `public/PyRockHTTP.js` and `public/config.js`
- Keep PyRockHTTP as the existing REST client; add the preview WebSocket lifecycle to it rather than introducing another public client abstraction.
- Build the WebSocket URL from configured serverUrl, replacing http/https with ws/wss and selecting `/ws/preview`. HTTPS must never open an insecure ws connection.
- After REST connect, open the preview socket. Remove automatic screenshot GET polling, delayed first cached-image fetch, and delayed screenshots after navigate/click/type/key; retain explicit `takeScreenshot()` and the existing REST methods.
- Keep status checks on a separate self-scheduling timer using statusPollIntervalMs. A WebSocket failure must not mark working REST controls disconnected.
- Add `onPreviewStatus` for stream state; preserve existing onStatusChange meaning (HTTP/control connectivity). Add optional completion callback to onScreenshotUpdate: frame ACK is sent only when the image has loaded or failed, not merely when received. The existing caller is updated in the same slice.
- Reconnect preview only after unexpected socket loss, with one timer and delays 1, 2, 4, 8, then 10 seconds capped. Reset delay only after a rendered frame; disconnect/unload cancels retries, status timers, sockets, and delayed callbacks. Never replay a REST action during preview reconnect.
- Remove the unused screenshot polling configuration instead of retaining misleading settings. No automatic REST screenshot fallback: manual capture remains available if streaming fails.

### 5. `public/script.js` and `public/index.html`
- Reuse `<img id="preview">`, existing load/error handlers, image sizing and coordinate helpers. Signal render completion exactly once per received frame even on image error; do not ACK stale generations after disconnect.
- Add a pagehide cleanup calling pyrock.disconnect(). Report preview starting/live/reconnecting/unavailable separately through the existing preview help area/loading text and log, without changing the layout or the HTTP connection indicator.
- On stream loss retain the last image but label it paused/reconnecting; do not imply it is live. No-frame-on-static-page is not itself a failure.
- Replace one-second/polling wording with event-driven live preview wording. Preserve manual screenshot controls and script parser integration.

### 6. `README.md`
- Document hybrid transport: REST controls, WebSocket/CDP preview, explicit manual screenshots. Remove obsolete fixed-refresh and all-WebSocket claims in the affected sections.
- Explain one shared browser, no audio/FPS guarantee, same-port ws/wss URL, and reverse-proxy WebSocket upgrade requirement. No deployment changes, credentials, or new provider services.

### 7. New tests under `test/`
- `test/screencast.test.js`: fake CDP/socket lifecycle and bounded-frame tests; use public controller operations and emitted messages rather than inspecting private fields.
- `test/preview-client.test.js`: load the browser client with fake fetch/WebSocket/timers; assert transport behavior, render ACK, reconnect and cancellation without external network access.
- `test/preview.integration.test.js`: start a real temporary local HTTP/WebSocket server with Puppeteer and a deterministic local page whose text and color change on a timer and whose input/button can be controlled. Import/start the app under a main-entry guard with configurable port and shutdown hook; keep `npm start` behavior unchanged. Use an isolated browser and never navigate to external sites. Test integration through HTTP/WebSocket and a local browser viewer.

## Assumptions & Decisions

- This is one browser/page with potentially multiple viewers, not a multi-session feature. Closing a viewer must not close the browser.
- Use JPEG data URLs and the current image element for minimum frontend change; defer binary transport, canvas, video encoding and quality controls.
- Only the manual screenshot button may still request REST screenshots during live streaming. All automatic screenshots are removed; screenshot GET remains available for existing consumers.
- Do not fix unrelated navigation retries, parser loops, auth, sandbox flags, or Docker configuration. Existing unauthenticated browser access remains a deployment risk; same-origin validation is not authorization.
- The production proxy's WebSocket support must be verified in the deployment environment; a local pass does not prove deployed connectivity. No publishing/deployment is authorized by plan approval.
- Keep the behavior slice near 400 changed lines where practical. If essential lifecycle handling exceeds that, propose reviewable slices before expanding scope; do not remove cleanup or backpressure to hit a line count.
- No product questions are pending: the user's supplied scope determines the transport, element reuse, controls and exclusions. This file is the only repository write authorized during planning. Implementation requires a subsequent explicit approval.

## Verification

Implementation is test-first: observe focused RED for each requested rule before behavior changes, then GREEN; do not claim execution evidence from this plan.

- [ ] `npm test`: deterministic lifecycle/client tests and local Chromium integration tests. A missing browser or test dependency is reported as unavailable proof, never silently skipped or counted as passed. No cloud URLs or real user data.
- [ ] First viewer starts exactly one CDP producer; another viewer shares it. Last viewer close issues stop/detach once. Repeated cleanup is harmless.
- [ ] Each CDP frame gets the correct ACK even when dropped. Fast frames plus a delayed viewer do not grow a queue; after render ACK the viewer receives the newest available frame. A fast viewer continues independently. Unresponsive viewers close at the specified bound.
- [ ] Timer-driven page changes produce at least two distinct decodable frames without HTTP screenshot requests; no fixed FPS assertion. The image retains 1366×768 natural dimensions and existing click coordinates target the same fixture control.
- [ ] Navigate, click, type and key continue through their unchanged REST requests and visibly affect the fixture. Manual screenshot still returns a fresh image; GET returns the saved manual capture. Existing status/init routes remain usable.
- [ ] No screenshot GET polling or delayed screenshot POST after actions. Status polling continues independently. HTTP controls remain usable when the stream is unavailable.
- [ ] HTTP builds ws and HTTPS builds wss URLs. Wrong preview path/cross-origin upgrade/malformed ACK do not start arbitrary work.
- [ ] Rendering load/error both release ACK flow. Preview loss, reconnect and pagehide cleanup are visible and leave no duplicate sockets/timers or old-generation frames.
- [ ] `/api/init` closes the previous CDP producer and resumes streaming the new page to remaining viewers. Browser failure causes an unavailable state; later successful init restores frames.
- [ ] `node --check server.js`, `node --check screencast.js`, `node --check public/PyRockHTTP.js`, `node --check public/script.js`, `node --check public/config.js`.
- [ ] Local browser smoke test: see dynamic changes, click/type, disconnect/reconnect, reset browser, and close viewer. Check Network for WebSocket frames and absence of automatic screenshot traffic; inspect browser/server console for errors.
- [ ] Before declaring deployed behavior fixed, verify an actual `wss` upgrade and incoming frames on the real deployment. If access/proof is unavailable, explicitly separate locally verified behavior from unverified production behavior and request that specific decision/access only.
- [ ] Review final diff: no .env, unrelated untracked files, parser changes, credentials, deployment changes or raw CDP exposure. Dependency change and lifecycle concurrency require independent verification after implementation's own checks; native review follows the user-owned switch and candidate assessment, not this plan alone.

## Out of Scope

Multiple browser sessions, external Puppeteer/Playwright access, recording/replay, audio, noVNC, a new debugger UI, parser fixes, authentication rollout, hosting changes, deployment, commits and publishing.
