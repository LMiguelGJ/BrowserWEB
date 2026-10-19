'use strict';
// Fake `camoufox-js` module used through the PYROCK_CAMOUFOX_MODULE test seam.
//
// It mimics the real package's contract: `Camoufox(options)` returns a
// Playwright-like Browser with `newContext()`; each context yields pages with
// `mouse`, `keyboard`, `goto`, `screenshot` and `isClosed`.
//
// The server imports this file through `import()`, the test through
// `require()`: Node shares the CJS instance between both, so the test observes
// the very same state the server mutates.
//
// State lives on globalThis and is recreated by `reset()`, so each test starts
// from a clean registry.
//
// Optional configuration (read at call time, not at import time):
//   globalThis.__pyrockCamoufoxConfig = {
//     beforeLaunch: async (index) => {},    // may block, to test shutdown races
//     beforeNewPage: async (context) => {}, // may block, to test in-flight creates
//     makeBrowser: (index) => browser,      // override the default browser
//   }
const { EventEmitter } = require('node:events');

function freshState() {
    return { launches: [], contexts: [], pages: [], browsers: [] };
}

function currentState() {
    if (!globalThis.__pyrockCamoufoxState) globalThis.__pyrockCamoufoxState = freshState();
    return globalThis.__pyrockCamoufoxState;
}

function reset() {
    globalThis.__pyrockCamoufoxState = freshState();
    return globalThis.__pyrockCamoufoxState;
}

function makePage(context, label = 'shot', url = 'https://example.test/') {
    const page = new EventEmitter();
    page.calls = [];
    page.closed = false;
    page.label = label;
    page.url = () => url;
    page.url = () => url;
    page.isClosed = () => page.closed;
    page.goto = async (url) => {
        page.calls.push(['navigate', url]);
        return { status: () => 200, statusText: () => 'OK' };
    };
    page.screenshot = async options => {
        page.calls.push(['screenshot', options]);
        return Buffer.from(label);
    };
    page.mouse = {
        move: async (...args) => page.calls.push(['move', ...args]),
        click: async (...args) => page.calls.push(['click', ...args])
    };
    page.keyboard = {
        type: async value => page.calls.push(['type', value]),
        press: async value => page.calls.push(['key', value])
    };
    // Playwright exposes page.screencast; the fake never emits frames and does
    // not record into page.calls (the preview bridge must not pollute the
    // recorded call log the tests assert on).
    page.screencast = { start: async () => {}, stop: async () => {} };
    page.context = context;
    return page;
}

function makeBrowser() {
    const browser = new EventEmitter();
    browser.closeCount = 0;
    browser.close = async () => { browser.closeCount++; browser.emit('disconnected'); };
    browser.newContext = async () => {
        const state = currentState();
        const context = new EventEmitter();
        context.closed = false;
        context.pages = [];
        context.newPage = async () => {
            const config = globalThis.__pyrockCamoufoxConfig || {};
            if (config.beforeNewPage) await config.beforeNewPage(context);
            const page = makePage(context, 'shot');
            context.pages.push(page);
            state.pages.push(page);
            return page;
        };
        // A site that opens a link in a new tab (a session link, a popup) is
        // reported to the engine, which hands it to the section.
        context.openPopup = async (label = 'popup', url = 'https://example.test/session') => {
            const page = makePage(context, label, url);
            context.pages.push(page);
            state.pages.push(page);
            context.emit('page', page);
            return page;
        };
        context.close = async () => { context.closed = true; };
        state.contexts.push(context);
        return context;
    };
    return browser;
}

async function Camoufox(options) {
    const state = currentState();
    const config = globalThis.__pyrockCamoufoxConfig || {};
    const index = state.launches.length;
    if (config.beforeLaunch) await config.beforeLaunch(index);
    state.launches.push(options);
    const browser = config.makeBrowser ? await config.makeBrowser(index) : makeBrowser();
    state.browsers.push(browser);
    return browser;
}

module.exports = { Camoufox, reset, currentState, makeBrowser, makePage };
