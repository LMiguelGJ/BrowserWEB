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
