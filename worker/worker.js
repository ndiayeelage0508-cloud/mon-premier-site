const ALLOWED_ORIGIN = "https://ndiayeelage0508-cloud.github.io";
const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const VERSION = "accounts-free-20261021";
const LIMITS = { generate: 10, optimize: 5, characters: 3000, tokens: 700, perMinute: 5 };

function corsHeaders(origin) {
  const headers = { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Expose-Headers": "Retry-After", "Vary": "Origin", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (origin === ALLOWED_ORIGIN) headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
  return headers;
}
function json(data, status, origin, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin), ...extra } });
}
function promptFor(mode, userPrompt) {
  if (mode === "optimize") return `Tu es un expert en ingénierie de prompts. Améliore le prompt ci-dessous pour le rendre précis, utile et facile à exécuter. Conserve l'intention originale. Ajoute si nécessaire le rôle, le contexte, l'objectif, les contraintes et le format de sortie. Réponds uniquement avec le prompt amélioré, sans commentaire introductif.\n\nPROMPT À AMÉLIORER :\n${userPrompt}`;
  return `Tu es un expert en ingénierie de prompts. Transforme l'idée suivante en un prompt clair, complet et directement utilisable. Inclus un rôle, un contexte, un objectif, des étapes, des contraintes et un format de sortie lorsque c'est pertinent. N'invente pas de détails personnels. Réponds uniquement avec le prompt final.\n\nIDÉE :\n${userPrompt}`;
}
// One atomic row update reserves both daily and minute budgets; no SELECT/UPDATE race.
const RESERVE = `INSERT INTO free_usage (day, client, generations, optimizations, window_start, minute_used)
VALUES (?1, ?2, ?3, ?4, ?5, 1)
ON CONFLICT(day, client) DO UPDATE SET
 generations = generations + ?3,
 optimizations = optimizations + ?4,
 minute_used = CASE WHEN window_start <= ?5 - 60000 THEN 1 ELSE minute_used + 1 END,
 window_start = CASE WHEN window_start <= ?5 - 60000 THEN ?5 ELSE window_start END
WHERE generations + ?3 <= 10 AND optimizations + ?4 <= 5
 AND (window_start <= ?5 - 60000 OR minute_used < 5)
RETURNING generations, optimizations, window_start, minute_used`;
async function readLimitedJSON(request) {
  if (Number(request.headers.get("Content-Length")) > 32768) throw { status: 413 };
  if (!request.body) throw { status: 400 };
  const reader = request.body.getReader(); const chunks = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    total += value.byteLength;
    if (total > 32768) { await reader.cancel(); throw { status: 413 }; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw { status: 400 }; }
}
async function clientHash(ip, day) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`PromptLab:${day}:${ip}`));
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, "0")).join("");
}
export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      if (origin !== ALLOWED_ORIGIN) return json({ error: "Origine non autorisée." }, 403, origin);
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (url.pathname === "/" && request.method === "GET") return json({ ok: true, service: "PromptLab AI", version: VERSION, model: MODEL, bindingAI: Boolean(env?.AI), bindingQuotas: Boolean(env?.QUOTAS), limits: LIMITS, quotaIdentity: "IP", reset: "00:00 UTC", endpoints: ["/api/generate", "/api/optimize"] }, 200, origin);
    const accountResponse = await accountsRoute(request, env, ctx, url, origin);
    if (accountResponse) return accountResponse;
    const pathMode = url.pathname === "/api/generate" ? "generate" : url.pathname === "/api/optimize" ? "optimize" : null;
    if (!pathMode) return json({ error: "Route introuvable." }, 404, origin);
    if (request.method !== "POST") return json({ error: "Méthode non autorisée." }, 405, origin, { Allow: "POST, OPTIONS" });
    if (origin && origin !== ALLOWED_ORIGIN) return json({ error: "Origine non autorisée." }, 403, origin);
    if ((request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase() !== "application/json") return json({ error: "Content-Type application/json requis." }, 415, origin);
    let body;
    try { body = await readLimitedJSON(request); }
    catch (e) { return json({ error: e.status === 413 ? "Corps de requête trop volumineux." : "Corps JSON invalide." }, e.status || 400, origin); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Objet JSON requis." }, 400, origin);
    if (body.mode !== undefined && !["generate", "optimize"].includes(body.mode)) return json({ error: "Mode invalide." }, 400, origin);
    const mode = pathMode === "generate" && body.mode === "optimize" ? "optimize" : pathMode;
    const raw = typeof body.prompt === "string" ? body.prompt : "";
    if ([...raw].length > LIMITS.characters) return json({ error: "La demande dépasse la limite de 3 000 caractères.", code: "PROMPT_TOO_LONG" }, 413, origin);
    const prompt = raw.trim();
    if (!prompt) return json({ error: "Le champ prompt est obligatoire." }, 400, origin);
    if (!env?.AI || !env?.QUOTAS) return json({ error: "Service temporairement indisponible.", code: "SERVICE_UNAVAILABLE" }, 503, origin);
    const ip = request.headers.get("CF-Connecting-IP");
    if (!ip) return json({ error: "Identification réseau indisponible." }, 503, origin);
    const now = Date.now(); const day = new Date(now).toISOString().slice(0, 10);
    const resetAt = Date.parse(`${day}T00:00:00Z`) + 86400000;
    let usage;
    try {
      const client = await clientHash(ip, day);
      usage = await env.QUOTAS.prepare(RESERVE).bind(day, client, mode === "generate" ? 1 : 0, mode === "optimize" ? 1 : 0, now).first();
      if (!usage) {
        const current = await env.QUOTAS.prepare("SELECT generations, optimizations, window_start, minute_used FROM free_usage WHERE day = ? AND client = ?").bind(day, client).first();
        if (!current) throw new Error("Missing quota state");
        const daily = mode === "generate" ? current.generations >= 10 : current.optimizations >= 5;
        const retry = Math.max(1, Math.ceil(((daily ? resetAt : current.window_start + 60000) - now) / 1000));
        return json({ error: daily ? `Quota gratuit atteint : ${LIMITS[mode]} ${mode === "generate" ? "générations" : "optimisations"} par jour et par connexion IP. Réessaie après minuit UTC.` : "Trop de demandes : maximum 5 par minute pour cette connexion IP.", code: daily ? "DAILY_LIMIT" : "RATE_LIMIT", mode, retryAfter: retry }, 429, origin, { "Retry-After": String(retry) });
      }
      // Bounded indexed cleanup, retained counters only for current day.
      ctx.waitUntil(env.QUOTAS.prepare("DELETE FROM free_usage WHERE rowid IN (SELECT rowid FROM free_usage WHERE day < ? LIMIT 100)").bind(day).run().catch(() => {}));
    } catch {
      // Never invoke AI with unenforced quotas, including free D1 exhaustion.
      return json({ error: "Vérification des quotas temporairement indisponible. Réessaie plus tard.", code: "QUOTA_UNAVAILABLE" }, 503, origin, { "Retry-After": "60" });
    }
    try {
      const result = await env.AI.run(MODEL, { messages: [
        { role: "system", content: "Tu es PromptLab, un assistant francophone spécialisé dans la création et l'amélioration de prompts. Sois clair, précis et utile." },
        { role: "user", content: promptFor(mode, prompt) }
      ], max_tokens: LIMITS.tokens });
      const text = result?.response || result?.result?.response || result?.output_text;
      if (typeof text !== "string" || !text.trim()) return json({ error: "Le modèle n'a renvoyé aucun texte. Cette tentative compte dans le quota." }, 502, origin);
      const answer = text.trim();
      return json({ ok: true, answer, result: answer, model: MODEL, mode, quota: { limit: LIMITS[mode], remaining: LIMITS[mode] - (mode === "generate" ? usage.generations : usage.optimizations), resetAt: new Date(resetAt).toISOString(), identity: "IP", countsAttempts: true }, version: VERSION }, 200, origin);
    } catch {
      return json({ error: "Erreur lors de l'appel à Workers AI. Cette tentative compte dans le quota.", code: "AI_UNAVAILABLE" }, 502, origin);
    }
  }
};

