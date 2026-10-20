'use strict';
// The panel must show where the section really is, must not overwrite what the
// operator is typing, and must say why a page is not visible.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScriptHarness } = require('./helpers/client-harness');

function harnessWith(sessions) {
    return createScriptHarness({ sessions, defaultId: sessions[0]?.id, max: 5 });
}

test('the url field follows the section to the tab it adopted', async () => {
    const sessions = [{ id: 's1', name: 'Sección 1', url: 'https://browser.lol/es/create' }];
    const h = harnessWith(sessions);
    await h.load();
    await h.api().refreshSessions();
    assert.equal(h.elements.get('urlInput').value, 'https://browser.lol/es/create');
    // El sitio abre la pestaña de la sesión: la sección cambia de URL sola.
    sessions[0].url = 'https://browser.lol/es/viewer';
    await h.api().refreshSessions();
    assert.equal(h.elements.get('urlInput').value, 'https://browser.lol/es/viewer');
    const logged = h.elements.get('logContainer').children.map(entry => entry.textContent).join('\n');
    assert.match(logged, /pestaña nueva/i, 'the panel says it followed another tab');
    assert.match(logged, /browser\.lol/);
});

test('the url field is not overwritten while the operator is typing', async () => {
    const sessions = [{ id: 's1', name: 'Sección 1', url: 'https://browser.lol/es/create' }];
    const h = harnessWith(sessions);
    await h.load();
    await h.api().refreshSessions();
    const field = h.elements.get('urlInput');
    field.value = 'https://a-medio-de-editar';
    field.focus();
    sessions[0].url = 'https://browser.lol/es/viewer';
    await h.api().refreshSessions();
    assert.equal(field.value, 'https://a-medio-de-editar', 'what the operator typed wins');
});

test('the hint names the request that never finished', async () => {
    const h = harnessWith([{ id: 's1', name: 'Sección 1', url: '' }]);
    await h.load();
    h.api().showDiagnosis({
        readyState: 'loading',
        textLength: 0,
        spinnerish: 1,
        pending: ['https://cdn.intergient.com/cdn-cgi/challenge-platform/main.js']
    });
    const hint = h.elements.get('previewHint');
    assert.equal(hint.hidden, false, 'the hint is visible');
    assert.match(hint.textContent, /cargando/i);
    assert.match(hint.textContent, /intergient\.com/);
});

test('the hint says when the page loaded but shows nothing', async () => {
    const h = harnessWith([{ id: 's1', name: 'Sección 1', url: '' }]);
    await h.load();
    h.api().showDiagnosis({ readyState: 'complete', textLength: 0, spinnerish: 0, pending: [] });
    const hint = h.elements.get('previewHint');
    assert.equal(hint.hidden, false);
    assert.match(hint.textContent, /no muestra nada/i);
});

test('the monitor header says how the preview runs', async () => {
    const h = harnessWith([{ id: 's1', name: 'Sección 1', url: '' }]);
    await h.load();
    h.api().showPreviewMode('poll');
    assert.equal(h.elements.get('previewMode').textContent, 'sondeo de capturas');
    h.api().showPreviewMode('screencast');
    assert.equal(h.elements.get('previewMode').textContent, 'screencast');
});

test('the list is not rebuilt when nothing changed, so a pending close confirmation survives', async () => {
    const sessions = [{ id: 's1', name: 'Sección 1', url: 'https://browser.lol/es/create' }];
    const h = harnessWith(sessions);
    await h.load();
    await h.api().refreshSessions();
    const list = h.elements.get('sessionList');
    const firstChild = list.children[0];
    await h.api().refreshSessions();
    assert.equal(list.children[0], firstChild, 'the same row survives a refresh that changes nothing');
});

test('the network panel shows the exit, the mode and one row per section', async () => {
    const h = createScriptHarness({
        network: {
            configured: true, host: 'gw.example', port: '823', mode: 'sticky', stickyBase: 10000,
            credentials: 'user:••••••••',
            sections: [
                { id: 's1', name: 'Sección 1', proxy: 'http://gw.example:10001', port: 10001, ipCount: 3, ip: '157.34.27.193', measuredAt: '2026-10-19T19:40:12.000Z' },
                { id: 's2', name: 'Sección 2', proxy: 'http://gw.example:10002', port: 10002, ip: null, measuredAt: null },
                { id: 's3', name: 'Sección 3', port: 10003, ip: '203.0.113.8', measurementError: 'No se pudo medir la IP; intentá nuevamente.' }
            ]
        }
    });
    await h.load();
    await h.api().renderNetwork();
    const body = h.elements.get('netBody');
    const text = body.children.map(child => child.children.map(inner => inner.textContent).join(' ')).join('\n');
    assert.match(text, /gw\.example/, 'the proxy host is shown');
    assert.match(text, /sticky/i, 'the mode is shown');
    assert.match(text, /157\.34\.27\.193/, 'the measured IP is shown');
    assert.match(text, /Sección 2/, 'every section has a row');
    assert.match(text, /IP sin medir/, 'a configured port must not hide a missing IP');
    assert.match(text, /Medición fallida.*Última IP: 203\.0\.113\.8/, 'a previous IP is not presented as a successful new measurement');
    assert.match(text, /puerto 10001/, 'the section shows the port it leaves through');
    assert.match(text, /3 IPs distintas/, 'the panel says when the exit is rotating');
    assert.doesNotMatch(text, /secret/i, 'the password is never rendered');
});

