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

T1 | S3 | humanize click path (humanize.js + server.js) | done | RED→GREEN; cursory-js 60Hz path; 5/5 humanize tests
T2 | S4 | humanize typing (per-key jitter) | done | 20-180ms jitter; humanize:false instant
T3 | S6 | full suite + smoke + delivery | done | 83/83; commit 3cdbf7b pushed
T4 | S5 | Camoufox feasibility assessment | in_progress | HackerXp studied; awaiting user decision on route

## Log

L1. User request verbatim: "aprende de este proyecto para mejora mi navegador https://github.com/daijro/camoufox".
L2. Camoufox study: Cursory (LGPL, cursory-js v2.1.0) replays 2356 recorded human mouse movements, morphed to endpoints with real timing — replaces their old Bezier because analytic curves have detectable velocity/jerk profiles; 60Hz sampling; 1.5s max per move; hesitations preserved. Camoufox's C++ fingerprint patches are Firefox-side and do not port to Chromium; the Chromium equivalent is runtime injection (stealth-style). Their sponsors are all proxy vendors: IP reputation outweighs fingerprint for Cloudflare.
L3. Gap measured in PyRock: `clickAt` = `page.mouse.click(x, y)` (teleport); `typeText` = `keyboard.type(text)` (no delay). Both trivially detectable.
L4. User selected scope A + D (A: humanize click and typing; D: Camoufox engine). Sequencing: A now on the current Puppeteer backend; D assessed as T4 because Camoufox is Firefox/Playwright-based — CDP screencast (PyRock's live preview) does not exist there, so D implies a preview-pipeline rewrite, not a drop-in swap.
L5. Delivery: 3cdbf7b feat(input) pushed ff0b420..3cdbf7b; suite 83/83; smoke: humanized click 291ms, instant opt-out 272ms, humanized type 611ms for 4 chars. One existing test (sessions.test.js) updated: typing now reaches the page per character.
L6. HackerXp study (user-pointed, read-only): Camoufox is used only for login. Camoufox(headless, os=("linux",), locale="en-US") runs in a worker thread, waits up to 30s for the Turnstile token, fills the form, extracts cookies and closes; later requests use httpx with those cookies. Python sync_api, Firefox 152 bundled, Docker runs `python -m camoufox fetch`. camoufox-js (npm 0.13.0) is an experimental port. Firefox/Juggler has no CDP Page.startScreencast, so replacing Chromium means rebuilding the preview pipeline.
L7. Incident: an unrequested 1.31GB download progress bar appeared in a tool result and the command timed out; %LOCALAPPDATA%\camoufox\camoufox was written at 10:36 (18MB). No Camoufox command was run from this session; source unknown (likely another process sharing the console). Left untouched.
