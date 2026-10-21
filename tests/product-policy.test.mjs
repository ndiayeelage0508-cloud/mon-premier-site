import fs from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const policy = JSON.parse(fs.readFileSync(new URL('../product-policy.json', import.meta.url)));
const existing = {
  favorites: [{ id: 'old-fav', text: 'Mon ancien prompt', mode: 'generate', createdAt: '2026-01-01' }],
  links: [{ id: 'old-link', title: 'Ancien lien', url: 'https://example.com/', collection: 'c-old', createdAt: '2026-01-01' }],
  collections: [{ id: 'c-old', name: 'Ma collection' }],
};
function boot() {
  const dom = new JSDOM(html, { url: 'https://ndiayeelage0508-cloud.github.io/mon-premier-site/', runScripts: 'outside-only' });
  const { window } = dom;
  window.TextEncoder = TextEncoder;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.localStorage.setItem('promptlab-combined-v1', JSON.stringify(existing));
  const calls = [];
  window.fetch = async url => {
    calls.push(url);
    assert.equal(new URL(url).pathname, '/api/auth/config');
    return { ok: true, json: async () => ({ googleClientId: null }) };
  };
  window.eval(app + '\nwindow.testSaveFavorite = () => { state.lastResult = "Nouveau favori"; saveFavorite(); };');
  return { dom, window, calls };
}

test('target policy records the user decision without activating billing, ads or enforcement', () => {
  assert.equal(policy.target.free.advertising, true);
  assert.deepEqual(policy.target.premium.features, ['favorites', 'collections']);
  assert.equal(policy.target.premium.price, null);
  assert.equal(policy.target.premium.advertising, 'undecided');
  for (const flag of ['premiumEnforcement', 'advertising', 'checkout']) assert.equal(policy.activation[flag], false);
  assert.equal(policy.activation.existingDataMigration, null);
  assert.equal(policy.safeguards.preserveCurrentAccess, true);
});

test('offer dialog opens, explicitly announces preparation and has no purchase controls', () => {
  const { dom, window } = boot();
  window.document.getElementById('plansBtn').click();
  const dialog = window.document.getElementById('plansDialog');
  assert.equal(dialog.open, true);
  assert.match(dialog.textContent, /Aucune offre Premium n’est encore en vente/);
  assert.match(dialog.textContent, /favoris et les collections seront réservés au Premium/);
  assert.match(dialog.textContent, /les accès restent inchangés/);
  assert.equal(dialog.querySelectorAll('a, input, select').length, 0);
  assert.equal(dialog.querySelectorAll('button').length, 1); // close only
  assert.doesNotMatch(dialog.textContent, /[€$£]|sans publicités/);
  dom.window.close();
});

test('ad slot is inert and boot makes no new third-party network call', () => {
  const { dom, window, calls } = boot();
  const template = window.document.getElementById('adSlotTemplate');
  assert.equal(template.tagName, 'TEMPLATE');
  assert.equal(template.content.querySelectorAll('.ad-slot').length, 1);
  assert.equal(window.document.querySelectorAll('.ad-slot, iframe').length, 0);
  assert.deepEqual([...window.document.scripts].map(s => s.getAttribute('src')), ['./app.js?v=20261021-4']);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]).pathname, '/api/auth/config');
  dom.window.close();
});

test('existing favorites, links and collections are untouched and remain available', () => {
  const { dom, window } = boot();
  assert.deepEqual(JSON.parse(window.localStorage.getItem('promptlab-combined-v1')), existing);
  assert.equal(window.document.getElementById('favoriteCount').textContent, '1');
  assert.equal(window.document.getElementById('linkCount').textContent, '1');
  assert.ok(window.document.querySelector('option[value="c-old"]'));
  assert.equal(window.document.getElementById('saveFavoriteBtn').disabled, false);
  assert.equal(window.document.getElementById('addCollectionBtn').disabled, false);
  window.prompt = () => 'Nouvelle collection';
  window.document.getElementById('addCollectionBtn').click();
  window.testSaveFavorite();
  const saved = JSON.parse(window.localStorage.getItem('promptlab-combined-v1'));
  assert.equal(saved.favorites.length, 2);
  assert.equal(saved.collections.length, 2);
  assert.deepEqual(saved.favorites.find(x => x.id === 'old-fav'), existing.favorites[0]);
  assert.deepEqual(saved.links, existing.links);
  assert.deepEqual(saved.collections.find(x => x.id === 'c-old'), existing.collections[0]);
  dom.window.close();
});
