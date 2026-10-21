'use strict';

const { createContextCloser } = require('./network/close-context');

function createSessionManager({ openPage, closeContext, createController, onClosed, onReady, maxSessions = 0, logger = null }) {
    if (typeof openPage !== 'function' || typeof closeContext !== 'function' || typeof createController !== 'function') {
        throw new TypeError('openPage, closeContext and createController are required');
    }
    // Un tope de 0 (o ausente) significa sin límite.
    const limit = Number.isInteger(maxSessions) && maxSessions > 0 ? maxSessions : Infinity;
    const sessions = new Map();
    let nextId = 1;
    let queue = Promise.resolve();
    let closed = false;
    const serialize = operation => {
        const result = queue.then(operation, operation);
        queue = result.catch(() => {});
        return result;
    };
    const publicSession = section => ({
        id: section.id,
        name: section.name,
        url: section.page?.url?.() || section.page?.currentUrl?.() || '',
        previewMode: section.page?.previewMode?.() || null,
        diagnosis: section.diagnosis || null,
        state: section.state
    });
    const get = id => sessions.get(id) || null;
    const defaultSection = () => sessions.values().next().value || null;
    // A context that could not be released keeps consuming browser memory with
    // nobody watching it: the section is already gone from the map, so the
    // failure is kept here instead of being swallowed.
    const closer = createContextCloser({ close: closeContext, logger });
    async function closeSectionContext(section) {
        const outcome = await closer.closeOnce(section.context, section.id);
        if (outcome.closed) section.context = null;
        return outcome;
    }
    async function dispose(section, { closeController = true } = {}) {
        try {
            if (closeController && section.controller) await section.controller.close();
            else if (section.controller?.setUnavailable) await section.controller.setUnavailable('Browser is restarting');
        } finally {
            await closeSectionContext(section);
        }
    }
    // Adopts a page the site opened itself (a session link, a popup): the
    // section follows it, so the preview shows where the site actually went.
    async function adoptPage(section, page) {
        if (!page || section.page === page) return section;
        section.page = page;
        if (section.controller?.setPage) await section.controller.setPage(page);
        page?.once?.('close', () => {
            if (section.page !== page) return;
            section.state = 'unavailable';
            Promise.resolve(section.controller?.setUnavailable?.('Browser page closed')).catch(() => {});
        });
        section.lastScreenshot = null;
        section.state = 'ready';
        return section;
    }
    async function open(section, reason) {
        const opened = await openPage(section, { reason });
        if (closed) {
            if (opened?.context) await closeContext(opened.context);
            throw Object.assign(new Error('Browser is shutting down'), { status: 503 });
        }
        section.context = opened.context;
        section.page = opened.page;
        if (section.controller?.setPage) await section.controller.setPage(section.page);
        else section.controller = createController(section);
        const page = section.page;
        page?.once?.('close', () => {
            if (section.page !== page) return;
            section.state = 'unavailable';
            Promise.resolve(section.controller?.setUnavailable?.('Browser page closed')).catch(() => {});
        });
        section.lastScreenshot = null;
        section.state = 'ready';
        // The section is ready: whatever the app wants to do first (open the
        // start page, for instance) happens now that there is a page to use.
        await onReady?.(section, reason);
        return section;
    }
    // A listener that fails must never stop a section from closing.
    const announceClosed = async section => {
        try { await onClosed?.(section); } catch { /* the section is already gone */ }
    };
    return {
        list() { return [...sessions.values()].map(publicSession); },
        get,
        getDefault: defaultSection,
        // The id the next section will get, without consuming it.
        peekNextId() { return `s${nextId}`; },
        async create({ name } = {}) {
            return serialize(async () => {
                if (closed) throw Object.assign(new Error('Browser is shutting down'), { status: 503 });
                if (name !== undefined && (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 24)) {
                    throw Object.assign(new Error('Nombre de sección inválido'), { status: 400 });
                }
                if (sessions.size >= limit) throw Object.assign(new Error('Límite de secciones alcanzado'), { status: 409 });
                const number = nextId++;
                const section = { id: `s${number}`, name: name === undefined ? `Sección ${number}` : name.trim(), context: null, page: null, controller: null, lastScreenshot: null, state: 'unavailable' };
                await open(section, 'create');
                sessions.set(section.id, section);
                return section;
            });
        },
        async close(id) {
            return serialize(async () => {
                const section = get(id);
                if (!section) throw Object.assign(new Error('Sección no encontrada'), { status: 404 });
                if (sessions.size <= 1) throw Object.assign(new Error('No se puede cerrar la última sección'), { status: 409 });
                sessions.delete(id);
                try { await dispose(section); }
                finally { await announceClosed(section); }
                return true;
            });
        },
        // Releases the browser context of a section but keeps the section: its
        // id, name and preview viewers stay while the exit is being replaced.
        async suspend(id) {
            return serialize(async () => {
                const section = get(id);
                if (!section) throw Object.assign(new Error('Sección no encontrada'), { status: 404 });
                await dispose(section, { closeController: false });
                section.context = section.page = null;
                section.state = 'unavailable';
                return section;
            });
        },
        async resume(id) {
            return serialize(async () => {
                const section = get(id);
                if (!section) throw Object.assign(new Error('Sección no encontrada'), { status: 404 });
                return open(section, 'resume');
            });
        },
        async restart(id) {
            return serialize(async () => {
                const section = get(id);
                if (!section) throw Object.assign(new Error('Sección no encontrada'), { status: 404 });
                await dispose(section, { closeController: false });
                section.context = section.page = null;
                section.state = 'unavailable';
                return open(section, 'restart');
            });
        },
        async restartAll() {
            return serialize(async () => {
                const existing = [...sessions.values()];
                for (const section of existing) {
                    await dispose(section, { closeController: false });
                    section.context = section.page = null;
                    section.state = 'unavailable';
                }
                for (const section of existing) await open(section, 'restart');
                return true;
            });
        },
        adopt(section, page) {
            return adoptPage(section, page);
        },
        markUnavailable() {
            for (const section of sessions.values()) {
                section.state = 'unavailable';
                if (section.controller?.setUnavailable) section.controller.setUnavailable('Browser disconnected').catch(() => {});
            }
        },
        // A copy: the diagnostics endpoint reads it without being able to
        // mutate the registry.
        closeFailures: () => closer.failures().map(({ owner, ...rest }) => ({ id: owner, ...rest })),
        // How many sections still hold a browser context: every one of them is
        // browser memory the diagnostics endpoint has to account for.
        liveContexts: () => [...sessions.values()].filter(section => section.context).length,
        async closeAll() {
            return serialize(async () => {
                closed = true;
                const existing = [...sessions.values()];
                sessions.clear();
                let firstError = null;
                for (const section of existing) {
                    try { await dispose(section); } catch (error) { firstError ||= error; }
                    await announceClosed(section);
                }
                if (firstError) throw firstError;
            });
        }
    };
}

module.exports = { createSessionManager };
