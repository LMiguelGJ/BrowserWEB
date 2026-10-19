'use strict';
// A `camoufox-js`-shaped module that launches a REAL browser through Playwright.
//
// It exists so the integration tests exercise the migrated engine path (the
// Playwright adapter, the CDP-compatible screencast bridge, context isolation,
// browser-loss recovery) against a real browser, without downloading the ~1.3 GB
// Camoufox binary.
//
// The Chromium build comes from Puppeteer's cache (a devDependency), because
// playwright-core ships no browser of its own.
//
// The browser is launched directly (not through launchServer + connect) so that
// closing it also reaps the process: a lingering Playwright transport keeps the
// test process alive and the whole suite hangs.
//
// The Camoufox binary itself remains unverified locally; see the tracker.
const { chromium } = require('playwright-core');
const { chromiumExecutable } = require('../helpers/chromium-binary');

async function Camoufox(options = {}) {
    const browser = await chromium.launch({
        executablePath: chromiumExecutable(),
        headless: options.headless === 'virtual' ? true : options.headless !== false,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    // The test closes this browser to simulate the browser going away.
    globalThis.__pyrockPlaywrightBrowser = browser;
    return browser;
}

// Releases the browser and its process, so the test process can exit.
async function stop() {
    const browser = globalThis.__pyrockPlaywrightBrowser;
    if (!browser) return;
    try { await browser.close(); } catch { /* already gone */ }
    globalThis.__pyrockPlaywrightBrowser = undefined;
}

module.exports = { Camoufox, stop };
