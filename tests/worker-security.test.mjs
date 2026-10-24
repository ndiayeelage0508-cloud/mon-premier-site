import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const source = fs.readFileSync(new URL('../worker/worker.js', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(source))).default;
const origin = 'https://ndiayeelage0508-cloud.github.io';
const evil = 'https://evil.example';
const empty = { favorites: [], links: [], collections: [] };
const password = 'correct-horse-123';
const times = [];

afterEach(() => {
  while (times.length) Date.now = times.pop();
});

class D1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(fs.readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8'));
    this.db.exec(fs.readFileSync(new URL('../worker/accounts-schema.sql', import.meta.url), 'utf8'));
    this.fail = false;
  }
  prepare(sql) {
    const db = this.db;
    return { bind: (...args) => ({
      first: async () => { if (this.fail) throw new Error('D1 unavailable'); return db.prepare(sql).get(...args) ?? null; },
      run: async () => {
        if (this.fail) throw new Error('D1 unavailable');
        const r = db.prepare(sql).run(...args);
        return { meta: { changes: Number(r.changes) } };
      },
    }) };
  }
  async batch(statements) {
    if (this.fail) throw new Error('D1 unavailable');
    this.db.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec('COMMIT');
      return results;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

function setTime(ms) {
  times.push(Date.now);
  Date.now = () => ms;
}
function harness({ requestOrigin = origin, absentOrigin = false, ip = '198.51.100.10', ai = true, d1 = new D1() } = {}) {
  const pending = [];
  const calls = [];
  const ctx = { waitUntil(promise) { pending.push(Promise.resolve(promise)); } };
  const env = {
    QUOTAS: d1,
    ...(ai ? { AI: { run: async (...args) => { calls.push(args); return { response: 'réponse sûre' }; } } } : {}),
  };
  const request = (path, { method = 'GET', body, headers = {}, originHeader = requestOrigin } = {}) => {
    const h = new Headers({ ...(!absentOrigin ? { Origin: originHeader } : {}), 'CF-Connecting-IP': ip, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers });
    return new Request('https://worker.test' + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  };
  return { db: d1, env, ctx, calls, request, async drain() { await Promise.all(pending.splice(0)); } };
}
async function call(h, path, opts = {}) {
  const response = await worker.fetch(h.request(path, opts), h.env, h.ctx);
  const text = await response.text();
  let json = {}; try { json = JSON.parse(text); } catch {}
  return { response, json };
}
async function register(h, email = 'a@example.com') {
  return (await call(h, '/api/auth/register', { method: 'POST', body: { email, password } })).json;
}
async function login(h, email, tokenHeader = {}) {
  return call(h, '/api/auth/login', { method: 'POST', body: { email, password }, headers: tokenHeader });
}
function auth(token) { return { Authorization: `Bearer ${token}` }; }
function rows(h, sql, ...args) { return h.db.db.prepare(sql).all(...args); }
function library(id = 'fav', text = 'privé') {
  return { favorites: [{ id, text, mode: 'generate', createdAt: '2026-01-01' }], links: [], collections: [] };
}
async function save(h, token, data, revision = 0, extra = {}) {
  return call(h, '/api/library', { method: 'POST', headers: { ...auth(token), ...extra }, body: { revision, data } });
}

// Account isolation, ignored client identity, and real CAS conflict behavior.
test('libraries are isolated by session account and client user_id is ignored', async () => {
  const h = harness();
  const a = await register(h, 'a@example.com');
  const b = await register(h, 'b@example.com');
  assert.equal((await save(h, a.token, library('only-a'), 0, { 'X-User-Id': b.user.id })).response.status, 200);
  const bGet = await call(h, '/api/library', { headers: { ...auth(b.token), 'X-User-Id': a.user.id } });
  assert.equal(bGet.response.status, 200);
  assert.deepEqual(bGet.json.data, empty);
  const aGet = await call(h, '/api/library', { headers: auth(a.token) });
  assert.equal(aGet.json.data.favorites[0].text, 'privé');
  assert.equal(rows(h, 'SELECT user_id FROM account_libraries').length, 1);
  const forged = await call(h, '/api/library', {
    method: 'POST', headers: auth(b.token),
    body: { revision: 0, user_id: a.user.id, userId: a.user.id, data: library('only-b', 'compte B') },
  });
  assert.equal(forged.response.status, 200);
  assert.equal((await call(h, '/api/library', { headers: auth(a.token) })).json.data.favorites[0].text, 'privé');
  assert.equal((await call(h, '/api/library', { headers: auth(b.token) })).json.data.favorites[0].text, 'compte B');
  await h.drain();
});

test('sessions store only hashes, expire, and logout revokes the token', async () => {
  const h = harness();
  const r = await register(h, 'session@example.com');
  const stored = h.db.db.prepare('SELECT token_hash,expires_at FROM account_sessions').get();
  assert.notEqual(stored.token_hash, r.token);
  assert.equal(stored.token_hash.length, 64);
  h.db.db.prepare('UPDATE account_sessions SET expires_at=?').run(Date.now() - 1);
  assert.equal((await call(h, '/api/auth/me', { headers: auth(r.token) })).response.status, 401);
  const fresh = (await login(h, 'session@example.com')).json;
  assert.equal((await call(h, '/api/auth/logout', { method: 'POST', headers: auth(fresh.token) })).response.status, 200);
  assert.equal((await call(h, '/api/auth/me', { headers: auth(fresh.token) })).response.status, 401);
  await h.drain();
});

test('stale library revision returns 409 and performs no mutation', async () => {
  const h = harness();
  const r = await register(h, 'cas@example.com');
  assert.equal((await save(h, r.token, library('one', 'first'))).response.status, 200);
  assert.equal((await save(h, r.token, library('two', 'second'), 1)).response.status, 200);
  const stale = await save(h, r.token, library('attacker', 'must-not-write'), 1);
  assert.equal(stale.response.status, 409);
  assert.equal(stale.json.revision, 2);
  const current = await call(h, '/api/library', { headers: auth(r.token) });
  assert.equal(current.json.data.favorites[0].text, 'second');
  assert.equal(rows(h, 'SELECT revision FROM account_libraries').at(0).revision, 2);
  await h.drain();
});

// Authentication body media type and byte-accurate body handling.
test('auth requires exact JSON media type: jsonp is rejected, charset is accepted, and UTF-8 byte limits apply without Content-Length', async () => {
  const h = harness();
  const json = JSON.stringify({ email: 'media@example.com', password });
  const jsonp = await call(h, '/api/auth/register', { method: 'POST', body: json, headers: { 'Content-Type': 'application/jsonp' } });
  assert.equal(jsonp.response.status, 415);
  const accepted = await call(h, '/api/auth/register', { method: 'POST', body: json, headers: { 'Content-Type': ' Application/JSON ; Charset=UTF-8 ' } });
  assert.equal(accepted.response.status, 201);
  const tooBig = JSON.stringify({ email: 'bytes@example.com', password, padding: 'é'.repeat(9000) });
  const noLength = await call(h, '/api/auth/register', { method: 'POST', body: tooBig, headers: { 'Content-Type': 'application/json', 'Content-Length': '' } });
  assert.equal(noLength.response.status, 413);
  await h.drain();
});

test('library validates duplicate IDs, javascript URLs, credentials, and UTF-8 byte size', async () => {
  const h = harness();
  const r = await register(h, 'validation@example.com');
  for (const bad of [
    library('same'),
    { favorites: [], collections: [], links: [{ id: 'same', url: 'javascript:alert(1)', title: 'x', collection: 'unsorted', createdAt: '2026-01-01' }] },
    { favorites: [], collections: [], links: [{ id: 'cred', url: 'https://user:pass@example.com/x', title: 'x', collection: 'unsorted', createdAt: '2026-01-01' }] },
  ]) {
    if (bad.favorites.length) bad.favorites.push({ ...bad.favorites[0] });
    const result = await save(h, r.token, bad);
    assert.equal(result.response.status, 400);
  }
  const huge = { favorites: Array.from({ length: 19 }, (_, i) => ({ id: `utf8-${i}`, text: 'é'.repeat(11000), mode: 'generate', createdAt: '2026-01-01' })), links: [], collections: [] };
  assert.equal((await save(h, r.token, huge)).response.status, 413);
  await h.drain();
});

// CORS and public AI behavior.
test('CORS rejects and does not reflect hostile origins; public AI permits absent Origin', async () => {
  const hostile = harness({ requestOrigin: evil });
  assert.equal((await call(hostile, '/')).response.status, 200);
  assert.equal((await call(hostile, '/api/auth/config')).response.status, 403);
  const hostileAI = await call(hostile, '/api/generate', { method: 'POST', body: { prompt: 'x' } });
  assert.equal(hostileAI.response.status, 403);
  assert.equal(hostileAI.response.headers.get('Access-Control-Allow-Origin'), null);
  const noOrigin = harness({ absentOrigin: true });
  const publicAI = await call(noOrigin, '/api/generate', { method: 'POST', body: { prompt: 'x' } });
  assert.equal(publicAI.response.status, 200);
  assert.equal(publicAI.response.headers.get('Access-Control-Allow-Origin'), null);
  await hostile.drain(); await noOrigin.drain();
});

test('AI is fail-closed when the AI binding or quota D1 is unavailable', async () => {
  const noAI = harness({ ai: false });
  const unavailable = await call(noAI, '/api/generate', { method: 'POST', body: { prompt: 'x' } });
  assert.equal(unavailable.response.status, 503);
  assert.equal(noAI.calls.length, 0);
  const broken = new D1(); broken.fail = true;
  const noQuota = harness({ d1: broken });
  const unavailableQuota = await call(noQuota, '/api/generate', { method: 'POST', body: { prompt: 'x' } });
  assert.equal(unavailableQuota.response.status, 503);
  assert.equal(noQuota.calls.length, 0);
  await noAI.drain(); await noQuota.drain();
});

// Quota tests use controlled clocks and leave the production rules unchanged.
test('AI quota is atomic at 5 requests per minute and Retry-After reaches the true window end', async () => {
  const h = harness();
  setTime(Date.parse('2026-10-22T00:10:00Z'));
  for (let i = 0; i < 5; i++) assert.equal((await call(h, '/api/generate', { method: 'POST', body: { prompt: `p${i}` } })).response.status, 200);
  const limited = await call(h, '/api/generate', { method: 'POST', body: { prompt: 'sixth' } });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.response.headers.get('Retry-After'), '60');
  assert.equal(limited.json.retryAfter, 60);
  assert.equal(h.calls.length, 5);
  await h.drain();
});

test('auth hourly throttle reports the real seconds remaining at minute 10', async () => {
  const h = harness();
  setTime(Date.parse('2026-10-22T00:10:00Z'));
  for (let i = 0; i < 5; i++) {
    const result = await call(h, '/api/auth/register', { method: 'POST', body: { email: `throttle-${i}@example.com`, password } });
    assert.equal(result.response.status, 201);
    await h.drain();
  }
  const limited = await call(h, '/api/auth/register', { method: 'POST', body: { email: 'throttle-six@example.com', password } });
  assert.equal(limited.response.status, 429);
  assert.ok(Number(limited.response.headers.get('Retry-After')) >= 2999);
  assert.ok(Number(limited.response.headers.get('Retry-After')) <= 3000);
  await h.drain();
});

test('daily generation and optimization quotas are enforced independently in SQL', async () => {
  const h = harness();
  const start = Date.parse('2026-10-22T00:00:00Z');
  for (let i = 0; i < 10; i++) {
    setTime(start + i * 60001);
    assert.equal((await call(h, '/api/generate', { method: 'POST', body: { prompt: 'g' } })).response.status, 200);
  }
  setTime(start + 10 * 60001);
  const genLimit = await call(h, '/api/generate', { method: 'POST', body: { prompt: 'g-limit' } });
  assert.equal(genLimit.response.status, 429);
  assert.equal(genLimit.json.code, 'DAILY_LIMIT');
  const h2 = harness();
  for (let i = 0; i < 5; i++) {
    setTime(start + i * 60001);
    assert.equal((await call(h2, '/api/optimize', { method: 'POST', body: { prompt: 'o' } })).response.status, 200);
  }
  setTime(start + 5 * 60001);
  const optLimit = await call(h2, '/api/optimize', { method: 'POST', body: { prompt: 'o-limit' } });
  assert.equal(optLimit.response.status, 429);
  assert.equal(optLimit.json.code, 'DAILY_LIMIT');
  assert.equal(h.calls.length, 10); assert.equal(h2.calls.length, 5);
  await h.drain(); await h2.drain();
});

test('AI request validation rejects malformed JSON, invalid mode, and oversized UTF-8 prompts before AI', async () => {
  const h = harness();
  const malformed = await call(h, '/api/generate', { method: 'POST', body: '{"prompt":', headers: { 'Content-Type': 'application/json' } });
  assert.equal(malformed.response.status, 400);
  const mode = await call(h, '/api/generate', { method: 'POST', body: { prompt: 'x', mode: 'other' } });
  assert.equal(mode.response.status, 400);
  const long = await call(h, '/api/generate', { method: 'POST', body: { prompt: 'é'.repeat(3001) } });
  assert.equal(long.response.status, 413);
  assert.equal(h.calls.length, 0);
  await h.drain();
});

test('simultaneous AI requests cannot reserve more than five minute slots locally', async () => {
  const h = harness();
  setTime(Date.parse('2026-10-22T00:10:00Z'));
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    call(h, '/api/generate', { method: 'POST', body: { prompt: `parallel-${i}` } })));
  assert.equal(results.filter(r => r.response.status === 200).length, 5);
  assert.equal(results.filter(r => r.response.status === 429).length, 7);
  assert.equal(h.calls.length, 5);
  const row = rows(h, 'SELECT generations, minute_used FROM free_usage')[0];
  assert.equal(row.generations, 5);
  assert.equal(row.minute_used, 5);
  await h.drain();
});

console.log('worker-security.test.mjs: security assertions passed');
