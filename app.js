/* PromptLab frontend: local-first data, native auth, conflict-safe sync. */
const API_BASE = "https://promptlab-ai.ndiayeelage0508.workers.dev";
const ANON_KEY = "promptlab-combined-v1",
  TOKEN_KEY = "promptlab-auth-token",
  USER_KEY = "promptlab-auth-user",
  CACHE_PREFIX = "promptlab-library-",
  BASE_PREFIX = "promptlab-base-";
const MAX_ITEMS = 1000,
  MAX_BYTES = 200000,
  MAX_ID = 100,
  MAX_TEXT = 12000,
  MAX_URL = 4096,
  MAX_TITLE = 500,
  MAX_COLLECTION = 120;
const $ = (id) => document.getElementById(id),
  safeText = (v) => String(v ?? ""),
  blank = () => ({ favorites: [], links: [], collections: [] });
const state = {
  mode: "generate",
  filter: "all",
  lastResult: "",
  lastMode: "generate",
  data: blank(),
  baseRemote: null,
  token: null,
  user: null,
  syncTimer: null,
  syncBusy: false,
  queued: false,
  accountMode: "login",
  googleNonce: null,
  aiController: null,
};
const apiPath = (p) => `${API_BASE.replace(/\/$/, "")}${p}`;
const uid = () => `${Date.now()}-${cryptoRandom()}`;
const cryptoRandom = () => {
  try {
    return [...crypto.getRandomValues(new Uint32Array(2))]
      .map((x) => x.toString(16))
      .join("");
  } catch {
    return Math.random().toString(16).slice(2);
  }
};
const byteLength = (v) => new TextEncoder().encode(v).length;
function readJSON(k, f) {
  try {
    return JSON.parse(localStorage.getItem(k) || JSON.stringify(f));
  } catch {
    return f;
  }
}
function cacheKey(user = state.user) {
  return user ? CACHE_PREFIX + user.id : ANON_KEY;
}
function baseKey(user = state.user) {
  return user ? BASE_PREFIX + user.id : null;
}
function validData(data) {
  if (
    !data ||
    !["favorites", "links", "collections"].every((k) => Array.isArray(data[k]))
  )
    return "Format de bibliothèque invalide.";
  if (
    data.favorites.length + data.links.length + data.collections.length >
    MAX_ITEMS
  )
    return `Limite atteinte : ${MAX_ITEMS} éléments maximum.`;
  const ids = new Set(),
    validId = (value) =>
      typeof value === "string" &&
      value.trim() &&
      value.length <= MAX_ID &&
      !ids.has(value) &&
      ids.add(value);
  const validDate = (value) =>
    typeof value === "string" &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value));
  for (const item of data.collections) {
    if (
      !item ||
      !validId(item.id) ||
      typeof item.name !== "string" ||
      !item.name.trim() ||
      item.name.length > MAX_COLLECTION
    )
      return "Collection invalide ou nom trop long (120 caractères maximum).";
  }
  const allowed = new Set([
    "unsorted",
    "learning",
    "watch",
    "favorites",
    ...data.collections.map((x) => x.id),
  ]);
  for (const item of data.favorites) {
    if (
      !item ||
      !validId(item.id) ||
      typeof item.text !== "string" ||
      !item.text.trim() ||
      item.text.length > MAX_TEXT ||
      !validDate(item.createdAt)
    )
      return "Un favori dépasse les limites autorisées.";
  }
  for (const item of data.links) {
    if (
      !item ||
      !validId(item.id) ||
      typeof item.title !== "string" ||
      !item.title.trim() ||
      item.title.length > MAX_TITLE ||
      !validDate(item.createdAt) ||
      !allowed.has(item.collection)
    )
      return "Lien ou collection invalide.";
    try {
      const url = new URL(item.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.href.length > MAX_URL
      )
        return "Adresse de lien invalide ou trop longue.";
    } catch {
      return "Adresse de lien invalide.";
    }
  }
  if (byteLength(JSON.stringify(data)) > MAX_BYTES)
    return "Limite de bibliothèque atteinte (200 000 octets). Exporte tes données avant de réduire la bibliothèque.";
  return null;
}
function normalizeData(src) {
  const s = src && typeof src === "object" ? src : {};
  const favorites = Array.isArray(s.favorites)
    ? s.favorites
        .filter((x) => x && typeof x === "object" && safeText(x.text).trim())
        .map((x) => ({
          id: safeText(x.id) || uid(),
          text: safeText(x.text),
          mode: x.mode === "optimize" ? "optimize" : "generate",
          createdAt: safeText(x.createdAt) || new Date().toISOString(),
        }))
    : [];
  const links = Array.isArray(s.links)
    ? s.links
        .map((x) => {
          try {
            const u = new URL(safeText(x?.url));
            if (
              !x ||
              !["http:", "https:"].includes(u.protocol) ||
              u.username ||
              u.password
            )
              return null;
            return {
              id: safeText(x.id) || uid(),
              url: u.href,
              title: safeText(x.title) || u.hostname,
              collection: safeText(x.collection) || "unsorted",
              createdAt: safeText(x.createdAt) || new Date().toISOString(),
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    : [];
  const collections = Array.isArray(s.collections)
    ? s.collections
        .filter((x) => x && safeText(x.id) && safeText(x.name).trim())
        .map((x) => ({ id: safeText(x.id), name: safeText(x.name).trim() }))
    : [];
  return { favorites, links, collections };
}
function persist() {
  try {
    // One atomic localStorage write keeps the local data and its merge base consistent.
    const value = state.user
      ? { data: state.data, base: state.baseRemote }
      : state.data;
    localStorage.setItem(cacheKey(), JSON.stringify(value));
    updateCounts();
    return true;
  } catch {
    showStatus(
      "Impossible d’enregistrer les données locales. Exporte une copie avant de fermer cette page.",
      true,
    );
    updateCounts();
    return false;
  }
}
function persistBase() {
  persist();
}
function loadBase(user = state.user) {
  if (!user) return null;
  const cached = readJSON(cacheKey(user), null);
  if (cached && Object.prototype.hasOwnProperty.call(cached, "data"))
    return cached.base ? normalizeData(cached.base) : null;
  const oldBase = readJSON(BASE_PREFIX + user.id, null);
  return oldBase ? normalizeData(oldBase) : null;
}
function escapeHTML(v) {
  return safeText(v).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function updateCounts() {
  $("totalCount").textContent =
    `${state.data.favorites.length + state.data.links.length} éléments`;
  $("favoriteCount").textContent = state.data.favorites.length;
  $("linkCount").textContent = state.data.links.length;
}
function showStatus(m, error = false) {
  $("statusMessage").textContent = m;
  $("statusMessage").classList.toggle("error", error);
}
function syncStatus(m, error = false) {
  const el = $("syncStatus");
  if (el) {
    el.textContent = m;
    el.classList.toggle("error", error);
  }
}
function setMode(m) {
  state.mode = m;
  document
    .querySelectorAll(".mode-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  $("toolEyebrow").textContent =
    m === "generate" ? "PROMPT STUDIO" : "OPTIMISEUR DE PROMPTS";
  $("toolTitle").textContent =
    m === "generate" ? "Transforme ton idée" : "Améliore ton prompt";
  $("promptLabel").textContent =
    m === "generate"
      ? "Quelle idée veux-tu transformer en prompt ?"
      : "Colle le prompt que tu veux améliorer.";
  $("promptInput").placeholder =
    m === "generate"
      ? "Ex. : Aide-moi à apprendre les maths en Première S…"
      : "Colle ici ton prompt actuel…";
  $("runBtnText").textContent =
    m === "generate" ? "Générer mon prompt" : "Optimiser mon prompt";
}
async function runAI() {
  const prompt = $("promptInput").value.trim();
  if (!prompt) return showStatus("Écris d’abord une idée ou un prompt.", true);
  const requestedMode = state.mode;
  const btn = $("runAiBtn");
  btn.disabled = true;
  btn.textContent = "L’IA réfléchit…";
  $("resultWrap").hidden = true;
  $("saveFavoriteBtn").classList.remove("saved");
  $("saveFavoriteBtn").textContent = "♡ Favori";
  state.aiController?.abort();
  const c = new AbortController();
  state.aiController = c;
  const timer = setTimeout(() => c.abort(), 30000);
  try {
    const r = await fetch(apiPath("/api/" + requestedMode), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
      signal: c.signal,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Error(d.error || `Erreur serveur (${r.status})`);
    const result = safeText(d.result || d.response || d.text);
    if (!result.trim()) throw Error("Résultat vide.");
    state.lastResult = result;
    state.lastMode = requestedMode;
    $("resultText").textContent = result;
    $("resultWrap").hidden = false;
    showStatus("Résultat généré par l’IA.");
  } catch (e) {
    showStatus(
      e.name === "AbortError"
        ? "La requête IA a expiré."
        : `Impossible de joindre l’IA : ${e.message}`,
      true,
    );
  } finally {
    clearTimeout(timer);
    if (state.aiController === c) state.aiController = null;
    btn.disabled = false;
    btn.innerHTML = `<span>✦</span> <span id="runBtnText">${state.mode === "generate" ? "Générer mon prompt" : "Optimiser mon prompt"}</span>`;
  }
}
function changed() {
  if (persist()) {
    renderSaved();
    queueSync();
  }
}
function prospective(mutator) {
  const copy = JSON.parse(JSON.stringify(state.data));
  mutator(copy);
  const error = validData(copy);
  const shrinking =
    byteLength(JSON.stringify(copy)) < byteLength(JSON.stringify(state.data));
  if (error && !shrinking) {
    showStatus(error, true);
    return false;
  }
  state.data = copy;
  const saved = persist();
  renderSaved();
  queueSync();
  if (!saved)
    showStatus("Modification en mémoire uniquement : exporte une copie.", true);
  return saved;
}
function saveFavorite() {
  if (!state.lastResult) return;
  if (state.data.favorites.some((x) => x.text === state.lastResult))
    return showStatus("Ce résultat est déjà dans tes favoris.");
  if (
    prospective((d) =>
      d.favorites.unshift({
        id: uid(),
        text: state.lastResult,
        mode: state.lastMode,
        createdAt: new Date().toISOString(),
      }),
    )
  ) {
    $("saveFavoriteBtn").classList.add("saved");
    $("saveFavoriteBtn").textContent = "♥ Sauvegardé";
    showStatus("Prompt ajouté aux favoris.");
  }
}
function addLink(raw, title = "", collection = "unsorted") {
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
      throw 0;
    const ok = prospective((d) =>
      d.links.unshift({
        id: uid(),
        url: u.href,
        title: title.trim() || u.hostname,
        collection,
        createdAt: new Date().toISOString(),
      }),
    );
    if (ok) showStatus("Lien enregistré sur cet appareil.");
    return ok;
  } catch {
    showStatus("Entre une adresse HTTP ou HTTPS valide.", true);
    return false;
  }
}
const collectionLabel = (v) =>
  ({
    unsorted: "Sans dossier",
    learning: "Études & recherche",
    watch: "À voir",
    favorites: "Favoris",
  })[v] ||
  (state.data.collections.find((c) => c.id === v) || {}).name ||
  "Personnelle";
function renderSaved() {
  renderCollections();
  const list = $("savedList");
  list.innerHTML = "";
  let items = state.data.links.map((x) => ({ ...x, kind: "link" }));
  if (state.filter !== "all")
    items = items.filter((x) => x.collection === state.filter);
  $("emptyLinks").textContent =
    state.filter === "favorites"
      ? "Tes prompts favoris apparaîtront ici."
      : "Tes liens enregistrés apparaîtront ici.";
  items.forEach((x) =>
    list.insertAdjacentHTML(
      "beforeend",
      `<div class="saved-item"><div class="saved-item-main"><div class="saved-item-title">${escapeHTML(x.title)}</div><div class="saved-item-sub">${escapeHTML(x.url)} · ${escapeHTML(collectionLabel(x.collection))}</div></div><div class="saved-item-actions"><button data-action="open" data-id="${escapeHTML(x.id)}">Ouvrir ↗</button><button data-action="delete-link" data-id="${escapeHTML(x.id)}">×</button></div></div>`,
    ),
  );
  if (state.filter === "favorites")
    state.data.favorites.forEach((x) =>
      list.insertAdjacentHTML(
        "beforeend",
        `<div class="saved-item"><div class="saved-item-main"><div class="saved-item-title">Prompt ${x.mode === "optimize" ? "optimisé" : "généré"}</div><div class="saved-item-sub">${escapeHTML(x.text.slice(0, 180))}${x.text.length > 180 ? "…" : ""}</div></div><div class="saved-item-actions"><button data-action="copy-fav" data-id="${escapeHTML(x.id)}">Copier</button><button data-action="delete-fav" data-id="${escapeHTML(x.id)}">×</button></div></div>`,
      ),
    );
  $("emptyLinks").hidden =
    items.length > 0 ||
    (state.filter === "favorites" && state.data.favorites.length > 0);
}
function searchAll(q) {
  q = q.trim().toLowerCase();
  const r = [
    ...state.data.links
      .filter((x) => `${x.title} ${x.url}`.toLowerCase().includes(q))
      .map((x) => ({ t: x.title, s: "Lien" })),
    ...state.data.favorites
      .filter((x) => x.text.toLowerCase().includes(q))
      .map((x) => ({ t: x.text.slice(0, 80), s: "Prompt favori" })),
  ];
  $("searchResults").innerHTML = r.length
    ? r
        .map(
          (x) =>
            `<div class="saved-item"><div class="saved-item-main"><div class="saved-item-title">${escapeHTML(x.t)}</div><div class="saved-item-sub">${x.s}</div></div></div>`,
        )
        .join("")
    : '<p class="empty-state">Aucun résultat.</p>';
}
async function authFetch(path, opts = {}, captured = state.token) {
  const h = new Headers(opts.headers || {});
  if (captured) h.set("Authorization", "Bearer " + captured);
  if (opts.body && !h.has("Content-Type"))
    h.set("Content-Type", "application/json");
  const r = await fetch(apiPath(path), { ...opts, headers: h });
  if (r.status === 401 && captured === state.token) {
    await endSession(false, captured);
    throw Error("Session expirée. Tes données locales sont conservées.");
  }
  return r;
}
function setToken(t, u) {
  state.token = t;
  state.user = u;
  try {
    localStorage.setItem(
      "promptlab-session-v1",
      JSON.stringify({ token: t, user: u }),
    );
    localStorage.setItem(TOKEN_KEY, t);
    localStorage.setItem(USER_KEY, JSON.stringify(u));
  } catch {}
}
function clearRecovery() {
  $("recoveryOnce").hidden = true;
  $("recoveryCodeLabel").textContent = "";
}
async function loadAccount() {
  let token = null;
  try {
    token = localStorage.getItem(TOKEN_KEY);
  } catch {}
  let user = readJSON(USER_KEY, null);
  const savedSession = readJSON("promptlab-session-v1", null);
  if (savedSession?.token && savedSession?.user) {
    token = savedSession.token;
    user = savedSession.user;
  }
  state.token = token;
  state.user = user;
  if (!token || !user) {
    state.token = null;
    state.user = null;
    state.baseRemote = null;
    state.data = loadCache(ANON_KEY);
    return;
  }
  const captured = token,
    uidAccount = user.id;
  state.data = loadCache(CACHE_PREFIX + uidAccount);
  state.baseRemote = loadBase(user);
  updateAccountUI();
  renderSaved();
  try {
    const r = await authFetch("/api/auth/me", {}, captured);
    if (!r.ok) throw 0;
    const d = await r.json();
    if (state.token !== captured || state.user?.id !== uidAccount) return;
    state.user = d.user;
    if (d.user.id !== uidAccount) {
      state.data = loadCache(cacheKey(d.user));
      state.baseRemote = loadBase(d.user);
    }
    setToken(captured, d.user);
    await pullLibrary(captured, d.user.id);
  } catch (e) {
    if (state.token === captured)
      syncStatus("synchronisation hors connexion", false);
  }
  persist();
  updateAccountUI();
  renderSaved();
}
function loadCache(key) {
  const cached = readJSON(key, blank());
  return normalizeData(
    cached && Object.prototype.hasOwnProperty.call(cached, "data")
      ? cached.data
      : cached,
  );
}
function isDirty(local = state.data, base = state.baseRemote) {
  return JSON.stringify(local) !== JSON.stringify(base || blank());
}
async function pullLibrary(token = state.token, accountId = state.user?.id) {
  const response = await authFetch("/api/library", {}, token);
  if (!response.ok) throw Error("Bibliothèque indisponible");
  const payload = await response.json();
  if (token !== state.token || accountId !== state.user?.id) return;
  const remote = normalizeData(payload.data);
  // Merge against the OLD base before advancing it: otherwise offline removals
  // and remote additions would be interpreted as new local deletions.
  state.data = mergeData(state.data, state.baseRemote || blank(), remote);
  state.baseRemote = remote;
  persist();
  renderSaved();
  state.queued = isDirty();
  if (state.queued) queueSync();
  else syncStatus("Synchronisé", false);
}
function mergeArray(local, base, remote) {
  const lm = new Map(local.map((x) => [x.id, x])),
    bm = new Map(base.map((x) => [x.id, x])),
    rm = new Map(remote.map((x) => [x.id, x])),
    out = [];
  new Set([...lm.keys(), ...bm.keys(), ...rm.keys()]).forEach((id) => {
    const l = lm.get(id),
      b = bm.get(id),
      r = rm.get(id),
      lc = JSON.stringify(l) !== JSON.stringify(b),
      rc = JSON.stringify(r) !== JSON.stringify(b);
    const v = lc ? l : r;
    if (v) out.push(v);
  });
  return out;
}
function mergeData(local, base, remote) {
  return {
    favorites: mergeArray(local.favorites, base.favorites, remote.favorites),
    links: mergeArray(local.links, base.links, remote.links),
    collections: mergeArray(
      local.collections,
      base.collections,
      remote.collections,
    ),
  };
}
function queueSync(delay = 700) {
  if (!state.token) return;
  state.queued = true;
  syncStatus("Synchronisation en attente", false);
  clearTimeout(state.syncTimer);
  state.syncTimer = setTimeout(syncLibrary, delay);
}
async function syncLibrary() {
  if (!state.token || state.syncBusy || !state.queued) return;
  const token = state.token,
    accountId = state.user?.id;
  const stillCurrent = () =>
    token === state.token && accountId === state.user?.id;
  state.syncBusy = true;
  state.queued = false;
  let failed = false;
  syncStatus("Synchronisation en cours…", false);
  try {
    const read = await authFetch("/api/library", {}, token);
    if (!stillCurrent()) return;
    if (!read.ok) {
      const error = await read.json().catch(() => ({}));
      throw Error(error.error || "Bibliothèque indisponible");
    }
    const latest = await read.json();
    if (!stillCurrent()) return;
    const remote = normalizeData(latest.data);
    const base = state.baseRemote || blank();
    const snapshot = JSON.parse(JSON.stringify(state.data));
    const merged = mergeData(snapshot, base, remote);
    const validationError = validData(merged);
    if (validationError) throw Error(validationError);
    if (JSON.stringify(merged) === JSON.stringify(remote)) {
      state.data = merged;
      state.baseRemote = remote;
      persist();
      renderSaved();
      if (state.queued) queueSync();
      else syncStatus("Synchronisé", false);
      return;
    }
    const write = await authFetch(
      "/api/library",
      {
        method: "POST",
        body: JSON.stringify({ data: merged, revision: latest.revision }),
      },
      token,
    );
    const result = await write.json().catch(() => ({}));
    if (!stillCurrent()) return;
    if (write.status === 409) {
      const conflictRemote = normalizeData(result.data);
      state.data = mergeData(state.data, base, conflictRemote);
      state.baseRemote = conflictRemote;
      persist();
      renderSaved();
      state.queued = true;
      return;
    }
    if (!write.ok) throw Error(result.error || "Enregistrement indisponible");
    // Apply edits made while the POST was in flight on top of the accepted merge.
    state.data = mergeData(state.data, snapshot, merged);
    state.baseRemote = merged;
    persist();
    renderSaved();
    state.queued = isDirty();
    state.syncFailures = 0;
    syncStatus(
      state.queued ? "Modifications locales en attente" : "Synchronisé",
      false,
    );
  } catch (error) {
    if (stillCurrent()) {
      state.queued = true;
      failed = true;
      state.syncFailures = Math.min((state.syncFailures || 0) + 1, 6);
      syncStatus(
        error.message
          ? `Non synchronisé : ${error.message}`
          : "Hors connexion : données conservées sur cet appareil",
        true,
      );
    }
  } finally {
    state.syncBusy = false;
    if (state.token && state.queued) {
      clearTimeout(state.syncTimer);
      const delay = failed
        ? Math.min(60000, 1500 * 2 ** (state.syncFailures || 0))
        : 700;
      state.syncTimer = setTimeout(syncLibrary, delay);
    }
  }
}
async function endSession(callServer = true, captured = state.token) {
  const oldToken = captured;
  if (callServer && oldToken) {
    try {
      await authFetch("/api/auth/logout", { method: "POST" }, oldToken);
    } catch {}
  }
  if (state.token !== oldToken) return;
  state.token = null;
  state.user = null;
  state.baseRemote = null;
  state.queued = false;
  clearTimeout(state.syncTimer);
  clearRecovery();
  $("accountPassword").value = "";
  $("recoveryCode").value = "";
  $("recoveryPassword").value = "";
  try {
    localStorage.removeItem("promptlab-session-v1");
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {}
  state.data = loadCache(ANON_KEY);
  persist();
  renderSaved();
  updateAccountUI();
  syncStatus("hors connexion", false);
}
function accountMsg(m, e = false) {
  $("accountStatus").textContent = m;
  $("accountStatus").classList.toggle("error", e);
}
function updateAccountUI() {
  const on = !!state.token;
  $("clearDataBtn").textContent = on
    ? "Effacer ma bibliothèque synchronisée"
    : "Effacer les données locales";
  $("accountLoggedOut").hidden = on;
  $("accountLoggedIn").hidden = !on;
  $("accountEmailLabel").textContent = state.user?.email || "";
  $("accountBtn").title = on ? "Compte connecté" : "Compte";
}
async function submitAccount(e) {
  e.preventDefault();
  const email = $("accountEmail").value.trim(),
    password = $("accountPassword").value;
  if ([...password].length < 12 || password.length > 128)
    return accountMsg(
      "Le mot de passe doit contenir entre 12 et 128 caractères.",
      true,
    );
  const mode = state.accountMode,
    p = mode === "register" ? "/api/auth/register" : "/api/auth/login";
  try {
    const r = await fetch(apiPath(p), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
      d = await r.json().catch(() => ({}));
    if (!r.ok) throw Error(d.error || "Authentification impossible");
    clearRecovery();
    setToken(d.token, d.user);
    state.data = loadCache(cacheKey());
    state.baseRemote = loadBase();
    if (mode === "register" && d.recoveryCode) {
      $("recoveryCodeLabel").textContent = d.recoveryCode;
      $("recoveryOnce").hidden = false;
    }
    updateAccountUI();
    renderSaved();
    accountMsg("Compte connecté. Les données anonymes restent séparées.");
    try {
      await pullLibrary(state.token, state.user.id);
    } catch {
      syncStatus("synchronisation hors connexion", true);
    }
  } catch (x) {
    accountMsg(x.message, true);
  }
}
async function recover(e) {
  e.preventDefault();
  const password = $("recoveryPassword").value;
  if ([...password].length < 12 || password.length > 128)
    return accountMsg(
      "Le mot de passe doit contenir entre 12 et 128 caractères.",
      true,
    );
  try {
    const r = await fetch(apiPath("/api/auth/recover"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: $("accountEmail").value.trim(),
          recoveryCode: $("recoveryCode").value.trim(),
          password,
        }),
      }),
      d = await r.json().catch(() => ({}));
    if (!r.ok) throw Error(d.error || "Code invalide");
    $("recoveryBox").hidden = true;
    accountMsg("Mot de passe réinitialisé. Tu peux te connecter.");
  } catch (x) {
    accountMsg(x.message, true);
  }
}
function googleLogin() {
  if (window.google?.accounts?.id) google.accounts.id.prompt();
}
async function setupGoogle() {
  try {
    const r = await fetch(apiPath("/api/auth/config")),
      d = await r.json();
    if (!d.googleClientId) return;
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => {
      state.googleNonce = [...crypto.getRandomValues(new Uint8Array(24))]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
      google.accounts.id.initialize({
        client_id: d.googleClientId,
        nonce: state.googleNonce,
        callback: async (res) => {
          try {
            const r = await fetch(apiPath("/api/auth/google"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  credential: res.credential,
                  nonce: state.googleNonce,
                }),
              }),
              x = await r.json();
            if (!r.ok) throw Error(x.error || "Connexion Google impossible");
            clearRecovery();
            setToken(x.token, x.user);
            state.data = loadCache(cacheKey());
            state.baseRemote = loadBase();
            updateAccountUI();
            renderSaved();
            try {
              await pullLibrary(state.token, state.user.id);
            } catch {
              syncStatus("synchronisation hors connexion", true);
            }
            accountMsg("Compte Google connecté.");
          } catch (e) {
            accountMsg(e.message, true);
          }
        },
      });
      $("googleBtn").hidden = true;
      $("googleMessage").textContent = "Connexion Google disponible.";
      const box = $("googleButtonContainer");
      if (box)
        google.accounts.id.renderButton(box, {
          theme: "outline",
          size: "large",
          width: 320,
        });
    };
    document.head.appendChild(s);
  } catch {}
}
function importAnon() {
  if (!state.token) return accountMsg("Connecte-toi avant d’importer.", true);
  if (!confirm("Importer les données anonymes dans ce compte ?")) return;
  const anon = loadCache(ANON_KEY);
  if (
    prospective((d) => {
      const m = mergeData(anon, blank(), d);
      d.favorites = m.favorites;
      d.links = m.links;
      d.collections = m.collections;
    })
  )
    accountMsg("Données anonymes importées et synchronisation demandée.");
}
// UI wiring
$("runAiBtn").addEventListener("click", runAI);
document
  .querySelectorAll(".mode-btn")
  .forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
document.querySelectorAll(".collection-card").forEach((b) =>
  b.addEventListener("click", () => {
    if (["generate", "optimize"].includes(b.dataset.view)) {
      setMode(b.dataset.view);
      $("toolPanel").scrollIntoView({ behavior: "smooth" });
    } else {
      state.filter = b.dataset.view === "favorites" ? "favorites" : "all";
      renderSaved();
      $("linksPanel").scrollIntoView({ behavior: "smooth" });
    }
  }),
);
$("saveFavoriteBtn").addEventListener("click", saveFavorite);
$("copyResultBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(state.lastResult);
    showStatus("Résultat copié.");
  } catch {
    showStatus("Copie indisponible.", true);
  }
});
$("quickAddBtn").addEventListener("click", () => {
  const v = $("quickInput").value.trim();
  if (!v) return;
  if (/^https?:\/\//i.test(v)) {
    if (addLink(v)) $("quickInput").value = "";
  } else {
    $("promptInput").value = v;
    setMode("generate");
    $("quickInput").value = "";
  }
});
$("quickInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("quickAddBtn").click();
  }
});
$("linkForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (
    addLink($("linkUrl").value, $("linkTitle").value, $("linkCollection").value)
  ) {
    $("linkUrl").value = "";
    $("linkTitle").value = "";
  }
});
$("collectionFilters").addEventListener("click", (e) => {
  const b = e.target.closest("[data-filter]");
  if (b) {
    state.filter = b.dataset.filter;
    document
      .querySelectorAll(".filter-chip")
      .forEach((x) => x.classList.toggle("active", x === b));
    renderSaved();
  }
});
$("savedList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-action]");
  if (!b) return;
  const id = b.dataset.id;
  if (b.dataset.action === "open") {
    const x = state.data.links.find((x) => x.id === id);
    if (x) window.open(x.url, "_blank", "noopener,noreferrer");
  } else if (b.dataset.action === "delete-link")
    prospective((d) => (d.links = d.links.filter((x) => x.id !== id)));
  else if (b.dataset.action === "delete-fav")
    prospective((d) => (d.favorites = d.favorites.filter((x) => x.id !== id)));
  else if (b.dataset.action === "copy-fav") {
    const x = state.data.favorites.find((x) => x.id === id);
    if (x)
      try {
        await navigator.clipboard.writeText(x.text);
        showStatus("Prompt copié.");
      } catch {}
  }
  renderSaved();
});
$("settingsBtn").addEventListener("click", () =>
  $("settingsDialog").showModal(),
);
$("searchBtn").addEventListener("click", () => {
  $("searchDialog").showModal();
  searchAll("");
  $("searchInput").focus();
});
$("searchInput").addEventListener("input", (e) => searchAll(e.target.value));
$("accountBtn").addEventListener("click", () => {
  $("accountDialog").showModal();
  updateAccountUI();
});
$("accountForm").addEventListener("submit", submitAccount);
$("recoveryForm").addEventListener("submit", recover);
$("recoverBtn").addEventListener(
  "click",
  () => ($("recoveryBox").hidden = !$("recoveryBox").hidden),
);
$("logoutBtn").addEventListener("click", () => endSession(true));
$("importAnonBtn").addEventListener("click", importAnon);
document.querySelectorAll("[data-account-mode]").forEach((b) =>
  b.addEventListener("click", () => {
    state.accountMode = b.dataset.accountMode;
    clearRecovery();
    document
      .querySelectorAll("[data-account-mode]")
      .forEach((x) => x.classList.toggle("active", x === b));
    $("accountSubmit").textContent =
      state.accountMode === "register" ? "Créer mon compte" : "Se connecter";
  }),
);
$("googleBtn").addEventListener("click", googleLogin);
$("exportDataBtn").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(state.data, null, 2)], {
      type: "application/json",
    }),
  );
  a.download = "promptlab-backup.json";
  a.click();
});
$("clearDataBtn").addEventListener("click", () => {
  const message = state.token
    ? "Effacer ces données locales et supprimer cette bibliothèque du compte synchronisé ? Cette suppression sera synchronisée."
    : "Effacer définitivement les données locales ?";
  if (confirm(message)) {
    state.data = blank();
    persist();
    renderSaved();
    $("settingsDialog").close();
    queueSync();
  }
});
$("addCollectionBtn").addEventListener("click", () => {
  const name = prompt("Nom de la collection (1 à 120 caractères)");
  if (name && [...name.trim()].length <= MAX_COLLECTION)
    prospective((d) =>
      d.collections.push({ id: "c-" + cryptoRandom(), name: name.trim() }),
    );
  else if (name) showStatus("Le nom doit contenir 1 à 120 caractères.", true);
});
window.addEventListener("focus", () => {
  if (state.token) queueSync(100);
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.token) queueSync(100);
});
state.data = loadCache(ANON_KEY);
updateCounts();
renderSaved();
setMode("generate");
syncStatus("hors connexion", false);
loadAccount();
setupGoogle();

function renderCollections() {
  const select = $("linkCollection"),
    filters = $("collectionFilters");
  const selected = select.value;
  select
    .querySelectorAll("[data-custom-collection]")
    .forEach((x) => x.remove());
  filters
    .querySelectorAll("[data-custom-collection]")
    .forEach((x) => x.remove());
  for (const collection of state.data.collections) {
    const option = document.createElement("option");
    option.value = collection.id;
    option.textContent = collection.name;
    option.dataset.customCollection = "true";
    select.appendChild(option);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "filter-chip";
    button.dataset.filter = collection.id;
    button.dataset.customCollection = "true";
    button.textContent = collection.name;
    button.classList.toggle("active", state.filter === collection.id);
    filters.appendChild(button);
  }
  if ([...select.options].some((option) => option.value === selected))
    select.value = selected;
}
window.addEventListener("online", () => {
  if (state.token) queueSync(100);
});
