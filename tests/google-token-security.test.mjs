import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

// Expose the private verifier only inside this test's in-memory module.
const source = fs.readFileSync(new URL('../worker/worker.js', import.meta.url), 'utf8');
const { verifyGoogle } = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(source + '\nexport { verifyGoogle };'));
const clientId = 'local-test.apps.googleusercontent.com';
const nonce = 'local_nonce_for_security_tests_2026';
const base64 = value => Buffer.from(typeof value === 'string' ? value : new Uint8Array(value)).toString('base64url');

test('Google: signature et revendications vérifiées sans réseau réel', async t => {
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', keys.publicKey), kid: 'local-key', alg: 'RS256', use: 'sig' };
  const originalFetch = globalThis.fetch;
  let certRequests = 0;
  globalThis.fetch = async url => {
    assert.equal(url, 'https://www.googleapis.com/oauth2/v3/certs');
    certRequests++;
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300' } });
  };
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: 'https://accounts.google.com', aud: clientId, sub: 'google-sub-local', email: 'test@example.com', email_verified: true, nonce, iat: now, exp: now + 3600 };
  async function token(payload = claims, header = { alg: 'RS256', kid: jwk.kid }) {
    const data = base64(JSON.stringify(header)) + '.' + base64(JSON.stringify(payload));
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(data));
    return data + '.' + base64(signature);
  }
  const denied = promise => assert.rejects(promise, error => error.status === 401);
  try {
    await t.test('jeton signé valide et cache de clés', async () => {
      const value = await token();
      assert.deepEqual(await verifyGoogle(value, nonce, clientId), claims);
      await verifyGoogle(value, nonce, clientId);
      assert.equal(certRequests, 1);
    });
    const invalid = [
      ['mauvais destinataire', { aud: 'another-client' }],
      ['mauvais émetteur', { iss: 'https://evil.example' }],
      ['nonce différent', { nonce: 'another_valid_nonce_2026' }],
      ['jeton expiré', { exp: now - 1 }],
      ['date future', { iat: now + 120 }],
      ['jeton trop ancien', { iat: now - 4000 }],
      ['e-mail non vérifié', { email_verified: false }],
      ['identité absente', { sub: '' }],
    ];
    for (const [name, patch] of invalid) await t.test(name, async () => denied(verifyGoogle(await token({ ...claims, ...patch }), nonce, clientId)));
    await t.test('algorithme none refusé', async () => denied(verifyGoogle(await token(claims, { alg: 'none', kid: jwk.kid }), nonce, clientId)));
    await t.test('charge utile altérée sans nouvelle signature', async () => {
      const parts = (await token()).split('.');
      parts[1] = base64(JSON.stringify({ ...claims, sub: 'victim-sub' }));
      await denied(verifyGoogle(parts.join('.'), nonce, clientId));
    });
    await t.test('formats et tailles invalides', async () => {
      for (const value of [null, '', 'bad.jwt.value', 'x'.repeat(10001)]) await denied(verifyGoogle(value, nonce, clientId));
      await denied(verifyGoogle(await token(), 'short', clientId));
    });
  } finally { globalThis.fetch = originalFetch; }
});
