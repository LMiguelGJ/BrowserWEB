# Camoufox engine for PyRock — ODD execution

Objective: run PyRock sections on Camoufox (anti-detect Firefox) instead of Chromium/Puppeteer, keeping the REST/WebSocket contract and the UI. Baseline `1bac4904c6c1ad01566a10707b3163d49e85438b` on `main`.
Delivery: work-unit commits on `main` and push (standing authorization in this stream); no PR. Runner: `npm test`.

## Specs

S1. User decision verbatim (choice "Reescribir PyRock sobre Camoufox"), after "aprende de este proyecto para mejora mi navegador <https://github.com/daijro/camoufox>".
S2. The public contract stays: `/api/*` REST incl. the `session` parameter, `GET /api/sessions`, WebSocket preview with the `4404` close, sidebar sections, `MAX_SESSIONS`, session-less calls hitting the default section. The UI does not change.
S3. One Camoufox browser process, one Playwright `BrowserContext` per section (isolated cookies, same model as today's Puppeteer contexts).
S4. Live preview through `page.screencast.start({ onFrame })` (Playwright >= 1.59; JPEG frames; Firefox is capped at 25 fps per the official docs) mapped onto the existing preview protocol.
S5. Humanization: Camoufox ships its own cursor humanizer (`humanize` option, Cursory inside Juggler). On the Camoufox engine PyRock must not double-humanize: `humanize.js` stays for the Chromium engine only.
S6. Strangler migration: an engine adapter with `ENGINE=chromium|camoufox` (default chromium until the Camoufox path passes the real-browser integration test), so the working product is never broken mid-migration.
S7. Constraints found: `camoufox-js` (Apify, npm 0.13.0, experimental port) needs Node >= 22 and `playwright-core < 1.63`; the Firefox binary is ~1.3 GB (`camoufox-js fetch`); Docker image needs Firefox system libs (HackerXp's Dockerfile is the reference).
S8. Honest limit: a new engine does not fix IP reputation; Cloudflare also scores the IP. The goal is a stealthier browser, not a guaranteed bypass.

## Tasks

T1 | S3,S4,S7 | spike with the real binary | dropped | User decided (L5): the target is a remote Docker host, so no local ~1.3 GB download; real validation happens on the server with ENGINE=camoufox.
T2 | S6 | engine selection | done | ENGINE=chromium|camoufox via selectEngine(); Chromium default; existing tests untouched
T3 | S3,S4,S5 | Camoufox engine (engines/camoufox.js) | done | 9 unit tests + 1 server wiring test with a fake camoufox module; CDP bridge keeps screencast.js untouched
T4 | S2 | real-browser integration on Camoufox | blocked | Needs the real binary; run on the server, not verifiable locally
T5 | S7 | Dockerfile.camoufox | done | Separate Node 22 glibc image; unverified: the `npx camoufox-js fetch` command and the build itself
T6 | S6 | switch default to camoufox | pending | Only after the server run proves frames, clicks and isolation

## Log

L1. User choice verbatim: "Reescribir PyRock sobre Camoufox".
L2. Feasibility research: Playwright docs (class-screencast) list `start({onFrame})` delivering JPEG frames (added v1.59) and state Firefox/WebKit capture up to 25 fps. camoufox-js: dependencies include impit, better-sqlite3, fingerprint-generator; peer `playwright-core <1.63`; engines node >= 22 (local Node v24.14.0 is fine); latest playwright-core is 1.64.1, so it must be pinned to 1.62.x. HackerXp reference: Python Camoufox used only for login, then httpx with cookies.
L3. Open risk: Camoufox's patched Juggler must actually deliver `onFrame` frames; the docs prove the Playwright API, not Camoufox's fork. T1 is the proof.
L4. Incident note: an unrequested 1.31 GB download progress bar appeared in an earlier tool result; `%LOCALAPPDATA%\camoufox\camoufox` was written at 10:36 (18 MB), source unknown, no Camoufox command was run from this session. Confirm nothing else is fetching before T1 downloads into the same cache.
L5. User answer verbatim: "creo que ya lo tengo instalado y si no es asi tampoco es necesario pues esto esta desplegador en un server remoto con docker". T1 dropped; design changed to fakes-only locally plus a real run on the server.
L6. Design: screencast.js (CDP, 83 tests) is untouched; engines/camoufox.js exposes a CDP-compatible createCDPSession() that turns page.screencast.onFrame into Page.screencastFrame events, with screenshot polling as fallback. Camoufox owns request headers, so setExtraHTTPHeaders is a no-op (Chrome-style Sec-Fetch-* would contradict its fingerprint); no window.chrome/navigator patches. Camoufox's own cursor humanizer is on, so PyRock does not stack humanize.js on that engine. camoufox-js and playwright-core are optional peer dependencies (declared for tooling, not installed by the Chromium image); the dynamic import() needs the PYROCK_CAMOUFOX_MODULE test seam.
L7. Bug found while testing: server.js slept the whole humanized movement after already walking the steps (~630 ms extra per click on average over 1500 seeds); humanize.js now returns trailingDelayMs (Camoufox's contract). The flaky seeded-random test was replaced by deterministic invariants plus a 200-seed property test. Fixed in f607757.
L8. Delivery: f607757 fix(input), 7219326 feat(engine). Suite 94/94 on three consecutive runs; one earlier failure in the Chromium preview integration test (33 s timeout under load) did not reproduce. Not verified: the real Camoufox binary, `npx camoufox-js fetch`, the Docker build, and whether Camoufox's patched Juggler delivers onFrame.
