import fs from 'node:fs';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const user = { id: 'account-filter', email: 'filter@example.com', provider: 'password' };
const link = (id, collection) => ({
  id,
  title: id,
  url: `https://${id}.example/`,
  collection,
  createdAt: '2026-01-01T00:00:00.000Z',
});
const data = (collections, links = []) => ({ favorites: [], links, collections });
const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});

async function boot({ anonymous, account, libraryResponses = [account], session = true }) {
  const dom = new JSDOM(html, {
    url: 'https://ndiayeelage0508-cloud.github.io/',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.crypto = webcrypto;
  window.confirm = () => true;
  window.prompt = () => null;
  window.open = () => {};
  window.navigator.clipboard = { writeText: async () => {} };
  for (const name of ['showModal', 'close'])
    window.HTMLDialogElement.prototype[name] = function () { this.open = name === 'showModal'; };
  window.localStorage.setItem('promptlab-combined-v1', JSON.stringify(anonymous));
  window.localStorage.setItem('promptlab-library-account-filter', JSON.stringify({ data: account, base: account }));
  if (session)
    window.sessionStorage.setItem('promptlab-session-v1', JSON.stringify({ token: 'a'.repeat(64), user }));
  let libraryCall = 0;
  window.fetch = async url => {
    const path = new URL(url).pathname;
    if (path === '/api/auth/config') return json({ googleClientId: null });
    if (path === '/api/auth/me') return json({ user });
    if (path === '/api/library') {
      const response = libraryResponses[Math.min(libraryCall++, libraryResponses.length - 1)];
      return json({ data: response, revision: libraryCall });
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  window.eval(app);
  await wait(30);
  return { dom, window };
}

// Switching from an anonymous library to an account with different collections
// must not leave the removed anonymous collection selected.
{
  const anonymous = data([{ id: 'c-anon', name: 'Anonyme' }], [link('anon-link', 'c-anon')]);
  const account = data([{ id: 'c-account', name: 'Compte' }], [link('account-link', 'c-account')]);
  const h = await boot({ anonymous, account, session: false });
  const { document } = h.window;
  document.querySelector('[data-filter="c-anon"]').click();
  h.window.sessionStorage.setItem('promptlab-session-v1', JSON.stringify({ token: 'a'.repeat(64), user }));
  await h.window.loadAccount();
  assert.equal(document.querySelector('[data-filter="c-anon"]'), null);
  assert.equal(document.querySelector('[data-filter="all"]').classList.contains('active'), true);
  assert.match(document.querySelector('#savedList').textContent, /account-link/);
  h.dom.window.close();
}

// A remote deletion of the selected collection falls back to the all-links view.
{
  const selected = data([{ id: 'c-remote', name: 'À distance' }], [link('remote-link', 'c-remote')]);
  const removed = data([], [link('unsorted-link', 'unsorted')]);
  const h = await boot({ anonymous: selected, account: selected, libraryResponses: [selected, removed] });
  const { document } = h.window;
  document.querySelector('[data-filter="c-remote"]').click();
  assert.equal(document.querySelector('[data-filter="c-remote"]').classList.contains('active'), true);
  await h.window.pullLibrary();
  assert.equal(document.querySelector('[data-filter="c-remote"]'), null);
  assert.equal(document.querySelector('[data-filter="all"]').classList.contains('active'), true);
  assert.match(document.querySelector('#savedList').textContent, /unsorted-link/);
  h.dom.window.close();
}

// Still-valid built-in and custom filters remain selected.
{
  const account = data([{ id: 'c-valid', name: 'Valide' }], [link('valid-link', 'c-valid')]);
  const h = await boot({ anonymous: account, account });
  const { document } = h.window;
  for (const filter of ['favorites', 'unsorted', 'learning', 'watch', 'c-valid']) {
    document.querySelector(`[data-filter="${filter}"]`).click();
    assert.equal(document.querySelector(`[data-filter="${filter}"]`).classList.contains('active'), true, filter);
  }
  h.dom.window.close();
}

console.log('frontend-collection-filter.test.mjs: all assertions passed');
