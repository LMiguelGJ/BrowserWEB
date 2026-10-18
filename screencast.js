'use strict';

const WebSocket = require('ws');

const OPEN = WebSocket.OPEN ?? 1;
const SCREENCAST_OPTIONS = {
    format: 'jpeg',
    quality: 60,
    maxWidth: 1366,
    maxHeight: 768,
    everyNthFrame: 1
};

function isClosedTargetError(error) {
    return /\b(?:target|session)\s+(?:is\s+)?(?:closed|detached)\b|\b(?:closed|detached)\s+(?:target|session)\b/i.test(error?.message || '');
}

function createScreencastController({ getPage = () => null, ackTimeoutMs = 10_000, timers = globalThis } = {}) {
    const viewers = new Map();
    let page = null;
    let available = true;
    let session = null;
    let frameListener = null;
    let producerPage = null;
    let generation = 0;
    let pendingFrame = null;
    let nextFrameId = 0;
    let closed = false;
    let serial = Promise.resolve();

    const enqueue = operation => {
        const result = serial.then(operation, operation);
        serial = result.catch(() => {});
        return result;
    };

    function sendJson(socket, message) {
        if (socket.readyState !== OPEN) return false;
        try {
            if (socket.bufferedAmount > 1024 * 1024) return false;
            socket.send(JSON.stringify(message));
            return true;
        } catch {
            return false;
        }
    }

    function status(state, message) {
        for (const socket of viewers.keys()) sendJson(socket, { type: 'status', state, ...(message ? { message } : {}) });
    }

    function clearOutstanding(viewer) {
        if (viewer.timer !== null) timers.clearTimeout(viewer.timer);
        if (viewer.bufferedRetryTimer !== null) timers.clearTimeout(viewer.bufferedRetryTimer);
        viewer.timer = null;
        viewer.bufferedRetryTimer = null;
        viewer.outstanding = null;
    }

    function scheduleBufferedRetry(socket, viewer) {
        if (viewer.bufferedRetryTimer !== null || viewers.get(socket) !== viewer) return;
        viewer.bufferedRetryTimer = timers.setTimeout(() => {
            viewer.bufferedRetryTimer = null;
            offerFrame(socket, viewer);
        }, 100);
        viewer.bufferedRetryTimer?.unref?.();
    }

    function offerFrame(socket, viewer) {
        if (viewers.get(socket) !== viewer || !pendingFrame || viewer.outstanding !== null || socket.readyState !== OPEN) return;
        if (socket.bufferedAmount > 1024 * 1024) {
            scheduleBufferedRetry(socket, viewer);
            return;
        }
        const frame = pendingFrame;
        if (frame.id <= viewer.lastDeliveredId) return;
        const sent = sendJson(socket, { type: 'frame', id: frame.id, data: frame.data });
        if (!sent) return;
        viewer.outstanding = frame.id;
        viewer.lastDeliveredId = frame.id;
        viewer.timer = timers.setTimeout(() => {
            if (viewer.outstanding !== frame.id) return;
            clearOutstanding(viewer);
            try { socket.close(4000, 'Preview render acknowledgement timed out'); } catch {}
        }, ackTimeoutMs);
        viewer.timer?.unref?.();
    }

    function offerLatest() {
        for (const [socket, viewer] of viewers) offerFrame(socket, viewer);
    }

    function onFrame(owningSession, owningGeneration, event) {
        Promise.resolve(owningSession.send('Page.screencastFrameAck', { sessionId: event.sessionId }))
            .catch(error => {
                if (!closed && session === owningSession && generation === owningGeneration) {
                    status('unavailable', `Frame acknowledgement failed: ${error.message}`);
                }
            });
        if (session !== owningSession || generation !== owningGeneration || !available || typeof event.data !== 'string') return;
        pendingFrame = { id: ++nextFrameId, data: `data:image/jpeg;base64,${event.data}` };
        offerLatest();
    }

    async function stopProducer() {
        const oldSession = session;
        const oldPage = producerPage;
        const oldListener = frameListener;
        generation += 1;
        session = null;
        producerPage = null;
        frameListener = null;
        pendingFrame = null;
        let failure = null;
        if (oldSession && oldListener) {
            try { oldSession.off('Page.screencastFrame', oldListener); }
            catch {
                try { oldSession.removeListener('Page.screencastFrame', oldListener); }
                catch (error) { failure = error; }
            }
        }
        if (oldSession) {
            try { await oldSession.send('Page.stopScreencast'); }
            catch (error) {
                if (!isClosedTargetError(error)) failure ||= error;
            } finally {
                try { await oldSession.detach(); }
                catch (error) {
                    if (!isClosedTargetError(error)) failure ||= error;
                }
            }
        }
        if (failure) throw failure;
        return oldPage;
    }

    async function startProducer() {
        if (closed || !available || viewers.size === 0 || session) return;
        const candidate = page || getPage();
        if (!candidate || (typeof candidate.isClosed === 'function' && candidate.isClosed())) {
            status('unavailable', 'Browser page is unavailable');
            return;
        }
        status('starting');
        const producerGeneration = ++generation;
        let cdp;
        try {
            cdp = await candidate.createCDPSession();
            if (closed || !available || viewers.size === 0 || (page && page !== candidate)) {
                await cdp.detach();
                return;
            }
            const listener = event => onFrame(cdp, producerGeneration, event);
            cdp.on('Page.screencastFrame', listener);
            // Publish producer state before start so events emitted during the command can be ACKed.
            session = cdp;
            producerPage = candidate;
            frameListener = listener;
            await cdp.send('Page.startScreencast', SCREENCAST_OPTIONS);
            if (session !== cdp || !available) return;
            status('live');
        } catch (error) {
            let reportedError = error;
            if (session === cdp) {
                try { await stopProducer(); }
                catch (cleanupError) {
                    reportedError = new AggregateError([error, cleanupError], 'Preview start and cleanup failed');
                }
            }
            if (!closed) {
                status('unavailable', reportedError.message || 'Unable to start preview');
                for (const socket of viewers.keys()) sendJson(socket, { type: 'error', message: reportedError.message || 'Unable to start preview' });
            }
        }
    }

    async function reconcile() {
        if (closed || !available || viewers.size === 0) {
            await stopProducer();
            return;
        }
        const candidate = page || getPage();
        if (session && producerPage === candidate) return;
        await stopProducer();
        if (!closed && available && viewers.size > 0) await startProducer();
    }

    function detachViewer(socket) {
        const viewer = viewers.get(socket);
        if (!viewer) return;
        clearOutstanding(viewer);
        viewers.delete(socket);
        if (viewers.size === 0) enqueue(() => stopProducer()).catch(() => {});
    }

    function addViewer(socket) {
        if (closed || viewers.has(socket)) return;
        const viewer = { outstanding: null, timer: null, bufferedRetryTimer: null, lastDeliveredId: 0 };
        viewers.set(socket, viewer);
        socket.on('message', raw => {
            if (Buffer.byteLength(raw) > 1024) return;
            let message;
            try { message = JSON.parse(raw.toString()); } catch { return; }
            if (!message || message.type !== 'ack' || !Number.isSafeInteger(message.id)) return;
            if (viewer.outstanding !== message.id) return;
            clearOutstanding(viewer);
            offerFrame(socket, viewer);
        });
        socket.once('close', () => detachViewer(socket));
        socket.once('error', () => detachViewer(socket));
        sendJson(socket, { type: 'status', state: available ? (session ? 'live' : 'starting') : 'unavailable', ...(!available ? { message: 'Browser is restarting' } : {}) });
        if (session && pendingFrame) offerFrame(socket, viewer);
        enqueue(reconcile).catch(error => {
            status('unavailable', error.message || 'Preview lifecycle failed');
        });
    }

    function setUnavailable(message = 'Browser is unavailable') {
        available = false;
        status('unavailable', message);
        return enqueue(async () => {
            for (const viewer of viewers.values()) clearOutstanding(viewer);
            await stopProducer();
        });
    }

    function setPage(nextPage) {
        page = nextPage || null;
        available = !!nextPage;
        return enqueue(async () => {
            for (const viewer of viewers.values()) clearOutstanding(viewer);
            await stopProducer();
            if (available && viewers.size) await startProducer();
            else if (!available) status('unavailable', 'Browser page is unavailable');
        });
    }

    function close() {
        if (closed) return serial;
        closed = true;
        available = false;
        for (const [socket, viewer] of viewers) {
            clearOutstanding(viewer);
            try { socket.close(1001, 'Preview server shutting down'); } catch {}
        }
        viewers.clear();
        return enqueue(stopProducer);
    }

    return { addViewer, setUnavailable, setPage, close };
}

module.exports = { createScreencastController };
