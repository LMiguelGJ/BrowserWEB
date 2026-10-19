'use strict';
// Fake `camoufox-js` module used through the PYROCK_CAMOUFOX_MODULE test seam.
// It behaves like a Playwright Firefox browser: contexts, pages, mouse, keyboard,
// screenshots and (optionally) page.screencast.
const { EventEmitter } = require('node:events');

const state = { launches: [], contexts: [], pages: [] };

async function Camoufox(options) {
    state.launches.push(options);
    const browser = new EventEmitter();
    browser.close = async () => { browser.emit('disconnected'); };
    browser.newContext = async () => {
        const context = { closed: false, close: async () => { context.closed = true; } };
        context.newPage = async () => {
            const page = { calls: [], closed: false };
            page.isClosed = () => page.closed;
            page.setViewportSize = async size => page.calls.push(['setViewportSize', size]);
            page.goto = async url => { page.calls.push(['goto', url]); return { status: () => 200 }; };
            page.screenshot = async () => Buffer.from('shot');
            page.mouse = {
                move: async (...args) => page.calls.push(['move', ...args]),
                click: async (...args) => page.calls.push(['click', ...args])
            };
            page.keyboard = {
                type: async value => page.calls.push(['type', value]),
                press: async value => page.calls.push(['key', value])
            };
            state.pages.push(page);
            return page;
        };
        state.contexts.push(context);
        return context;
    };
    return browser;
}

module.exports = { Camoufox, state };