// Comptes gratuits stockés dans D1, sans abonnement ni service d'e-mail externe.
const SESSION_MS = 30 * 86400000;
const enc = new TextEncoder();
const EMPTY_LIBRARY = { favorites: [], links: [], collections: [] };
const hex = bytes => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
const randomSecret = () => hex(crypto.getRandomValues(new Uint8Array(32)));
async function digest(value) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(value))); }
async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000 }, key, 256));
}
function equalHash(a, b) { let difference = a.length ^ b.length; for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0); return difference === 0; }
function validEmail(value) { return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function validPassword(value) { return typeof value === 'string' && [...value].length >= 12 && value.length <= 128; }
function publicUser(row) { return { id: row.id, email: row.email, provider: row.provider }; }
function authError(status, message) { throw { status, message }; }
async function authBody(request, max = 16384) {
  if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) authError(415, 'Content-Type application/json requis.');
  if (+request.headers.get('Content-Length') > max) authError(413, 'Données trop volumineuses.');
  if (!request.body) authError(400, 'Corps JSON requis.');
  const reader = request.body.getReader(); let size = 0; const parts = [];
  while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > max) { await reader.cancel(); authError(413, 'Données trop volumineuses.'); } parts.push(value); }
  const bytes = new Uint8Array(size); let position = 0; for (const part of parts) { bytes.set(part, position); position += part.byteLength; }
  let body; try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { authError(400, 'Corps JSON invalide.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) authError(400, 'Objet JSON requis.');
  return body;
}
async function throttle(db, key, limit, windowMs, userId = null) {
  const now = Date.now(); const bucket = Math.floor(now / windowMs);
  const statement = userId
    ? `INSERT INTO auth_limits (key, bucket, count, expires_at)
       SELECT ?, ?, 1, ? WHERE EXISTS (SELECT 1 FROM account_users WHERE id=? )
       ON CONFLICT(key, bucket) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count`
    : `INSERT INTO auth_limits (key, bucket, count, expires_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(key, bucket) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count`;
  const row = userId
    ? await db.prepare(statement).bind(key, bucket, (bucket + 1) * windowMs, userId, limit).first()
    : await db.prepare(statement).bind(key, bucket, (bucket + 1) * windowMs, limit).first();
  if (!row) authError(429, 'Trop de tentatives. Réessaie plus tard.');
}
async function deleteAccount(db, user) {
  const emailHash = await digest(user.email.trim().toLowerCase());
  // D1 batch is one atomic transaction. The conditional email counter survives
  // when another provider/account still owns the same normalized email.
  return db.batch([
    db.prepare('DELETE FROM account_sessions WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM account_libraries WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM account_users WHERE id=?').bind(user.id),
    db.prepare("DELETE FROM auth_limits WHERE key=?").bind('library:' + user.id),
    db.prepare("DELETE FROM auth_limits WHERE key=? AND NOT EXISTS (SELECT 1 FROM account_users WHERE lower(email)=? AND id<>?)").bind('email:' + emailHash, user.email.trim().toLowerCase(), user.id)
  ]);
}
async function issueSession(db, user) {
  const token = randomSecret(); const now = Date.now();
  await db.batch([
    db.prepare('INSERT INTO account_sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').bind(await digest(token), user.id, now + SESSION_MS),
    db.prepare('DELETE FROM account_sessions WHERE token_hash IN (SELECT token_hash FROM account_sessions WHERE user_id = ? ORDER BY expires_at DESC LIMIT -1 OFFSET 10)').bind(user.id)
  ]);
  return { token, user: publicUser(user) };
}
async function sessionUser(request, db) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('Authorization') || '');
  if (!match) authError(401, 'Connecte-toi pour synchroniser ta bibliothèque.');
  const tokenHash = await digest(match[1]);
  const row = await db.prepare('SELECT u.id,u.email,u.provider FROM account_users u JOIN account_sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?').bind(tokenHash, Date.now()).first();
  if (!row) authError(401, 'Session expirée. Reconnecte-toi.');
  return { ...row, tokenHash };
}
let googleKeys = null;
let googleKeysExpire = 0;
function decode64(value) { const s = value.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(s + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0)); }
async function verifyGoogle(credential, nonce, clientId) {
  try {
    if (typeof credential !== 'string' || credential.length > 10000 || typeof nonce !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(nonce)) throw Error();
    const parts = credential.split('.'); if (parts.length !== 3) throw Error();
    const header = JSON.parse(new TextDecoder().decode(decode64(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(decode64(parts[1])));
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== 'RS256' || !['accounts.google.com','https://accounts.google.com'].includes(payload.iss) || payload.aud !== clientId || !Number.isFinite(payload.exp) || payload.exp <= now || !Number.isFinite(payload.iat) || payload.iat > now + 60 || now - payload.iat > 3700 || payload.nonce !== nonce || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255 || !validEmail(payload.email) || payload.email_verified !== true) throw Error();
    if (!googleKeys || Date.now() >= googleKeysExpire || !googleKeys.some(k => k.kid === header.kid)) {
      const response = await fetch('https://www.googleapis.com/oauth2/v3/certs'); if (!response.ok) throw Error();
      const result = await response.json(); googleKeys = result.keys;
      const ttl = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') || '')?.[1] || 300);
      googleKeysExpire = Date.now() + Math.min(ttl, 21600) * 1000;
    }
    const jwk = googleKeys.find(k => k.kid === header.kid && k.kty === 'RSA'); if (!jwk) throw Error();
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode64(parts[2]), enc.encode(parts[0] + '.' + parts[1]))) throw Error();
    return payload;
  } catch { authError(401, 'Connexion Google non valide. Réessaie.'); }
}
function libraryData(input) {
  if (!input || typeof input !== 'object' || !['favorites','links','collections'].every(k => Array.isArray(input[k]))) authError(400, 'Bibliothèque invalide.');
  if (input.favorites.length + input.links.length + input.collections.length > 1000) authError(413, 'Maximum 1 000 éléments par bibliothèque gratuite.');
  const text = (value, max, required = false) => { if (typeof value !== 'string' || value.length > max || (required && !value.trim())) authError(400, 'Champ de bibliothèque invalide.'); return value; };
  const ids = new Set();
  const id = value => { const v = text(value, 100, true); if (ids.has(v)) authError(400, 'Identifiant dupliqué.'); ids.add(v); return v; };
  const created = value => { const v = text(value, 40, true); if (!Number.isFinite(Date.parse(v))) authError(400, 'Date invalide.'); return v; };
  const collections = input.collections.map(x => ({ id: id(x?.id), name: text(x?.name, 120, true) }));
  const allowed = new Set(['unsorted','learning','watch','favorites', ...collections.map(x => x.id)]);
  const favorites = input.favorites.map(x => ({ id: id(x?.id), text: text(x?.text, 12000, true), mode: x?.mode === 'optimize' ? 'optimize' : 'generate', createdAt: created(x?.createdAt) }));
  const links = input.links.map(x => {
    let url; try { url = new URL(x?.url); } catch { authError(400, 'Adresse de lien invalide.'); }
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096 || !allowed.has(x?.collection)) authError(400, 'Lien ou collection invalide.');
    return { id: id(x?.id), url: url.href, title: text(x?.title, 500, true), collection: x.collection, createdAt: created(x?.createdAt) };
  });
  const data = { favorites, links, collections }; if (enc.encode(JSON.stringify(data)).length > 200000) authError(413, 'La bibliothèque dépasse 200 Ko. Exporte une copie avant de la réduire.');
  return data;
}
async function accountsRoute(request, env, ctx, url, origin) {
  const path = url.pathname;
  if (!path.startsWith('/api/auth/') && path !== '/api/library') return null;
  if (origin !== ALLOWED_ORIGIN) return json({ error: 'Origine non autorisée.' }, 403, origin);
  const methods = { '/api/auth/config':'GET', '/api/auth/me':'GET', '/api/auth/register':'POST', '/api/auth/login':'POST', '/api/auth/google':'POST', '/api/auth/recover':'POST', '/api/auth/logout':'POST', '/api/auth/delete':'POST', '/api/library':'GET, POST' };
  if (!methods[path]) return json({ error: 'Route introuvable.' }, 404, origin);
  if (!methods[path].split(', ').includes(request.method)) return json({ error: 'Méthode non autorisée.' }, 405, origin, { Allow: methods[path] + ', OPTIONS' });
  if (path === '/api/auth/config') return json({ googleClientId: env.GOOGLE_CLIENT_ID || null, emailPassword: true, emailVerification: false, recovery: 'code', libraryFree: true }, 200, origin);
  const db = env.QUOTAS;
  if (!db) return json({ error: 'Comptes temporairement indisponibles.' }, 503, origin);
  try {
    const ip = request.headers.get('CF-Connecting-IP'); if (!ip) authError(503, 'Identification réseau indisponible.');
    if (path === '/api/library' || path === '/api/auth/me' || path === '/api/auth/logout' || path === '/api/auth/delete') {
      const user = await sessionUser(request, db);
      if (path === '/api/auth/me') return json({ user: publicUser(user) }, 200, origin);
      if (path === '/api/auth/delete') {
        const body = await authBody(request, 1024);
        if (body.confirmation !== 'SUPPRIMER') authError(400, 'Confirmation exacte SUPPRIMER requise.');
        await deleteAccount(db, user);
        return json({ ok: true }, 200, origin);
      }
      if (path === '/api/auth/logout') { await db.prepare('DELETE FROM account_sessions WHERE token_hash=?').bind(user.tokenHash).run(); return json({ ok: true }, 200, origin); }
      await throttle(db, 'library:' + user.id, 120, 60000, user.id);
      const current = async () => await db.prepare('SELECT data,revision FROM account_libraries WHERE user_id=?').bind(user.id).first();
      if (request.method === 'GET') { const row = await current(); return json({ data: row ? JSON.parse(row.data) : EMPTY_LIBRARY, revision: row?.revision || 0 }, 200, origin); }
      const body = await authBody(request, 210000);
      if (!Number.isSafeInteger(body.revision) || body.revision < 0) authError(400, 'Révision invalide.');
      const data = libraryData(body.data); const serialized = JSON.stringify(data);
      const row = await db.prepare(`INSERT INTO account_libraries (user_id,data,revision,updated_at) SELECT ?,?,1,? WHERE ?=0
        ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,revision=revision+1,updated_at=excluded.updated_at WHERE revision=? RETURNING revision`).bind(user.id, serialized, Date.now(), body.revision, body.revision).first();
      // INSERT ... SELECT with false WHERE does not execute ON CONFLICT for revisions > 0.
      let result = row;
      if (body.revision > 0) result = await db.prepare('UPDATE account_libraries SET data=?,revision=revision+1,updated_at=? WHERE user_id=? AND revision=? RETURNING revision').bind(serialized,Date.now(),user.id,body.revision).first();
      if (!result) { const latest = await current(); return json({ error: 'Bibliothèque modifiée sur un autre appareil.', data: latest ? JSON.parse(latest.data) : EMPTY_LIBRARY, revision: latest?.revision || 0 }, 409, origin); }
      return json({ revision: result.revision }, 200, origin);
    }
    const ipKey = await digest('auth:' + ip);
    await throttle(db, 'auth:' + ipKey, 10, 60000);
    const body = await authBody(request);
    if (path === '/api/auth/google') {
      if (!env.GOOGLE_CLIENT_ID) authError(503, 'Connexion Google en attente de configuration. La connexion e-mail est disponible.');
      const identity = await verifyGoogle(body.credential, body.nonce, env.GOOGLE_CLIENT_ID);
      // Identity is Google sub, NEVER an unverified e-mail from a password account.
      let user = await db.prepare("SELECT id,email,provider FROM account_users WHERE provider='google' AND subject=?").bind(identity.sub).first();
      if (!user) {
        const id = crypto.randomUUID();
        await db.prepare("INSERT OR IGNORE INTO account_users (id,provider,subject,email,created_at) VALUES (?,'google',?,?,?)").bind(id,identity.sub,identity.email,Date.now()).run();
        user = await db.prepare("SELECT id,email,provider FROM account_users WHERE provider='google' AND subject=?").bind(identity.sub).first();
      }
      return json(await issueSession(db, user), 200, origin);
    }
    if (!validEmail(body.email)) authError(400, 'Adresse e-mail invalide.');
    const email = body.email.trim().toLowerCase();
    await throttle(db, 'email:' + await digest(email), path === '/api/auth/register' ? 5 : 20, 3600000);
    if (path === '/api/auth/register') {
      await throttle(db, 'register:' + ipKey, 5, 3600000);
      if (!validPassword(body.password)) authError(400, 'Choisis un mot de passe de 12 à 128 caractères.');
      const id = crypto.randomUUID(); const salt = randomSecret(); const recoveryCode = randomSecret();
      const hash = await passwordHash(body.password, salt);
      const result = await db.prepare("INSERT OR IGNORE INTO account_users (id,provider,subject,email,password_hash,password_salt,recovery_hash,created_at) VALUES (?,'password',?,?,?,?,?,?)").bind(id,email,email,hash,salt,await digest(recoveryCode),Date.now()).run();
      if (!result.meta.changes) authError(409, 'Inscription indisponible pour cette adresse. Essaie la connexion ou la récupération.');
      return json({ ...await issueSession(db, { id, email, provider:'password' }), recoveryCode }, 201, origin);
    }
    const user = await db.prepare("SELECT * FROM account_users WHERE provider='password' AND subject=?").bind(email).first();
    if (path === '/api/auth/login') {
      if (!validPassword(body.password)) authError(401, 'Adresse ou mot de passe incorrect.');
      const calculated = await passwordHash(body.password, user?.password_salt || '00000000000000000000000000000000');
      if (!user || !equalHash(calculated, user.password_hash)) authError(401, 'Adresse ou mot de passe incorrect.');
      return json(await issueSession(db, user), 200, origin);
    }
    if (path === '/api/auth/recover') {
      if (!validPassword(body.password)) authError(400, 'Choisis un mot de passe de 12 à 128 caractères.');
      if (typeof body.recoveryCode !== 'string' || !/^[a-f0-9]{64}$/.test(body.recoveryCode)) authError(401, 'Adresse ou code de récupération incorrect.');
      const recoveryHash = await digest(body.recoveryCode);
      if (!user || !equalHash(recoveryHash, user.recovery_hash || '')) authError(401, 'Adresse ou code de récupération incorrect.');
      const salt = randomSecret(); const hash = await passwordHash(body.password, salt);
      const results = await db.batch([
        db.prepare('UPDATE account_users SET password_hash=?,password_salt=? WHERE id=? AND recovery_hash=?').bind(hash,salt,user.id,recoveryHash),
        db.prepare('DELETE FROM account_sessions WHERE user_id=?').bind(user.id)
      ]);
      if (!results[0].meta.changes) authError(401, 'Code de récupération incorrect.');
      return json({ ok: true }, 200, origin);
    }
    authError(404, 'Route introuvable.');
  } catch (error) {
    const status = error.status || 503;
    return json({ error: error.status ? error.message : 'Synchronisation ou comptes temporairement indisponibles. Réessaie plus tard.' }, status, origin, status === 429 ? { 'Retry-After': '60' } : {});
  } finally {
    ctx.waitUntil(db.batch([
      db.prepare('DELETE FROM auth_limits WHERE rowid IN (SELECT rowid FROM auth_limits WHERE expires_at<? LIMIT 50)').bind(Date.now()),
      db.prepare('DELETE FROM account_sessions WHERE token_hash IN (SELECT token_hash FROM account_sessions WHERE expires_at<? LIMIT 50)').bind(Date.now())
    ]).catch(() => {}));
  }
}
