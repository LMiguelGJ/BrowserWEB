'use strict';
// Resolves the Chromium build the tests run against.
//
// playwright-core ships no browser of its own, and Puppeteer is kept as a
// devDependency precisely for the Chromium it downloads into its cache.
//
// `puppeteer.executablePath()` echoes PUPPETEER_EXECUTABLE_PATH without
// checking that the file exists, and that variable commonly points at a
// container path (e.g. /usr/bin/chromium-browser). So: trust it only when it
// exists, otherwise find the real download.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function exists(candidate) {
    try { return !!candidate && fs.existsSync(candidate); } catch { return false; }
}

function chromiumExecutable() {
    const configured = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (exists(configured)) return configured;

    try {
        const puppeteer = require('puppeteer');
        const fromPuppeteer = puppeteer.executablePath();
        if (exists(fromPuppeteer)) return fromPuppeteer;
    } catch { /* puppeteer is optional at runtime */ }

    const cacheRoot = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
    const candidates = [];
    try {
        for (const build of fs.readdirSync(cacheRoot)) {
            const base = path.join(cacheRoot, build);
            candidates.push(
                path.join(base, 'chrome-win64', 'chrome.exe'),
                path.join(base, 'chrome-linux64', 'chrome'),
                path.join(base, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
                path.join(base, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
            );
        }
    } catch { /* no puppeteer cache on this machine */ }
    return candidates.find(exists);
}

module.exports = { chromiumExecutable };
