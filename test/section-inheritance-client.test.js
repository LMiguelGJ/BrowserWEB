const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createScriptHarness } = require('./helpers/client-harness');

const START = 'https://browser.lol/';
const tick = () => new Promise(resolve => setImmediate(resolve));

async function addSection(h, name = 'Nueva') {
  h.elements.get('sessionAdd').dispatch('click');
  const input = h.elements.get('sessionList').children[0].children[0];
  input.value = name;
  input.dispatch('keydown', { key: 'Enter' });
  await tick(); await tick();
}

test('a section still on about:blank shows the start page published by the server', async () => {
  const h = createScriptHarness({ sessions: [{ id: 's1', name: 'One', url: 'about:blank' }], startUrl: START });
  await h.load();
  assert.equal(h.elements.get('urlInput').value, START);
});

test('a section without url shows the start page, and a real url wins once the page loads', async () => {
  const sessions = [{ id: 's1', name: 'One', url: '' }];
  const h = createScriptHarness({ sessions, startUrl: START });
  await h.load();
  assert.equal(h.elements.get('urlInput').value, START);
  sessions[0].url = 'https://real.test/page';
  await h.api().refreshSessions();
  assert.equal(h.elements.get('urlInput').value, 'https://real.test/page');
});

test('the markup carries no invented url or typed text', () => {
  const html = fs.readFileSync('public/index.html', 'utf8');
  assert.doesNotMatch(html, /id="typeText"[^>]*value=/);
  assert.doesNotMatch(html, /id="urlInput"[^>]*value=/);
  assert.doesNotMatch(html, /id="urlInput"[\s\S]{0,120}value="https:\/\/example\.com/);
});

test('typing with an empty field sends nothing instead of falling back to a canned word', async () => {
  const h = createScriptHarness({ startUrl: START });
  await h.load();
  h.elements.get('typeText').value = '';
  await h.api().sendType();
  assert.equal(h.operations.some(x => x[0] === 'type'), false);
  h.elements.get('typeText').value = 'abc';
  await h.api().sendType();
  assert.ok(h.operations.some(x => x[0] === 'type' && x[2] === 'abc'));
});

test('a new section inherits the navigation and keyboard values and navigates to that page', async () => {
  const h = createScriptHarness({ sessions: [{ id: 's1', name: 'One', url: 'https://site.test/page' }], startUrl: START });
  await h.load();
  h.elements.get('urlInput').value = 'https://site.test/page';
  h.elements.get('typeText').value = 'usuario';
  await addSection(h);
  assert.ok(h.operations.some(x => x[0] === 'navigate' && x[1] === 's2' && x[2] === 'https://site.test/page'), 'the new section navigates to the inherited page');
  assert.equal(h.elements.get('urlInput').value, 'https://site.test/page');
  assert.equal(h.elements.get('typeText').value, 'usuario');
  assert.equal(h.operations.some(x => x[0] === 'type'), false, 'the typed text is copied to the field, not written into the page');
});

test('the inherited page is not replaced by about:blank while the new section loads', async () => {
  const h = createScriptHarness({ sessions: [{ id: 's1', name: 'One', url: 'https://site.test/page' }], startUrl: START });
  await h.load();
  h.elements.get('urlInput').value = 'https://site.test/page';
  await addSection(h);
  await h.api().refreshSessions();
  assert.equal(h.elements.get('urlInput').value, 'https://site.test/page');
});

test('with nothing to inherit the new section keeps the start page and does not navigate', async () => {
  const h = createScriptHarness({ sessions: [{ id: 's1', name: 'One', url: 'about:blank' }], startUrl: START });
  await h.load();
  h.elements.get('urlInput').value = '';
  await addSection(h);
  assert.equal(h.operations.some(x => x[0] === 'navigate'), false);
  assert.equal(h.elements.get('urlInput').value, START);
});

test('an about:blank value in the field is never inherited', async () => {
  const h = createScriptHarness({ sessions: [{ id: 's1', name: 'One', url: 'https://site.test/page' }], startUrl: START });
  await h.load();
  h.elements.get('urlInput').value = 'about:blank';
  await addSection(h);
  assert.equal(h.operations.some(x => x[0] === 'navigate'), false);
  assert.equal(h.elements.get('urlInput').value, START);
});
