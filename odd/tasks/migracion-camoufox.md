# Migración completa a Camoufox — ODD execution

Objective: PyRock is Camoufox-only. The legacy Chromium Dockerfile is removed; the only Docker image is `Dockerfile.camoufox`. Baseline `c5273a87c55a77cf58ea3e69e274a9a28aa41c35` on `main`.
Delivery: single work-unit commit on `main` and push (standing authorization in this work stream); no PR. Runner: `npm test`.

## Specs

S1. User request verbatim: "C:/Users/luism/OneDrive/Escritorio/BrowserWEB/Dockerfile elinina este y deja solo C:/Users/luism/OneDrive/Escritorio/BrowserWEB/Dockerfile.camoufox ya haz la migracion completa".
S2. Remove `Dockerfile` (Chromium). `Dockerfile.camoufox` is the only image.
S3. The public REST/WebSocket contract stays byte-compatible: `/api/*` incl. `session`, `GET /api/sessions`, 4404 close, `MAX_SESSIONS`, session-less → default section.
S4. UI does not change.
S5. ENGINE=camoufox becomes the only mode: `selectEngine()` no longer chooses Chromium; Chromium option removed. `camoufox-js` and `playwright-core@1.62.x` are now runtime dependencies (no longer optional peers).
S6. `humanize` stays on by default; `humanize: false` still returns to instant clicks and typing. The wrapper already drops Chrome headers and skip Chrome-only stealth — those rules still hold.
S7. The 94/94 suite must keep passing. The current test seams (`PYROCK_CAMOUFOX_MODULE`, the fake `puppeteer.launch` override) are removed; tests use a fake `camoufox-js` module the same way they used the Puppeteer override.

## Tasks

T1 | S2 | remove `Dockerfile` and `.dockerignore` no longer applies to the old image | in_progress | Tracked above.
T2 | S5 | promote `camoufox-js` + `playwright-core@1.62.x` to `dependencies`; `engines` ≥ 22; drop Chromium peer block | pending
T3 | S3,S5,S6,S7 | refactor `server.js`: `ensureBrowser`, `configurePage` and the puppeteer-only path disappear; the engine adapter is the only path; `engine.humanizesCursor` makes `humanize.js` a no-op | pending
T4 | S7 | refactor tests: drop the Puppeteer override in `sessions.test.js`; the integration test now drives the Camoufox adapter through a fake `camoufox-js` | pending
T5 | S1 | update `package.json` scripts (`docker:build` now references `Dockerfile.camoufox`); update README and the deployment section | pending
T6 | | commit + push; tracker log records the open risks (real binary, `camoufox-js fetch`, Juggler `onFrame`) | pending

## Log

L1. User request verbatim: "C:/Users/luism/OneDrive/Escritorio/BrowserWEB/Dockerfile elinina este y deja solo C:/Users/luism/OneDrive/Escritorio/BrowserWEB/Dockerfile.camoufox ya haz la migracion completa".
L2. State: previous work shipped a Chromium-default + opt-in Camoufox (`7219326`); `humanize` worked for both but Camoufox alone is what we want now. The legacy Dockerfile used `node:18-alpine` + Chromium, which cannot run Camoufox's glibc Firefox build.
L3. Plan: keep `engines/camoufox.js`, `humanize.js`, the screencast module, and the existing test seams. Drop Chromium entirely. The 83-test suite becomes 94 because the migration is behavior-preserving for the user, but the contracts of `ensureBrowser` and `configurePage` change. Per the new rule, fixes are test-first.
L4. Known gaps (declared, not hidden): the Camoufox binary, the `npx camoufox-js fetch` subcommand, and `page.screencast` from the patched Juggler are unverified locally; the server build and one real run are the proof.
L1. User request verbatim: "C:/Users/luism/OneDrive/Escritorio/BrowserWEB/Dockerfile elinina este y deja solo C:/Users/luism/OneDrive/Escritorio/BrowserWEB/Dockerfile.camoufox ya haz la migracion completa" and later "pero dejalo ya solo como docker file si ese .coamufox pues ya esto esta desplegado".
L2. Official camoufox-js API (0.13.0) confirmed from the published type definitions: `Camoufox(options)` returns a Playwright Browser (not a context manager, unlike the Python API); the CLI command is `camoufox-js fetch`; `humanize` is a launch-time boolean/number; contexts default to `viewport: null` (an explicit viewport breaks the spoofed window); `headless` accepts true/false/"virtual"; peer `playwright-core < 1.63`.
L3. Design decisions from that API: (a) no viewport is ever set — Camoufox pins the window and lets Juggler measure it; (b) no user agent, no Chrome-style headers and no injected scripts — they would contradict the native fingerprint; (c) the frame must be requested at the page's own CSS size, because PyRock's client maps a preview click back to page coordinates through the image's pixel size (manual screenshots use `scale: 'css'` for the same reason); (d) Camoufox's own cursor humanizer is launch-time only, so it is turned OFF and PyRock keeps its own (cursory-js) to honour the per-request `humanize: false` contract.
L4. The wrapper's `setExtraHTTPHeaders` became a no-op and `navigateToUrl` no longer sends Chrome headers. The Chromium stealth block in `configurePage` was deleted, not ported.
L5. Bug found by the new tests: the first click did not walk, because there was no known pointer position. Playwright's pointer starts at (0,0) — that position is known — so the walk now starts there instead of teleporting. Test updated to assert "moves before the click".
L6. Test migration: `puppeteer.launch` mocks became a shared fake `camoufox-js` module (`test/fixtures/fake-camoufox.js`, seam `PYROCK_CAMOUFOX_MODULE`, state on globalThis so the test and the server observe the same object). The real-browser integration tests use `test/fixtures/playwright-chromium-camoufox.js`, which exposes the camoufox-js contract on top of a real Playwright Chromium (Puppeteer's cached build), so the migrated path is exercised end to end without the 1.3 GB binary.
L7. Two real API differences between Puppeteer and Playwright bit the tests and were fixed: `waitForFunction(fn, options, ...args)` (Puppeteer) vs `waitForFunction(fn, arg, options)` (Playwright) — the URL was being passed as options, so the poll fetched `[object Object]` and got an HTML 404; and Playwright's `page.route` replaces Puppeteer's request interception.
L8. Two false failures were chased and understood rather than papered over: `--test-force-exit` made the runner report a passing file as failed (it was my own patch, removed again); and the browser-server transport (`chromium.launchServer` + `connect`) kept the test process alive for 130 s, so the fixture now launches the browser directly and the cleanup closes it.
L9. Delivery: `Dockerfile` is the only image (Node 22 bookworm, Firefox runtime libraries, `npx camoufox-js fetch` at build time, npm cache mount, non-root user that owns the browser cache). The Chromium image is gone.
L10. Suite: 97/97 green (74 before the migration, plus the engine/server/integration coverage), three consecutive clean runs.
L11. Open risks, declared not hidden: the real Camoufox binary was never launched locally (the first real run is on the server), the `npx camoufox-js fetch` step and the Docker build are unverified, and better-sqlite3 (a native dependency of camoufox-js) needs a compiler in the image (python3/make/g++ were added for that). A new engine does not fix IP reputation.
