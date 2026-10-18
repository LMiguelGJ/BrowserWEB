# Plan: Direct clicks on the live preview

> Created by `plan-mode-trae`. Planning only; implementation requires explicit approval.
> Path: `.pi/plans/clic-directo-preview.md` · Artifact language: English.

## Summary

Map a click on the visible preview image to the remote browser's original coordinates, update X/Y, and send exactly one existing REST click. Ignore letterbox margins and preserve valid zero coordinates, manual coordinate entry, the current screencast and layout.

## Current State Analysis

- `public/script.js` has a preview click handler that ignores the mouse event and reads `clickX`/`clickY` instead. It draws an indicator and calls `sendClick()`, which draws a second indicator.
- `sendClick()` uses `parseInt(value) || 600/620`; valid zero values become defaults.
- `getIndicatorPosition()` already computes contain scaling for a remote point, but returns an offset relative to the image element while indicators are positioned inside `.preview-container`. It does not account for image/container origin differences caused by hover scaling.
- `public/styles.css` gives `#preview` width/height 100%, `object-fit: contain`, a centered default object position, and `:hover { transform: scale(1.02) }` with a transition. The positioned container has a 2px border and overflow hidden. Geometry must use the current rendered bounding rectangle, not cached dimensions.
- `public/index.html` uses `<img id="preview">` and numeric fields `clickX`/`clickY`; the coordinate button invokes `sendClick()`.
- `test/preview-client.test.js` already evaluates actual `public/script.js` inside a VM with fake DOM elements. Extend that test harness for click events, geometry and captured client calls; no new test dependency.
- `package.json` runs `node --test test/*.test.js`. `test/preview.integration.test.js` and the existing suite remain unchanged regression checks.
- Exploration baseline: current HEAD `d1b81e4` (`Add automated browser navigation loop`), no changes reported by `git status --short`. Preserve that existing work; this plan does not modify navigation loops or scripts.

## Proposed Changes

### 1. `public/script.js` — shared geometry and single dispatch

- Add a small geometry helper using `preview.getBoundingClientRect()` and `naturalWidth`/`naturalHeight`. Reject missing/unloaded images, nonpositive dimensions and nonfinite geometry.
- Compute `scale = min(rect.width / naturalWidth, rect.height / naturalHeight)`; rendered size = natural size × scale. Center offsets are `(rect.width - renderedWidth)/2` and `(rect.height - renderedHeight)/2`.
- For the actual event, subtract `rect.left/top` and the contain offsets from `event.clientX/Y`. Ignore points outside the rendered content, including exact right/bottom exclusive boundaries; do not turn margin clicks into clamped edge clicks.
- Convert valid content positions with `floor(local / scale)` and clamp numerical rounding to `[0, naturalWidth - 1]` / `[0, naturalHeight - 1]`. Recalculate on every click so resize, scroll, CSS hover scaling and transition frames use current geometry. Do not change or remove the existing hover effect.
- Set `clickX.value` and `clickY.value` to the converted integers, then invoke `sendClick()` once. Do not call `pyrock.click()` or draw an indicator separately in the image handler.
- In `sendClick()`, parse as base-10 integers and use defaults only when parsing returns NaN. Preserve existing defaults for empty/invalid manual values; preserve zero. Keep existing connection checks, logging and REST behavior.
- Have `getIndicatorPosition()` reuse the same image geometry and translate its projected viewport point into `.preview-container` local positioning coordinates, subtracting the container bounding origin and `clientLeft/clientTop` border. Keep its signature and `{x,y}` return shape because manual controls and script indicators also use it. Callers must safely skip indicators when geometry is unavailable; REST manual controls remain usable without a loaded preview.
- Keep `showClickIndicator()` as the one indicator creator; one image click must result in one indicator. Do not add pointermove, hover coordinate tracking, dragging, scrolling, right click, double-click commands or keyboard forwarding.

### 2. `test/preview-client.test.js` — targeted regressions first

- Extend the existing VM fake DOM with controllable image/container rectangles, border widths, natural dimensions, event payloads and a `FakeClient.click` call recorder. Keep all current tests intact.
- Exercise the real registered image click callback and `sendClick()`, asserting exact client call counts/arguments, resulting field values and indicator count/position rather than only testing arithmetic helpers.
- Add one rule-focused test for contain conversion (center and edge points, horizontal/vertical margins, scaled-up/down previews and nonzero page offsets), one for ignoring margin/unready-image clicks without sends or field changes, one for exactly-one dispatch/indicator plus X/Y updates, and one preserving zero in manual and direct-image paths.
- In the same geometry cases, cover the existing hover scale and container border, resize/scroll between clicks, and the current manual coordinate-button behavior (including old empty/invalid defaults and no remote send when disconnected). Verify the shared indicator helper still projects a known remote point correctly for existing callers.

### 3. `public/index.html` — explain the existing control

- Add a descriptive `title` to `#preview`: `Haz clic sobre la imagen para enviar el clic y actualizar X/Y.` Keep the control panel, preview layout, fields and buttons unchanged. No new status area or stylesheet change.

## Assumptions & Decisions

- Natural image dimensions remain the remote viewport coordinates; the current screencast preserves the original viewport resolution. No server or protocol changes are required.
- The current centered contain layout and uniform CSS scale are supported. Arbitrary CSS rotations, skew or nonuniform transforms are not introduced or supported by this slice.
- A valid direct-image click updates X/Y even if REST is disconnected; existing `sendClick()` handles that state without sending a remote click. Invalid/margin clicks do not alter X/Y or add indicators.
- Direct clicks are integer pixel coordinates; nearest visible pixel selection uses floor, not rounding into an out-of-range right/bottom coordinate.
- Do not modify `public/styles.css`, `server.js`, `screencast.js`, `public/PyRockHTTP.js`, the parser, dependencies, `.env` or unrelated navigation automation.
- This is one contained frontend fix with tests and tooltip; expected review scope is well below 400 changed lines. No worker, durable ODD feature tracker, commits, push or deployment are authorized by planning alone.
- No clarification questions are pending. The requested behavior and current CSS resolve the implementation choices.

## Verification

Implementation uses test-first; none of the following checks has been run as implementation proof during planning.

- [ ] Observe RED for the requested click rules through `node --test test/preview-client.test.js` before source changes.
- [ ] Observe GREEN with the same focused command after implementation; existing preview transport/render/reconnect tests continue passing.
- [ ] Run `npm test` once as the full regression suite, including the existing local Chromium integration. No calls to production, YouTube or other external sites.
- [ ] Run `node --check public/script.js` and `node --check test/preview-client.test.js`; run active diagnostics on changed JS/HTML and report unavailable coverage honestly.
- [ ] Run `git diff --check` and confirm only the intended frontend/test surfaces changed; no backend, transport, parser, dependency or navigation-loop edits.
- [ ] Local browser smoke: use a controlled fixture with a clickable target and observe the actual POST `/api/click` payload. Click the displayed target at reduced and enlarged viewport sizes, with hover active; confirm the remote target receives the click, fields match its coordinates, and only one POST/indicator is generated.
- [ ] Click a visible letterbox margin and assert no POST, no X/Y change and no indicator. Exercise `(0,0)` directly at the image origin when visible, and via the manual fields regardless of clipping; assert no fallback to `(600,620)`.
- [ ] Confirm the tooltip explains direct click behavior; current manual coordinate button, preview stream, navigation and keyboard controls remain available.

## Out of Scope

Implementation before approval; live mouse-position tracking; scrolling/dragging/double/right click; viewport or streaming changes; multi-session control; navigation loops; backend validation changes; redesign; commits, push or deployment.
