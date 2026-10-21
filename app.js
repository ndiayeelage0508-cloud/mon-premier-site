/*
 * PromptLab combined frontend.
 * IMPORTANT: configure API_BASE with the public URL of your Cloudflare Worker.
 * Example: https://promptlab-ai.YOUR-SUBDOMAIN.workers.dev
 */
const API_BASE = "https://promptlab-ai.ndiayeelage0508.workers.dev";
const STORAGE_KEY = "promptlab-combined-v1";
const $ = (id) => document.getElementById(id);
const state = { mode: "generate", filter: "all", lastResult: "", lastMode: "generate", data: loadData() };

function normalizeData(parsed) {
  const source = parsed && typeof parsed === "object" ? parsed : {};
  const favorites = Array.isArray(source.favorites) ? source.favorites.filter(x => x && typeof x === "object" && typeof x.text === "string" && x.text.trim()).map(x => ({
    id: safeText(x.id) || uid(), text: x.text, mode: x.mode === "optimize" ? "optimize" : "generate", createdAt: safeText(x.createdAt) || new Date().toISOString()
  })) : [];
  const links = Array.isArray(source.links) ? source.links.filter(x => x && typeof x === "object").map(x => {
    try {
      const url = new URL(safeText(x.url));
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
      return { id: safeText(x.id) || uid(), url: url.href, title: safeText(x.title) || url.hostname, collection: ["unsorted", "learning", "watch", "favorites"].includes(x.collection) ? x.collection : "unsorted", createdAt: safeText(x.createdAt) || new Date().toISOString() };
    } catch { return null; }
  }).filter(Boolean) : [];
  return { favorites, links, collections: Array.isArray(source.collections) ? source.collections.filter(x => x && typeof x === "object") : [] };
}
function loadData() {
  try { return normalizeData(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")); }
  catch { return normalizeData({}); }
}
function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
    updateCounts();
    return true;
  } catch {
    updateCounts();
    return false;
  }
}
function uid() { return `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function safeText(value) { return String(value ?? ""); }
function escapeHTML(value) {
  return safeText(value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
function updateCounts() {
  $("totalCount").textContent = `${state.data.favorites.length + state.data.links.length} éléments`;
  $("favoriteCount").textContent = state.data.favorites.length;
  $("linkCount").textContent = state.data.links.length;
}
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  $("toolEyebrow").textContent = mode === "generate" ? "PROMPT STUDIO" : "OPTIMISEUR DE PROMPTS";
  $("toolTitle").textContent = mode === "generate" ? "Transforme ton idée" : "Améliore ton prompt";
  $("promptLabel").textContent = mode === "generate" ? "Quelle idée veux-tu transformer en prompt ?" : "Colle le prompt que tu veux améliorer.";
  $("promptInput").placeholder = mode === "generate" ? "Ex. : Aide-moi à apprendre les maths en Première S…" : "Colle ici ton prompt actuel…";
  $("runBtnText").textContent = mode === "generate" ? "Générer mon prompt" : "Optimiser mon prompt";
}
async function runAI() {
  const prompt = $("promptInput").value.trim();
  if (!prompt) { showStatus("Écris d’abord une idée ou un prompt.", true); return; }
  if (API_BASE.includes("REPLACE-WITH-YOUR-WORKER-URL")) {
    showStatus("La connexion API n’est pas encore configurée : remplace API_BASE dans app.js par l’URL réelle du Worker.", true); return;
  }
  const requestedMode = state.mode;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);
  const btn = $("runAiBtn");
  btn.disabled = true; btn.textContent = "L’IA réfléchit…"; showStatus("");
  $("resultWrap").hidden = true;
  try {
    const response = await fetch(`${API_BASE.replace(/\/$/, "")}/api/${requestedMode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Erreur serveur (${response.status})`);
    const result = data.result || data.response || data.text;
    if (!result) throw new Error("Le serveur n’a pas renvoyé de texte.");
    state.lastResult = String(result); state.lastMode = requestedMode;
    $("resultText").textContent = state.lastResult;
    $("resultWrap").hidden = false;
    $("saveFavoriteBtn").classList.remove("saved"); $("saveFavoriteBtn").textContent = "♡ Favori";
    showStatus("Résultat généré par l’IA.");
  } catch (err) {
    showStatus(`Impossible de joindre l’IA : ${err.message}. Vérifie l’URL du Worker, son binding AI et CORS.`, true);
  } finally {
    clearTimeout(timeoutId);
    btn.disabled = false;
    btn.innerHTML = `<span>✦</span> <span id="runBtnText">${state.mode === "generate" ? "Générer mon prompt" : "Optimiser mon prompt"}</span>`;
  }
}
function showStatus(message, error = false) {
  $("statusMessage").textContent = message;
  $("statusMessage").classList.toggle("error", error);
}
function saveFavorite() {
  if (!state.lastResult) return;
  const exists = state.data.favorites.some(x => x.text === state.lastResult);
  if (exists) { showStatus("Ce résultat est déjà dans tes favoris."); return; }
  state.data.favorites.unshift({ id: uid(), text: state.lastResult, mode: state.lastMode, createdAt: new Date().toISOString() });
  const saved = persist(); renderSaved();
  $("saveFavoriteBtn").classList.toggle("saved", saved); $("saveFavoriteBtn").textContent = saved ? "♥ Sauvegardé" : "♡ En mémoire";
  showStatus(saved ? "Prompt ajouté aux favoris." : "Prompt ajouté en mémoire ; impossible de l’enregistrer localement.", !saved);
}
function addLink(rawUrl, title = "", collection = "unsorted") {
  let url;
  try { url = new URL(rawUrl); } catch { showStatus("Entre une adresse de lien valide, par exemple https://example.com.", true); return false; }
  if (!["http:", "https:"].includes(url.protocol)) { showStatus("Seuls les liens HTTP et HTTPS sont acceptés.", true); return false; }
  if (url.username || url.password) { showStatus("Les liens contenant des identifiants ne sont pas acceptés.", true); return false; }
  state.data.links.unshift({ id: uid(), url: url.href, title: title.trim() || url.hostname, collection, createdAt: new Date().toISOString() });
  const saved = persist(); renderSaved(); showStatus(saved ? "Lien enregistré sur cet appareil." : "Lien ajouté en mémoire ; impossible de l’enregistrer localement.", !saved);
  return true;
}
function collectionLabel(value) {
  return ({unsorted:"Sans dossier",learning:"Études & recherche",watch:"À voir",favorites:"Favoris"})[value] || "Personnelle";
}
function renderSaved() {
  const list = $("savedList"); list.innerHTML = "";
  let items = state.data.links.map(x => ({...x, kind:"link"}));
  if (state.filter !== "all") items = items.filter(x => x.collection === state.filter);
  if (state.filter === "all") items = state.data.links.map(x => ({...x,kind:"link"}));
  if (state.filter === "favorites") $("emptyLinks").textContent = "Tes prompts favoris apparaîtront ici.";
  else $("emptyLinks").textContent = "Tes liens enregistrés apparaîtront ici.";
  $("emptyLinks").hidden = items.length > 0 || (state.filter === "favorites" && state.data.favorites.length > 0);
  items.forEach(item => {
    const row = document.createElement("div"); row.className = "saved-item";
    row.innerHTML = `<div class="saved-item-main"><div class="saved-item-title">${escapeHTML(item.title)}</div><div class="saved-item-sub">${escapeHTML(item.url)} · ${escapeHTML(collectionLabel(item.collection))}</div></div><div class="saved-item-actions"><button data-action="open" data-id="${escapeHTML(item.id)}">Ouvrir ↗</button><button data-action="delete-link" data-id="${escapeHTML(item.id)}" aria-label="Supprimer">×</button></div>`;
    list.appendChild(row);
  });
  if (state.filter === "favorites") {
    state.data.favorites.forEach(item => {
      const row = document.createElement("div"); row.className = "saved-item";
      row.innerHTML = `<div class="saved-item-main"><div class="saved-item-title">Prompt ${escapeHTML(item.mode === "optimize" ? "optimisé" : "généré")}</div><div class="saved-item-sub">${escapeHTML(item.text.slice(0,180))}${item.text.length>180?"…":""}</div></div><div class="saved-item-actions"><button data-action="copy-fav" data-id="${escapeHTML(item.id)}">Copier</button><button data-action="delete-fav" data-id="${escapeHTML(item.id)}">×</button></div>`;
      list.appendChild(row);
    });
    $("emptyLinks").hidden = state.data.favorites.length > 0;
  }
}
function openView(view) {
  if (view === "generate" || view === "optimize") {
    setMode(view); $("toolPanel").scrollIntoView({behavior:"smooth",block:"start"}); $("promptInput").focus({preventScroll:true});
  } else {
    state.filter = view === "favorites" ? "favorites" : "all";
    document.querySelectorAll(".filter-chip").forEach(b => b.classList.toggle("active", b.dataset.filter === state.filter));
    renderSaved(); $("linksPanel").scrollIntoView({behavior:"smooth",block:"start"});
  }
}
function searchAll(query) {
  const q = query.trim().toLowerCase();
  const results = [
    ...state.data.links.filter(x => !q || `${x.title} ${x.url} ${collectionLabel(x.collection)}`.toLowerCase().includes(q)).map(x => ({type:"Lien",title:x.title,detail:x.url})),
    ...state.data.favorites.filter(x => !q || x.text.toLowerCase().includes(q)).map(x => ({type:"Prompt favori",title:x.text.slice(0,80),detail:x.text}))
  ];
  $("searchResults").innerHTML = results.length ? results.map(x=>`<div class="saved-item"><div class="saved-item-main"><div class="saved-item-title">${escapeHTML(x.title)}</div><div class="saved-item-sub">${escapeHTML(x.type)}</div></div></div>`).join("") : '<p class="empty-state">Aucun résultat.</p>';
}
document.querySelectorAll(".mode-btn").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));
document.querySelectorAll(".collection-card").forEach(b => b.addEventListener("click", () => openView(b.dataset.view)));
$("runAiBtn").addEventListener("click", runAI);
$("saveFavoriteBtn").addEventListener("click", saveFavorite);
$("copyResultBtn").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(state.lastResult); showStatus("Résultat copié."); }
  catch { showStatus("La copie automatique est indisponible sur ce navigateur.", true); }
});
$("quickAddBtn").addEventListener("click", () => {
  const value = $("quickInput").value.trim(); if (!value) return;
  if (/^https?:\/\//i.test(value)) { if (addLink(value)) $("quickInput").value = ""; }
  else { $("promptInput").value = value; setMode("generate"); $("toolPanel").scrollIntoView({behavior:"smooth"}); $("quickInput").value = ""; }
});
$("quickInput").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $("quickAddBtn").click(); }});
$("linkForm").addEventListener("submit", e => {
  e.preventDefault();
  if (addLink($("linkUrl").value, $("linkTitle").value, $("linkCollection").value)) { $("linkUrl").value=""; $("linkTitle").value=""; }
});
$("collectionFilters").addEventListener("click", e => {
  const btn = e.target.closest("[data-filter]"); if (!btn) return;
  state.filter = btn.dataset.filter;
  document.querySelectorAll(".filter-chip").forEach(b => b.classList.toggle("active", b === btn));
  renderSaved();
});
$("savedList").addEventListener("click", async e => {
  const btn = e.target.closest("button[data-action]"); if (!btn) return;
  const item = btn.dataset.id;
  if (btn.dataset.action === "open") { const link = state.data.links.find(x=>x.id===item); if(link) window.open(link.url,"_blank","noopener,noreferrer"); }
  if (btn.dataset.action === "delete-link") state.data.links = state.data.links.filter(x=>x.id!==item);
  if (btn.dataset.action === "delete-fav") state.data.favorites = state.data.favorites.filter(x=>x.id!==item);
  if (btn.dataset.action === "copy-fav") { const fav=state.data.favorites.find(x=>x.id===item); if(fav){try{await navigator.clipboard.writeText(fav.text);showStatus("Prompt copié.")}catch{showStatus("Copie indisponible.",true)}} }
  const saved = persist(); renderSaved();
  if (!saved) showStatus("Modification conservée en mémoire ; impossible de l’enregistrer localement.", true);
});
$("settingsBtn").addEventListener("click", () => $("settingsDialog").showModal());
$("searchBtn").addEventListener("click", () => { $("searchDialog").showModal(); searchAll(""); $("searchInput").focus(); });
$("searchInput").addEventListener("input", e => searchAll(e.target.value));
$("exportDataBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state.data,null,2)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="promptlab-backup.json";a.click();URL.revokeObjectURL(a.href);
});
$("clearDataBtn").addEventListener("click", () => {
  if (confirm("Effacer tous les prompts favoris et les liens enregistrés dans ce navigateur ?")) {
    state.data={favorites:[],links:[],collections:[]};
    const saved = persist(); renderSaved(); $("settingsDialog").close();
    showStatus(saved ? "Données locales effacées." : "Données effacées en mémoire ; impossible de modifier le stockage local.", !saved);
  }
});
$("addCollectionBtn").addEventListener("click", () => alert("Les collections prédéfinies sont disponibles. La création de collections personnalisées pourra être ajoutée ensuite."));
updateCounts(); renderSaved(); setMode("generate");