test('the network panel measures the sections with no IP and warns about a rotating exit', async () => {
    const calls = [];
    const answer = {
        configured: true, host: 'gw.example', port: '823', mode: 'rotating', stickyBase: null,
        credentials: 'user:••••••••',
        sections: [{ id: 's1', name: 'Sección 1', proxy: 'http://gw.example:823', port: 823, ip: null, measuredAt: null }]
    };
    const h = createScriptHarness({
        network: (path) => { calls.push(path); return answer; }
    });
    await h.load();
    await h.api().openNetworkPanel();
    assert.ok(calls.includes('/api/network/measure'), 'a section without an IP is measured on its own');
    const body = h.elements.get('netBody');
    // Un aviso es un div sin hijos: su texto está en el propio nodo.
    const text = body.children.map(child => (child.children.length ? child.children.map(inner => inner.textContent).join(' ') : child.textContent)).join('\n');
    assert.match(text, /Modo rotativo/, 'the panel explains that the IP changes on every request');
    assert.match(text, /PYROCK_PROXY_STICKY_BASE/, 'and says how to get a fixed IP per section');
});

test('the hybrid network panel explains the provider, waiting reason, and reconnection limits', async () => {
    const h = createScriptHarness({
        network: {
            mode: 'hybrid', pool: { status: 'empty' }, fallbackConfigured: true,
            sections: [
                { id: 's1', name: 'Gratis', provider: 'free', state: 'connected', proxy: 'http://8.8.4.4:3128', port: 3128, ip: '8.8.4.4', measuredAt: '2026-10-19T19:40:12.000Z' },
                { id: 's2', name: 'Respaldo', provider: 'dataimpulse', state: 'connected', proxy: 'http://gw.example:10002', port: 10002, ip: '5.5.5.5', reason: 'pool_empty' },
                { id: 's3', name: 'Esperando', provider: null, state: 'waiting', reason: 'fallback_unavailable', freeReason: 'pool_unavailable', ip: null }
            ]
        }
    });
    await h.load();
    await h.api().renderNetwork();
    const body = h.elements.get('netBody');
    const text = body.children.map(child => child.children.length
        ? child.children.map(inner => inner.textContent).join(' ')
        : child.textContent).join('\n');
    assert.match(text, /híbrido/i);
    assert.match(text, /Gratis/i);
    assert.match(text, /DataImpulse.*consume saldo/i);
    assert.match(text, /esperando/i);
    assert.match(text, /fallback_unavailable/i);
    assert.match(text, /5\.5\.5\.5/);
    assert.match(text, /puede recargar/i, 'the operator is warned about the continuity limit');
    assert.doesNotMatch(text, /user:|pw@/i);
});

test('the hybrid panel polls every five seconds only while open and cancels on close', async () => {
    const calls = [];
    const h = createScriptHarness({ network: path => {
        calls.push(path);
        return { mode: 'hybrid', pool: { status: 'ok' }, sections: [] };
    } });
    await h.load();
    h.api().togglePanel('netPanel');
    await Promise.resolve();
    const panelTimer = h.intervals.find(timer => timer.delay === 5000);
    assert.ok(panelTimer, 'the open panel schedules a five-second refresh');
    const before = calls.length;
    await panelTimer.fn();
    assert.equal(calls.length, before + 1, 'an open panel refreshes status');
    h.document.dispatch('keydown', { key: 'Escape' });
    assert.equal(panelTimer.cancelled, true, 'closing Red clears its interval');
    const afterClose = calls.length;
    await panelTimer.fn();
    assert.equal(calls.length, afterClose, 'a closed panel performs no polling');
});

test('the network panel does not measure again when every section already has an IP', async () => {
    const calls = [];
    const h = createScriptHarness({
        network: (path) => {
            calls.push(path);
            return {
                configured: true, host: 'gw.example', port: '823', mode: 'sticky', stickyBase: 10000,
                sections: [{ id: 's1', name: 'Sección 1', port: 10001, ip: '157.34.27.193', measuredAt: '2026-10-19T19:40:12.000Z' }]
            };
        }
    });
    await h.load();
    await h.api().openNetworkPanel();
    assert.ok(!calls.includes('/api/network/measure'), 'a known IP is not measured again');
});
