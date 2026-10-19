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

T1 | S3,S4,S7 | spike: install pinned `camoufox-js` + `playwright-core@1.62.x`, fetch binary, launch headless, open a context, navigate, capture `onFrame`, click, measure fps/latency | pending | Needs the ~1.3 GB download; user confirmation requested first.
T2 | S6 | engine adapter (open section, page actions, screencast, close) with the current Puppeteer behavior behind it | pending | Test-first; existing 83 tests must stay green untouched.
T3 | S3,S4,S5 | Camoufox engine implementation behind the adapter | pending | After T1 proves frames and clicks.
T4 | S2 | real-browser integration test on Camoufox (isolated cookies, frames, click, restart) | pending | Mirrors test/sessions.integration.test.js.
T5 | S7 | Dockerfile/deploy changes (Firefox libs, binary fetch at build, image size) | pending | Production is the sslip.io host; deploy is a separate user decision.
T6 | S6 | switch default to camoufox once T4 is green; README and DESIGN-free docs | pending | Only after T4.

## Log

L1. User choice verbatim: "Reescribir PyRock sobre Camoufox".
L2. Feasibility research: Playwright docs (class-screencast) list `start({onFrame})` delivering JPEG frames (added v1.59) and state Firefox/WebKit capture up to 25 fps. camoufox-js: dependencies include impit, better-sqlite3, fingerprint-generator; peer `playwright-core <1.63`; engines node >= 22 (local Node v24.14.0 is fine); latest playwright-core is 1.64.1, so it must be pinned to 1.62.x. HackerXp reference: Python Camoufox used only for login, then httpx with cookies.
L3. Open risk: Camoufox's patched Juggler must actually deliver `onFrame` frames; the docs prove the Playwright API, not Camoufox's fork. T1 is the proof.
L4. Incident note: an unrequested 1.31 GB download progress bar appeared in an earlier tool result; `%LOCALAPPDATA%\camoufox\camoufox` was written at 10:36 (18 MB), source unknown, no Camoufox command was run from this session. Confirm nothing else is fetching before T1 downloads into the same cache.
