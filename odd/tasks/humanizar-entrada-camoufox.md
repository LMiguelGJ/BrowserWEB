# Humanizar entrada + motor anti-detect — ODD execution

Objective: learn from Camoufox (daijro/camoufox) and improve PyRock's browser realism: humanized cursor movement and typing now (A), Camoufox engine assessment next (D). Baseline `315d8ba5788249b9032bec2fb16e19fdb258f7d7` on `main`.
Delivery: work-unit commits on `main` and push (standing authorization in this work stream); no PR. Runner: `npm test`.

## Specs

S1. User request verbatim: "aprende de este proyecto para mejora mi navegador https://github.com/daijro/camoufox".
S2. Scope chosen by user: "A: Humanizar clic y tipeo" + "D: Motor Camoufox".
S3. Humanized click: clicking at (x,y) must move the cursor along a realistic path (recorded-human trajectories, real timing including hesitations — the Cursory lesson) before the click; no instant teleports. Opt-out via `humanize: false` in the API; backward compatible for existing clients/scripts.
S4. Humanized typing: `type` writes with jittered per-key delays by default; `humanize: false` keeps instant typing.
S5. Camoufox engine (D): assess feasibility as a separate task; must state the screencast/preview blocker honestly before any rewrite.
S6. All existing behavior and tests keep passing; scripts and session-less REST calls keep working.

## Tasks

T1 | S3 | humanize click path in `server.js` (+ `humanize.js` generator, per-section cursor memory) | in_progress | RED first in `test/sessions.test.js`.
T2 | S4 | humanize typing (per-key jitter) | pending | RED first.
T3 | S6 | full suite + smoke + delivery commits | pending | After T1-T2.
T4 | S5 | Camoufox feasibility assessment (preview/screencast blocker, Playwright wiring, runtime deps) → proposal to user | pending | Separate decision before any rewrite.

## Log

L1. User request verbatim: "aprende de este proyecto para mejora mi navegador https://github.com/daijro/camoufox".
L2. Camoufox study: Cursory (LGPL, cursory-js v2.1.0) replays 2356 recorded human mouse movements, morphed to endpoints with real timing — replaces their old Bezier because analytic curves have detectable velocity/jerk profiles; 60Hz sampling; 1.5s max per move; hesitations preserved. Camoufox's C++ fingerprint patches are Firefox-side and do not port to Chromium; the Chromium equivalent is runtime injection (stealth-style). Their sponsors are all proxy vendors: IP reputation outweighs fingerprint for Cloudflare.
L3. Gap measured in PyRock: `clickAt` = `page.mouse.click(x, y)` (teleport); `typeText` = `keyboard.type(text)` (no delay). Both trivially detectable.
L4. User selected scope A + D (A: humanize click and typing; D: Camoufox engine). Sequencing: A now on the current Puppeteer backend; D assessed as T4 because Camoufox is Firefox/Playwright-based — CDP screencast (PyRock's live preview) does not exist there, so D implies a preview-pipeline rewrite, not a drop-in swap.
