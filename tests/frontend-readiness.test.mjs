import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { TextDecoder, TextEncoder } from 'node:util';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});

async function boot() {
  const dom = new JSDOM(html, {
    url: 'https://ndiayeelage0508-cloud.github.io/mon-premier-site/',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.crypto = webcrypto;
  window.TextEncoder = TextEncoder;
  window.TextDecoder = TextDecoder;
  window.confirm = () => true;
  window.prompt = () => null;
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const copied = [];
  let clipboardFails = false;
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: {
      async writeText(value) {
        if (clipboardFails) throw new Error('clipboard unavailable');
        copied.push(value);
      },
    },
  });
  const opened = [];
  window.open = (...args) => opened.push(args);
  window.fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === '/api/auth/config') return response({ googleClientId: null });
    if (path === '/api/generate') return response({ result: 'Prompt généré pour mes études.' });
    if (path === '/api/optimize') return response({ result: 'Prompt optimisé.' });
    throw new Error(`Unexpected request to ${path}`);
  };
  window.eval(app);
  await tick(20);
  return { dom, window, copied, opened, failClipboard() { clipboardFails = true; } };
}

test('dialogues et champs de saisie ont des noms accessibles', async (t) => {
  const h = await boot();
  t.after(() => h.dom.window.close());
  const { document } = h.window;

  for (const id of ['settingsDialog', 'accountDialog', 'searchDialog']) {
    const dialog = document.getElementById(id);
    const title = document.getElementById(dialog.getAttribute('aria-labelledby'));
    assert.ok(title?.textContent.trim(), `${id} references a readable title`);
  }
  for (const id of ['searchInput', 'recoveryCode', 'recoveryPassword']) {
    assert.ok(document.querySelector(`label[for="${id}"]`), `${id} has a label`);
  }
  assert.equal(document.querySelector('[data-mode="generate"]').getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelector('[data-filter="all"]').getAttribute('aria-pressed'), 'true');

  document.querySelector('[data-mode="optimize"]').click();
  assert.equal(document.querySelector('[data-mode="optimize"]').getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelector('[data-mode="generate"]').getAttribute('aria-pressed'), 'false');
  document.querySelector('[data-account-mode="register"]').click();
  assert.equal(document.getElementById('accountPassword').getAttribute('autocomplete'), 'new-password');
  assert.equal(document.querySelector('[data-account-mode="register"]').getAttribute('aria-pressed'), 'true');
  document.querySelector('[data-account-mode="login"]').click();
  assert.equal(document.getElementById('accountPassword').getAttribute('autocomplete'), 'current-password');
});

test('le champ rapide explique le transfert d’une idée sans prétendre la sauvegarder', async (t) => {
  const h = await boot();
  t.after(() => h.dom.window.close());
  const { document } = h.window;
  document.getElementById('quickInput').value = 'Une idée à transformer';
  document.getElementById('quickAddBtn').click();
  assert.equal(document.getElementById('promptInput').value, 'Une idée à transformer');
  assert.equal(document.activeElement.id, 'promptInput');
  assert.match(document.getElementById('statusMessage').textContent, /placée dans Prompt Studio/);
  assert.equal(document.getElementById('quickInput').value, '');
});

test('la recherche ouvre un lien et copie un favori avec un retour en cas d’échec', async (t) => {
  const h = await boot();
  t.after(() => h.dom.window.close());
  const { document } = h.window;

  document.getElementById('promptInput').value = 'Explique les fractions';
  document.getElementById('runAiBtn').click();
  await tick(20);
  document.getElementById('saveFavoriteBtn').click();
  document.getElementById('linkTitle').value = 'Guide de révision';
  document.getElementById('linkUrl').value = 'https://example.org/guide';
  document.getElementById('linkForm').dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));

  document.getElementById('searchBtn').click();
  const search = document.getElementById('searchInput');
  search.value = 'guide';
  search.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  const open = document.querySelector('#searchResults [data-action="open"]');
  assert.ok(open, 'link search results have an open action');
  open.click();
  assert.equal(h.opened[0][0], 'https://example.org/guide');

  search.value = 'Prompt généré';
  search.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  const copy = document.querySelector('#searchResults [data-action="copy-fav"]');
  assert.ok(copy, 'favorite search results have a copy action');
  copy.click();
  await tick();
  assert.deepEqual(h.copied, ['Prompt généré pour mes études.']);
  assert.match(document.getElementById('statusMessage').textContent, /Prompt copié/);

  h.failClipboard();
  copy.click();
  await tick();
  assert.match(document.getElementById('statusMessage').textContent, /Copie indisponible/);
  assert.equal(document.getElementById('statusMessage').classList.contains('error'), true);
});
