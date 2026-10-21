'use strict';

// Closing a browser context can fail for a reason worth one more try (the
// context is still busy). A context the browser already closed throws when it
// is closed again, and that is the outcome we wanted, not a failure.
// A context that stays alive keeps consuming browser memory with nobody
// watching it, so every exhausted close is logged and kept, bounded, for the
// diagnostics endpoint.
const ATTEMPTS = 2;
const MAX_FAILURES = 50;

function alreadyClosed(error) {
    return /closed|detached|target closed|has been closed/i.test(String(error?.message || ''));
}

function createContextCloser({ close, logger = null, maxFailures = MAX_FAILURES } = {}) {
    if (typeof close !== 'function') throw new TypeError('close is required');
    const failures = [];
    const warn = typeof logger?.warn === 'function' ? message => logger.warn(message) : message => console.warn(message);
    return {
        async closeOnce(context, owner = 'sección') {
            if (!context) return { closed: true, attempts: 0 };
            for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
                try {
                    await close(context);
                    return { closed: true, attempts: attempt };
                } catch (error) {
                    if (alreadyClosed(error)) return { closed: true, attempts: attempt, alreadyClosed: true };
                    if (attempt === ATTEMPTS) {
                        const entry = { owner, message: String(error?.message || error), at: new Date().toISOString() };
                        failures.push(entry);
                        while (failures.length > maxFailures) failures.shift();
                        warn(`no se pudo cerrar el contexto de ${owner}: ${entry.message}`);
                        return { closed: false, attempts: attempt, error: entry.message };
                    }
                }
            }
        },
        // A copy: the caller can read the registry without mutating it.
        failures: () => failures.map(entry => ({ ...entry })),
        attempts: ATTEMPTS
    };
}

module.exports = { createContextCloser, alreadyClosed, ATTEMPTS, MAX_FAILURES };