'use strict';

// What a section keeps when its exit is replaced: cookies, local and session
// storage and the page it was on. Held in memory only, never persisted and
// never logged: it can contain a login.

function webUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch { return null; }
}

async function withTimeout(promise, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); })
        ]);
    } finally { clearTimeout(timer); }
}

// Reads whatever it can. A page that is dead or stuck cannot block the
// recovery: every read has its own limit and a failed one just stays empty.
async function captureSnapshot(section, { timeoutMs = 3000 } = {}) {
    const snapshot = { url: null, storageState: null, sessionStorage: null, capturedAt: new Date().toISOString() };
    try { snapshot.url = webUrl(section.page?.currentUrl?.() ?? section.page?.url?.()); } catch { /* stays empty */ }
    try {
        snapshot.storageState = (await withTimeout(Promise.resolve(section.context?.storageState?.()), timeoutMs)) || null;
    } catch { /* stays empty */ }
    try {
        const data = await withTimeout(Promise.resolve(section.page?.evaluate?.(() => ({
            origin: location.origin, items: Object.fromEntries(Object.entries(sessionStorage))
        }))), timeoutMs);
        if (data && webUrl(data.origin) && data.items && Object.keys(data.items).length) snapshot.sessionStorage = data;
    } catch { /* stays empty */ }
    return snapshot;
}

// A fresh capture only replaces what it could actually read.
function mergeSnapshots(fresh, last) {
    if (!fresh) return last || null;
    if (!last) return fresh;
    return {
        url: fresh.url || last.url,
        storageState: fresh.storageState || last.storageState,
        sessionStorage: fresh.sessionStorage || last.sessionStorage,
        capturedAt: fresh.capturedAt
    };
}

// Puts the section back where it was: a plain GET of the old page, never a
// replay of clicks, typing or form submissions.
async function restoreSnapshot(section, snapshot, { timeoutMs = 45000 } = {}) {
    const result = { navigated: false, sessionStorage: false };
    if (!snapshot) return result;
    if (snapshot.sessionStorage && section.context?.addInitScript) {
        try {
            await section.context.addInitScript(({ origin, items }) => {
                if (location.origin !== origin) return;
                for (const [key, value] of Object.entries(items)) sessionStorage.setItem(key, value);
            }, snapshot.sessionStorage);
            result.sessionStorage = true;
        } catch { /* the page still opens without it */ }
    }
    if (snapshot.url && section.page) {
        try {
            await section.page.goto(snapshot.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
            result.navigated = true;
        } catch { /* the section stays on a blank page and says so */ }
    }
    return result;
}

module.exports = { captureSnapshot, mergeSnapshots, restoreSnapshot };
