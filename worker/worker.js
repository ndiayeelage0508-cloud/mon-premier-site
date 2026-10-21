const ALLOWED_ORIGIN = "https://ndiayeelage0508-cloud.github.io";
const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
  if (origin === ALLOWED_ORIGIN) headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
  return headers;
}
function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin) }
  });
}
function promptFor(mode, userPrompt) {
  if (mode === "optimize") {
    return `Tu es un expert en ingénierie de prompts. Améliore le prompt ci-dessous pour le rendre précis, utile et facile à exécuter. Conserve l'intention originale. Ajoute si nécessaire le rôle, le contexte, l'objectif, les contraintes et le format de sortie. Réponds uniquement avec le prompt amélioré, sans commentaire introductif.\n\nPROMPT À AMÉLIORER :\n${userPrompt}`;
  }
  return `Tu es un expert en ingénierie de prompts. Transforme l'idée suivante en un prompt clair, complet et directement utilisable. Inclus un rôle, un contexte, un objectif, des étapes, des contraintes et un format de sortie lorsque c'est pertinent. N'invente pas de détails personnels. Réponds uniquement avec le prompt final.\n\nIDÉE :\n${userPrompt}`;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      if (origin !== ALLOWED_ORIGIN) return json({ error: "Origine non autorisée." }, 403, origin);
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (url.pathname === "/" && request.method === "GET") {
      return json({ ok: true, service: "PromptLab AI", model: MODEL, bindingAI: Boolean(env?.AI && typeof env.AI.run === "function"), endpoints: ["/api/generate", "/api/optimize"] }, 200, origin);
    }
    const pathMode = url.pathname === "/api/generate" ? "generate" : url.pathname === "/api/optimize" ? "optimize" : null;
    if (!pathMode || request.method !== "POST") return json({ error: "Route introuvable." }, 404, origin);
    if (origin && origin !== ALLOWED_ORIGIN) return json({ error: "Origine non autorisée." }, 403, origin);
    if (!env?.AI || typeof env.AI.run !== "function") {
      return json({ error: "Le binding Workers AI nommé AI n'est pas configuré." }, 500, origin);
    }
    let body;
    try { body = await request.json(); } catch { return json({ error: "Corps JSON invalide." }, 400, origin); }
    // Older frontend versions posted /api/generate with mode="optimize".
    const mode = pathMode === "generate" && body?.mode === "optimize" ? "optimize" : pathMode;
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return json({ error: "Le champ prompt est obligatoire." }, 400, origin);
    if (prompt.length > 6000) return json({ error: "Le prompt dépasse la limite de 6000 caractères." }, 413, origin);
    try {
      const result = await env.AI.run(MODEL, {
        messages: [
          { role: "system", content: "Tu es PromptLab, un assistant francophone spécialisé dans la création et l'amélioration de prompts. Sois clair, précis et utile." },
          { role: "user", content: promptFor(mode, prompt) }
        ],
        max_tokens: 1200
      });
      const text = result?.response || result?.result?.response || result?.output_text;
      if (typeof text !== "string" || !text.trim()) return json({ error: "Le modèle n'a renvoyé aucun texte." }, 502, origin);
      const answer = text.trim();
      return json({ ok: true, answer, result: answer, model: MODEL, mode }, 200, origin);
    } catch (error) {
      return json({ error: "Erreur lors de l'appel à Workers AI.", details: String(error?.message || error).slice(0, 300) }, 502, origin);
    }
  }
};
