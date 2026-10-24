import fs from 'node:fs';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const data = { favorites: [], links: [], collections: [] };
const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});
const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

async function boot({ google = false, session = null } = {}) {
  const dom = new JSDOM(html, {
    url: 'https://ndiayeelage0508-cloud.github.io/',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.crypto = webcrypto;
  window.confirm = () => true;
  window.open = () => {};
  window.navigator.clipboard = { writeText: async () => {} };
  for (const name of ['showModal', 'close'])
    window.HTMLDialogElement.prototype[name] = function () { this.open = name === 'showModal'; };
  if (session) {
    window.localStorage.setItem('promptlab-session-v1', JSON.stringify(session));
    window.localStorage.setItem('promptlab-auth-token', session.token);
    window.localStorage.setItem('promptlab-auth-user', JSON.stringify(session.user));
  }
  const calls = [];
  const pending = [];
  let googleCallback;
  if (google) {
    window.google = { accounts: { id: {
      initialize(opts) { googleCallback = opts.callback; },
      prompt() {},
      renderButton() {},
    } } };
    const append = window.document.head.appendChild.bind(window.document.head);
    window.document.head.appendChild = node => {
      const result = append(node);
      if (node.src.includes('accounts.google.com')) queueMicrotask(() => node.onload?.());
      return result;
    };
  }
  window.fetch = (url, opts = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, opts });
    if (path === '/api/auth/config') return Promise.resolve(jsonResponse({ googleClientId: google ? 'client-id' : null }));
    if (path === '/api/auth/me') return Promise.resolve(jsonResponse({ user: session.user }));
    if (path === '/api/library') return Promise.resolve(jsonResponse({ data, revision: 1 }));
    if (path === '/api/auth/logout') return Promise.resolve(jsonResponse({ ok: true }));
    if (path === '/api/auth/login' || path === '/api/auth/google') {
      return new Promise((resolve, reject) => pending.push({ path, resolve, reject }));
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  window.eval(app);
  await wait(20);
  return { dom, window, calls, pending, get googleCallback() { return googleCallback; } };
}

function submit(h, email) {
  h.window.document.querySelector('#accountEmail').value = email;
  h.window.document.querySelector('#accountPassword').value = 'a'.repeat(12);
  h.window.document.querySelector('#accountForm').dispatchEvent(
    new h.window.Event('submit', { bubbles: true, cancelable: true }),
  );
}
const loginResult = (id, email) => ({ token: id.repeat(64), user: { id, email, provider: 'password' } });

// Two password attempts: B completes first, then A must not replace B.
{
  const h = await boot();
  submit(h, 'a@example.com');
  submit(h, 'b@example.com');
  assert.equal(h.pending.length, 2);
  h.pending[1].resolve(jsonResponse(loginResult('b', 'b@example.com')));
  await wait(10);
  h.pending[0].resolve(jsonResponse(loginResult('a', 'a@example.com')));
  await wait(20);
  assert.equal(h.window.document.querySelector('#accountEmailLabel').textContent, 'b@example.com');
  assert.match(h.window.document.querySelector('#accountStatus').textContent, /Compte connecté/);
  h.dom.window.close();
}

// A stale failure must not overwrite the successful newer attempt's message.
{
  const h = await boot();
  submit(h, 'old@example.com');
  submit(h, 'new@example.com');
  h.pending[1].resolve(jsonResponse(loginResult('n', 'new@example.com')));
  await wait(10);
  h.pending[0].resolve(jsonResponse({ error: 'ancien échec' }, 503));
  await wait(20);
  assert.equal(h.window.document.querySelector('#accountEmailLabel').textContent, 'new@example.com');
  assert.doesNotMatch(h.window.document.querySelector('#accountStatus').textContent, /ancien échec/);
  h.dom.window.close();
}

// Logout invalidates a login that is still awaiting its response.
{
  const user = { id: 'current', email: 'current@example.com', provider: 'password' };
  const h = await boot({ session: { token: 'c'.repeat(64), user } });
  await wait(15);
  submit(h, 'pending@example.com');
  h.window.document.querySelector('#logoutBtn').click();
  await wait(5);
  h.pending[0].resolve(jsonResponse(loginResult('p', 'pending@example.com')));
  await wait(20);
  assert.equal(h.window.localStorage.getItem('promptlab-session-v1'), null);
  assert.equal(h.window.document.querySelector('#accountLoggedOut').hidden, false);
  h.dom.window.close();
}

// Google callbacks use the same generation guard when a newer callback wins.
{
  const h = await boot({ google: true });
  await wait(10);
  assert.equal(typeof h.googleCallback, 'function');
  h.googleCallback({ credential: 'old' });
  h.googleCallback({ credential: 'new' });
  assert.equal(h.pending.length, 2);
  h.pending[1].resolve(jsonResponse({ token: 'g'.repeat(64), user: { id: 'google-new', email: 'new@gmail.com', provider: 'google' } }));
  await wait(10);
  h.pending[0].resolve(jsonResponse({ token: 'o'.repeat(64), user: { id: 'google-old', email: 'old@gmail.com', provider: 'google' } }));
  await wait(20);
  assert.equal(h.window.document.querySelector('#accountEmailLabel').textContent, 'new@gmail.com');
  h.dom.window.close();
}

// A captured logout from a different token must not invalidate the current login.
{
  const user = { id: 'current', email: 'current@example.com', provider: 'password' };
  const h = await boot({ session: { token: 'c'.repeat(64), user } });
  submit(h, 'new@example.com');
  await h.window.endSession(false, 'x'.repeat(64));
  h.pending[0].resolve(jsonResponse(loginResult('n', 'new@example.com')));
  await wait(20);
  assert.equal(h.window.document.querySelector('#accountEmailLabel').textContent, 'new@example.com');
  h.dom.window.close();
}

console.log('frontend-auth-race.test.mjs: all assertions passed');
