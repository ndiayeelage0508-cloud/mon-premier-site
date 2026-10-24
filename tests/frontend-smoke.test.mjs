import fs from 'node:fs';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { TextDecoder, TextEncoder } from 'node:util';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const jsonResponse = body => ({ ok: true, status: 200, async json() { return body; } });
const tick = () => new Promise(resolve => setTimeout(resolve, 15));

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
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { async writeText(value) { copied.push(value); } },
  });
  const requests = [];
  window.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    requests.push({ path, options });
    if (path === '/api/auth/config') return jsonResponse({ googleClientId: null });
    if (path === '/api/generate' || path === '/api/optimize')
      return jsonResponse({ result: path.endsWith('/optimize') ? 'Prompt amélioré.' : 'Prompt généré.' });
    throw new Error(`Unexpected request to ${path}`);
  };
  window.eval(app);
  await tick();
  return { dom, window, copied, requests };
}

{
  const h = await boot();
  const { window: w } = h;

  // Quick-save notes are transferred into the prompt composer, while URLs are saved as links.
  w.document.getElementById('quickInput').value = 'Une idée à transformer';
  w.document.getElementById('quickAddBtn').click();
  assert.equal(w.document.getElementById('promptInput').value, 'Une idée à transformer');
  assert.equal(w.document.getElementById('quickInput').value, '');
  assert.equal(w.document.querySelector('.mode-btn.active').dataset.mode, 'generate');

  w.document.getElementById('quickInput').value = 'https://example.com/';
  w.document.getElementById('quickAddBtn').click();
  let saved = JSON.parse(w.localStorage.getItem('promptlab-combined-v1'));
  assert.equal(saved.links.length, 1);
  assert.equal(saved.links[0].url, 'https://example.com/');
  assert.match(w.document.getElementById('savedList').textContent, /example\.com/);

  // Custom collections are available in both the link form and the filter chips.
  w.prompt = () => 'Références';
  w.document.getElementById('addCollectionBtn').click();
  saved = JSON.parse(w.localStorage.getItem('promptlab-combined-v1'));
  assert.equal(saved.collections.length, 1);
  const collectionId = saved.collections[0].id;
  assert.equal(w.document.querySelector(`#linkCollection option[value="${collectionId}"]`)?.textContent, 'Références');
  assert.equal(w.document.querySelector(`#collectionFilters [data-filter="${collectionId}"]`)?.textContent, 'Références');

  w.document.getElementById('linkTitle').value = 'Guide utile';
  w.document.getElementById('linkUrl').value = 'https://example.org/guide';
  w.document.getElementById('linkCollection').value = collectionId;
  w.document.getElementById('linkForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  saved = JSON.parse(w.localStorage.getItem('promptlab-combined-v1'));
  assert.equal(saved.links.length, 2);
  assert.equal(saved.links[0].collection, collectionId);
  assert.equal(w.document.getElementById('linkUrl').value, '');

  w.document.querySelector(`#collectionFilters [data-filter="${collectionId}"]`).click();
  assert.equal(w.document.querySelectorAll('#savedList [data-action="open"]').length, 1);
  assert.match(w.document.getElementById('savedList').textContent, /Guide utile/);
  assert.doesNotMatch(w.document.getElementById('savedList').textContent, /example\.com/);
  assert.equal(w.document.querySelector(`#collectionFilters [data-filter="${collectionId}"]`).classList.contains('active'), true);
  assert.equal(w.document.querySelector('#collectionFilters [data-filter="all"]').classList.contains('active'), false);
  assert.equal(w.document.querySelector('.account-tabs [data-account-mode="login"]').classList.contains('active'), true);

  w.document.getElementById('searchBtn').click();
  w.document.getElementById('searchInput').value = 'guide';
  w.document.getElementById('searchInput').dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.match(w.document.getElementById('searchResults').textContent, /Guide utile/);
  assert.doesNotMatch(w.document.getElementById('searchResults').textContent, /Aucun résultat/);

  // AI behavior is stubbed locally so the test never consumes a production quota.
  w.document.getElementById('promptInput').value = 'Explique la photosynthèse';
  w.document.getElementById('runAiBtn').click();
  await tick();
  assert.equal(w.document.getElementById('resultText').textContent, 'Prompt généré.');
  assert.equal(w.document.getElementById('resultWrap').hidden, false);
  assert.equal(h.requests.filter(x => x.path === '/api/generate').length, 1);
  w.document.getElementById('copyResultBtn').click();
  await tick();
  assert.deepEqual(h.copied, ['Prompt généré.']);
  w.document.getElementById('saveFavoriteBtn').click();
  saved = JSON.parse(w.localStorage.getItem('promptlab-combined-v1'));
  assert.equal(saved.favorites.length, 1);
  assert.equal(saved.favorites[0].text, 'Prompt généré.');
  w.document.querySelector('.collection-card[data-view="favorites"]').click();
  assert.equal(w.document.querySelector('#collectionFilters [data-filter="favorites"]').classList.contains('active'), true);
  assert.match(w.document.getElementById('savedList').textContent, /Prompt généré\./);
  w.document.querySelector('.collection-card[data-view="links"]').click();
  assert.equal(w.document.querySelector('#collectionFilters [data-filter="all"]').classList.contains('active'), true);
  assert.equal(w.document.querySelector('#collectionFilters [data-filter="favorites"]').classList.contains('active'), false);

  // User-controlled titles render as text, never as executable markup.
  w.document.getElementById('collectionFilters').querySelector('[data-filter="all"]').click();
  w.document.getElementById('linkTitle').value = '<img src=x onerror=alert(1)>';
  w.document.getElementById('linkUrl').value = 'https://safe.example/';
  w.document.getElementById('linkCollection').value = 'unsorted';
  w.document.getElementById('linkForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(w.document.querySelectorAll('#savedList img').length, 0);
  assert.match(w.document.getElementById('savedList').textContent, /<img src=x onerror=alert\(1\)>/);

  h.dom.window.close();
}

console.log('frontend-smoke.test.mjs: all assertions passed');
