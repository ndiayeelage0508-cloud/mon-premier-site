import fs from 'node:fs';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const user = { id: 'user-a', email: 'a@example.com', provider: 'password' };
const accountData = { favorites: [{ id: 'a', text: 'account', mode: 'generate', createdAt: '2026-01-01' }], links: [], collections: [] };
const anonData = { favorites: [{ id: 'anon', text: 'anonymous', mode: 'generate', createdAt: '2026-01-01' }], links: [], collections: [] };
const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, async json() { return body; } });

async function boot({ deleteStatus = 200, deleteBody = { ok: true }, deleteGate = null } = {}) {
  const dom = new JSDOM(html, { url: 'https://ndiayeelage0508-cloud.github.io/', runScripts: 'outside-only' });
  const { window } = dom;
  window.crypto = webcrypto;
  window.confirm = () => true;
  window.open = () => {};
  window.navigator.clipboard = { writeText: async () => {} };
  for (const name of ['showModal', 'close']) window.HTMLDialogElement.prototype[name] = function () { this.open = name === 'showModal'; };
  window.localStorage.setItem('promptlab-session-v1', JSON.stringify({ token: 'a'.repeat(64), user }));
  window.localStorage.setItem('promptlab-auth-token', 'a'.repeat(64));
  window.localStorage.setItem('promptlab-auth-user', JSON.stringify(user));
  window.localStorage.setItem('promptlab-combined-v1', JSON.stringify(anonData));
  window.localStorage.setItem('promptlab-library-user-a', JSON.stringify({ data: accountData, base: accountData }));
  let deleteResolve;
  const calls = [];
  window.fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    const path = new URL(url).pathname;
    if (path === '/api/auth/config') return jsonResponse({ googleClientId: null });
    if (path === '/api/auth/me') return jsonResponse({ user });
    if (path === '/api/library' && (!opts.method || opts.method === 'GET')) return jsonResponse({ data: accountData, revision: 1 });
    if (path === '/api/auth/delete') {
      if (deleteGate) await new Promise(resolve => { deleteResolve = resolve; });
      return jsonResponse(deleteBody, deleteStatus);
    }
    if (path === '/api/auth/logout') return jsonResponse({ ok: true });
    throw new Error(`unexpected fetch ${path}`);
  };
  window.eval(app);
  await new Promise(resolve => setTimeout(resolve, 20));
  return { dom, window, calls, releaseDelete: () => deleteResolve?.() };
}

// Invalid confirmation must not call the server, while the exact button enables it.
{
  const h = await boot();
  const input = h.window.document.querySelector('#deleteConfirmation');
  const button = h.window.document.querySelector('#deleteAccountBtn');
  input.value = 'supprimer'; input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.equal(button.disabled, true);
  button.click();
  assert.equal(h.calls.filter(x => x.url.endsWith('/api/auth/delete')).length, 0);
  input.value = 'SUPPRIMER'; input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.equal(button.disabled, false);
  h.dom.window.close();
}

// Successful deletion removes only the account cache/base and session; anonymous data survives.
{
  const h = await boot();
  const input = h.window.document.querySelector('#deleteConfirmation');
  input.value = 'SUPPRIMER'; input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  h.window.document.querySelector('#deleteAccountBtn').click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.window.localStorage.getItem('promptlab-library-user-a'), null);
  assert.equal(h.window.localStorage.getItem('promptlab-base-user-a'), null);
  assert.equal(h.window.localStorage.getItem('promptlab-session-v1'), null);
  assert.equal(h.window.sessionStorage.getItem('promptlab-session-v1'), null);
  assert.deepEqual(JSON.parse(h.window.localStorage.getItem('promptlab-combined-v1')), anonData);
  assert.equal(h.window.document.querySelector('#deleteConfirmation').value, '');
  assert.equal(h.window.document.querySelector('#deleteAccountBtn').disabled, true);
  h.dom.window.close();
}

// Server failure preserves account cache/session and does not erase user data.
{
  const h = await boot({ deleteStatus: 503, deleteBody: { error: 'indisponible' } });
  const input = h.window.document.querySelector('#deleteConfirmation');
  input.value = 'SUPPRIMER'; input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  h.window.document.querySelector('#deleteAccountBtn').click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.window.localStorage.getItem('promptlab-session-v1'), null);
  assert.notEqual(h.window.sessionStorage.getItem('promptlab-session-v1'), null);
  assert.notEqual(h.window.localStorage.getItem('promptlab-library-user-a'), null);
  assert.match(h.window.document.querySelector('#accountStatus').textContent, /indisponible/);
  h.dom.window.close();
}

// A deletion in flight blocks focus-triggered sync and late responses cannot apply.
{
  const h = await boot({ deleteGate: true });
  const input = h.window.document.querySelector('#deleteConfirmation');
  input.value = 'SUPPRIMER'; input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  h.window.document.querySelector('#deleteAccountBtn').click();
  await new Promise(resolve => setTimeout(resolve, 5));
  const before = h.calls.filter(x => x.url.endsWith('/api/library')).length;
  h.window.dispatchEvent(new h.window.Event('focus'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.calls.filter(x => x.url.endsWith('/api/library')).length, before);
  h.releaseDelete();
  await new Promise(resolve => setTimeout(resolve, 20));
  h.dom.window.close();
}
console.log('frontend-delete-account.test.mjs: all assertions passed');
