const ALLOWED_ORIGIN = "https://ndiayeelage0508-cloud.github.io";
const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const VERSION = "free-limits-20261021";
const LIMITS = { generate: 10, optimize: 5, characters: 3000, tokens: 700, perMinute: 5 };

function corsHeaders(origin) {
  const headers = { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Expose-Headers": "Retry-After", "Vary": "Origin", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
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
