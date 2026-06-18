/* ============================================================
   DEX REACTOR — lógica
   Scanner imersivo de criaturas sobre a PokéAPI.
   ============================================================ */

const API_BASE = "https://pokeapi.co/api/v2";
const PAGE_SIZE = 30;
const MAX_DEX = 1025;
const FAVORITE_KEY = "dexreactor-fav-v1";
const SOUND_KEY = "dexreactor-sound-v1";

const TYPE_COLORS = {
    normal: "#9fa4af", fire: "#ff7a2d", water: "#4f9bff", electric: "#ffce3f",
    grass: "#57c84d", ice: "#74e0e3", fighting: "#ff5a5f", poison: "#b25be0",
    ground: "#e0a94b", flying: "#8fb4ff", psychic: "#ff6ca8", bug: "#9acb3c",
    rock: "#cbb069", ghost: "#8a7de0", dragon: "#7b6cff", dark: "#6e6a78",
    steel: "#8fa8bc", fairy: "#ff9ed6"
};
const TYPE_LABELS = {
    normal: "Normal", fire: "Fogo", water: "Água", electric: "Elétrico",
    grass: "Planta", ice: "Gelo", fighting: "Lutador", poison: "Venenoso",
    ground: "Terra", flying: "Voador", psychic: "Psíquico", bug: "Inseto",
    rock: "Pedra", ghost: "Fantasma", dragon: "Dragão", dark: "Sombrio",
    steel: "Aço", fairy: "Fada"
};
const STAT_SLOTS = [
    { key: "hp", label: "HP" }, { key: "attack", label: "ATK" }, { key: "defense", label: "DEF" },
    { key: "special-attack", label: "SpA" }, { key: "special-defense", label: "SpD" }, { key: "speed", label: "VEL" }
];

const TYPE_CHART = {
    normal: { se: [], nve: ["rock", "steel"], no: ["ghost"] },
    fire: { se: ["grass", "ice", "bug", "steel"], nve: ["fire", "water", "rock", "dragon"], no: [] },
    water: { se: ["fire", "ground", "rock"], nve: ["water", "grass", "dragon"], no: [] },
    electric: { se: ["water", "flying"], nve: ["electric", "grass", "dragon"], no: ["ground"] },
    grass: { se: ["water", "ground", "rock"], nve: ["fire", "grass", "poison", "flying", "bug", "dragon", "steel"], no: [] },
    ice: { se: ["grass", "ground", "flying", "dragon"], nve: ["fire", "water", "ice", "steel"], no: [] },
    fighting: { se: ["normal", "ice", "rock", "dark", "steel"], nve: ["poison", "flying", "psychic", "bug", "fairy"], no: ["ghost"] },
    poison: { se: ["grass", "fairy"], nve: ["poison", "ground", "rock", "ghost"], no: ["steel"] },
    ground: { se: ["fire", "electric", "poison", "rock", "steel"], nve: ["grass", "bug"], no: ["flying"] },
    flying: { se: ["grass", "fighting", "bug"], nve: ["electric", "rock", "steel"], no: [] },
    psychic: { se: ["fighting", "poison"], nve: ["psychic", "steel"], no: ["dark"] },
    bug: { se: ["grass", "psychic", "dark"], nve: ["fire", "fighting", "poison", "flying", "ghost", "steel", "fairy"], no: [] },
    rock: { se: ["fire", "ice", "flying", "bug"], nve: ["fighting", "ground", "steel"], no: [] },
    ghost: { se: ["psychic", "ghost"], nve: ["dark"], no: ["normal"] },
    dragon: { se: ["dragon"], nve: ["steel"], no: ["fairy"] },
    dark: { se: ["psychic", "ghost"], nve: ["fighting", "dark", "fairy"], no: [] },
    steel: { se: ["ice", "rock", "fairy"], nve: ["fire", "water", "electric", "steel"], no: [] },
    fairy: { se: ["fighting", "dragon", "dark"], nve: ["fire", "poison", "steel"], no: [] }
};
const ALL_TYPES = Object.keys(TYPE_CHART);

const SPREAD = 92; // distância entre itens da esteira

const state = {
    mode: "all", type: "", offset: 0, typeRefs: [], typeOffset: 0,
    list: [], activeIndex: 0,
    favorites: loadFavorites(), seen: new Set(),
    cache: new Map(), speciesCache: new Map(), evoCache: new Map(),
    detailToken: 0, shiny: false, isLoading: false
};

const dom = {};
const reelItems = [];
let searchDebounce, dragging = false, moved = false, startX = 0, startActive = 0, visualIndex = null, wheelLock = 0, layoutQueued = false;

document.addEventListener("DOMContentLoaded", init);

async function init() {
    hydrate();
    bindEvents();
    Sound.init();
    FX.init(dom.stageFx);
    updateDial();
    showReelSkeletons();

    await Promise.allSettled([loadTypes(), loadPage({ reset: true })]);

    // Dispensa o boot sem depender de rAF (que pausa em abas ocultas)
    setTimeout(() => { dom.boot.classList.add("done"); Sound.powerUp(); }, 320);
}

function hydrate() {
    ["boot", "stage", "stageFx", "ghostNum", "hudLeft", "hudRight", "creature", "creatureImg",
     "heroTypes", "heroName", "heroGenus", "dock", "reel", "reelView", "reelTrack", "reelPrev",
     "reelNext", "loadMoreButton", "searchForm", "searchInput", "searchClear", "typeOrbits",
     "favoriteCount", "seenCount", "statusLed", "soundToggle", "toast"]
        .forEach((id) => dom[id] = document.getElementById(id));
}

function bindEvents() {
    dom.searchForm.addEventListener("submit", (e) => { e.preventDefault(); clearTimeout(searchDebounce); runSearch(dom.searchInput.value.trim()); });
    dom.searchInput.addEventListener("input", () => {
        dom.searchClear.hidden = !dom.searchInput.value;
        clearTimeout(searchDebounce);
        const q = dom.searchInput.value.trim();
        searchDebounce = setTimeout(() => runSearch(q), 420);
    });
    dom.searchClear.addEventListener("click", () => { dom.searchInput.value = ""; dom.searchClear.hidden = true; backToAll(); });

    dom.soundToggle.addEventListener("click", () => Sound.toggle());

    dom.typeOrbits.addEventListener("click", (e) => {
        const orb = e.target.closest(".orb");
        if (orb) onOrb(orb.dataset.type);
    });

    dom.reelPrev.addEventListener("click", () => setActive(state.activeIndex - 1));
    dom.reelNext.addEventListener("click", () => setActive(state.activeIndex + 1));
    dom.loadMoreButton.addEventListener("click", () => loadPage({ reset: false }));

    // Esteira: arraste, clique, roda
    dom.reelView.addEventListener("pointerdown", onDragStart);
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
    dom.reelTrack.addEventListener("click", (e) => {
        if (moved) return;
        const item = e.target.closest(".reel-item");
        if (item) setActive(Number(item.dataset.idx));
    });
    dom.reelView.addEventListener("wheel", (e) => {
        e.preventDefault();
        const now = Date.now();
        if (now < wheelLock) return;
        wheelLock = now + 80;
        setActive(state.activeIndex + ((e.deltaX || e.deltaY) > 0 ? 1 : -1));
    }, { passive: false });

    window.addEventListener("resize", () => layoutReel());

    document.addEventListener("keydown", (e) => {
        if (e.target.matches("input, select, textarea")) return;
        if (e.key === "/") { e.preventDefault(); dom.searchInput.focus(); }
        else if (e.key === "ArrowRight") setActive(state.activeIndex + 1);
        else if (e.key === "ArrowLeft") setActive(state.activeIndex - 1);
        else if (e.key.toLowerCase() === "r") surpriseMe();
    });
}

/* ===================== Tipos / órbitas ===================== */
async function loadTypes() {
    try {
        const data = await fetchJson(`${API_BASE}/type`);
        data.results.map((t) => t.name).filter((n) => TYPE_LABELS[n])
            .sort((a, b) => label(a).localeCompare(label(b), "pt-BR"))
            .forEach((t) => {
                const orb = document.createElement("button");
                orb.className = "orb";
                orb.type = "button";
                orb.dataset.type = t;
                orb.style.setProperty("--oc", color(t));
                orb.innerHTML = `<span class="od"></span>${label(t)}`;
                dom.typeOrbits.appendChild(orb);
            });
        setOnline(true);
    } catch { setOnline(false); }
}
function onOrb(t) {
    Sound.tick();
    if (t === "__fav") { state.mode = state.mode === "favorites" ? "all" : "favorites"; }
    else { state.type = t; if (state.mode === "search") state.mode = "all"; }
    dom.searchInput.value = ""; dom.searchClear.hidden = true;
    updateOrbs();
    if (state.mode === "favorites") renderFavorites();
    else loadPage({ reset: true });
}
function updateOrbs() {
    dom.typeOrbits.querySelectorAll(".orb").forEach((o) => {
        const t = o.dataset.type;
        if (t === "__fav") o.classList.toggle("is-on", state.mode === "favorites");
        else if (t === "") o.classList.toggle("is-on", state.type === "");
        else o.classList.toggle("is-on", state.type === t);
    });
}

/* ===================== Carregamento ===================== */
async function loadPage({ reset }) {
    if (state.isLoading) return;
    setLoading(true);
    if (reset) { state.offset = 0; state.typeOffset = 0; state.typeRefs = []; state.list = []; showReelSkeletons(); }
    try {
        const refs = state.type ? await typeRefs(reset) : await catalogueRefs();
        const incoming = await Promise.all(refs.map((r) => getPokemon(r.url)));
        const before = state.list.length;
        state.list = mergeById(state.list, incoming).sort((a, b) => a.id - b.id);
        markSeen(incoming);
        rebuildReel();
        setOnline(true);
        if (reset || before === 0) setActive(0, { silent: true });
    } catch {
        setOnline(false);
        if (!state.list.length) renderReelEmpty("A PokéAPI não respondeu.");
        toast("Falha ao sincronizar com a PokéAPI.");
    } finally {
        setLoading(false);
        updateLoadMore();
    }
}
async function catalogueRefs() {
    const data = await fetchJson(`${API_BASE}/pokemon?limit=${PAGE_SIZE}&offset=${state.offset}`);
    state.offset += PAGE_SIZE;
    return data.results;
}
async function typeRefs(reset) {
    if (reset || !state.typeRefs.length) {
        const data = await fetchJson(`${API_BASE}/type/${state.type}`);
        state.typeRefs = data.pokemon.map((e) => e.pokemon).filter((p) => extractId(p.url) <= MAX_DEX);
    }
    const slice = state.typeRefs.slice(state.typeOffset, state.typeOffset + PAGE_SIZE);
    state.typeOffset += slice.length;
    return slice;
}
function maybeLoadMore() {
    if (state.mode === "all" && !state.isLoading && state.activeIndex >= state.list.length - 6) {
        if (!state.type || state.typeOffset < state.typeRefs.length) loadPage({ reset: false });
    }
}

async function runSearch(query) {
    const q = normalizeQuery(query);
    if (!q) return backToAll();
    setLoading(true);
    state.mode = "search"; state.type = "";
    updateOrbs();
    showReelSkeletons(3);
    try {
        const p = await getPokemon(q);
        state.list = [p]; markSeen([p]);
        rebuildReel(); setActive(0);
        setOnline(true);
    } catch (err) {
        state.list = []; renderReelEmpty("Nenhuma criatura corresponde.");
        clearHero();
        setOnline(!String(err.message).includes("Failed"));
    } finally { setLoading(false); updateLoadMore(); }
}
function backToAll() {
    state.mode = "all"; state.type = "";
    updateOrbs();
    loadPage({ reset: true });
}
async function renderFavorites() {
    setLoading(true);
    showReelSkeletons(Math.min(Math.max(state.favorites.size, 1), 8));
    try {
        await Promise.all([...state.favorites].map((id) => getPokemon(id).catch(() => null)));
        favoritesFromCache();
        setOnline(true);
    } catch { setOnline(false); } finally { setLoading(false); updateLoadMore(); }
}
function favoritesFromCache() {
    state.list = [...state.favorites].map((id) => state.cache.get(String(id))).filter(Boolean)
        .filter((p) => !state.type || p.types.includes(state.type)).sort((a, b) => a.id - b.id);
    rebuildReel();
    if (state.list.length) setActive(0, { silent: true });
    else { renderReelEmpty("Nenhuma captura ainda."); clearHero(); }
}

/* ===================== Esteira (cover-flow) ===================== */
function showReelSkeletons(n = 7) {
    dom.reelTrack.innerHTML = "";
    reelItems.length = 0;
    const vw = dom.reelView.clientWidth;
    for (let i = 0; i < n; i++) {
        const s = document.createElement("div");
        s.className = "reel-skeleton";
        s.style.left = `calc(50% + ${(i - (n - 1) / 2) * SPREAD}px - 43px)`;
        dom.reelTrack.appendChild(s);
    }
}
function renderReelEmpty(msg) {
    dom.reelTrack.innerHTML = `<div class="reel-empty">${esc(msg)}</div>`;
    reelItems.length = 0;
}
function rebuildReel() {
    dom.reelTrack.innerHTML = "";
    reelItems.length = 0;
    state.list.forEach((p, i) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "reel-item" + (state.favorites.has(p.id) ? " has-fav" : "");
        item.dataset.idx = i;
        item.dataset.id = p.id;
        item.innerHTML = `<span class="rfav">★</span><img loading="lazy" src="${p.sprite || p.image}" alt="${esc(p.displayName)}"><span class="rn">${num(p.id)}</span>`;
        dom.reelTrack.appendChild(item);
        reelItems.push(item);
    });
    state.activeIndex = clamp(state.activeIndex, 0, Math.max(0, state.list.length - 1));
    layoutReel();
}
function queueLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => { layoutQueued = false; layoutReel(); });
}
function layoutReel(center = null) {
    if (!reelItems.length) return;
    const c = center == null ? state.activeIndex : center;
    for (let i = 0; i < reelItems.length; i++) {
        const off = i - c;
        const a = Math.abs(off);
        const rot = clamp(-off * 24, -58, 58);
        const z = -a * 56;
        const scale = Math.max(0.5, 1 - a * 0.13);
        const opacity = a > 4 ? 0 : Math.max(0.12, 1 - a * 0.2);
        const item = reelItems[i];
        item.style.transform = `translate(calc(-50% + ${off * SPREAD}px), -50%) perspective(900px) rotateY(${rot}deg) translateZ(${z}px) scale(${scale})`;
        item.style.opacity = opacity;
        item.style.zIndex = 200 - Math.round(a);
        item.style.pointerEvents = a > 4 ? "none" : "auto";
        const isActive = Math.round(c) === i;
        item.classList.toggle("active", isActive);
        item.classList.toggle("near", !isActive && a < 1.6);
    }
}
function setActive(i, opts = {}) {
    if (!state.list.length) return;
    i = clamp(i, 0, state.list.length - 1);
    const changed = i !== state.activeIndex;
    state.activeIndex = i;
    layoutReel();
    if (!opts.silent && changed) Sound.tick();
    renderHero(state.list[i]);
    markSeen([state.list[i]]);
    maybeLoadMore();
}

/* arraste */
function onDragStart(e) {
    if (!reelItems.length) return;
    dragging = true; moved = false; startX = e.clientX; startActive = state.activeIndex; visualIndex = state.activeIndex;
}
function onDragMove(e) {
    if (!dragging) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 5) moved = true;
    visualIndex = clamp(startActive - dx / SPREAD, -0.5, state.list.length - 0.5);
    queueLayoutCenter(visualIndex);
}
function onDragEnd() {
    if (!dragging) return;
    dragging = false;
    if (moved && visualIndex != null) setActive(Math.round(visualIndex));
    visualIndex = null;
}
let centerQueued = false, pendingCenter = 0;
function queueLayoutCenter(c) {
    pendingCenter = c;
    if (centerQueued) return;
    centerQueued = true;
    requestAnimationFrame(() => { centerQueued = false; layoutReel(pendingCenter); });
}

/* ===================== HERO ===================== */
function clearHero() {
    dom.heroName.textContent = "———";
    dom.heroGenus.textContent = "";
    dom.heroTypes.innerHTML = "";
    dom.hudLeft.innerHTML = ""; dom.hudRight.innerHTML = ""; dom.dock.innerHTML = "";
    dom.creatureImg.removeAttribute("src");
    dom.ghostNum.textContent = "0000";
}
function renderHero(p) {
    const token = ++state.detailToken;
    applyTheme(p.types[0] || "normal", p.types[1]);

    dom.ghostNum.textContent = String(p.id).padStart(4, "0");
    dom.heroName.textContent = p.displayName;
    dom.heroGenus.textContent = "Escaneando…";
    dom.heroTypes.innerHTML = p.types.map(typeBadge).join("");

    dom.creature.classList.add("loading");
    const img = new Image();
    const reveal = (src) => {
        if (token !== state.detailToken) return;
        dom.creatureImg.src = src; dom.creatureImg.alt = p.displayName;
        dom.creature.classList.remove("loading");
        dom.creature.classList.add("scanning");
        setTimeout(() => dom.creature.classList.remove("scanning"), 920);
    };
    img.onload = () => reveal(img.src);
    img.onerror = () => reveal(p.sprite || "");
    img.src = state.shiny && p.shinyImage ? p.shinyImage : (p.image || p.sprite);

    const total = p.stats.reduce((s, x) => s + x.value, 0);

    dom.hudLeft.innerHTML = `
        <div class="scan">
            <span class="scan-label">Registro</span>
            <p class="flavor" id="heroFlavor">Lendo arquivo da espécie…</p>
        </div>
        <div class="scan">
            <span class="scan-label">Físico</span>
            <div class="facts">
                <div class="fact"><b>${fmtHeight(p.height)}</b><span>Altura</span></div>
                <div class="fact"><b>${fmtWeight(p.weight)}</b><span>Peso</span></div>
                <div class="fact"><b>${p.baseExperience || "—"}</b><span>Exp. base</span></div>
                <div class="fact"><b id="heroCapture">—</b><span>Captura</span></div>
            </div>
        </div>
        <div class="scan">
            <span class="scan-label">Habilidades</span>
            <div class="tagrow">${p.abilities.map((a) => `<span class="tag ${a.hidden ? "hidden" : ""}">${esc(formatName(a.name))}</span>`).join("")}</div>
        </div>`;

    dom.hudRight.innerHTML = `
        <div class="scan">
            <span class="scan-label">Aptidão</span>
            <div class="radar-wrap">${radarSVG(p.stats)}<span class="radar-total">TOTAL <b>${total}</b></span></div>
        </div>
        <div class="scan">
            <span class="scan-label">Fraquezas</span>
            <div class="tagrow">${weaknessTags(p.types)}</div>
        </div>
        <div class="scan">
            <span class="scan-label">Linha evolutiva</span>
            <div class="evo" id="heroEvo"><span class="tag">…</span></div>
        </div>
        <div class="scan">
            <span class="scan-label">Dados</span>
            <div class="tagrow" id="heroMeta"></div>
        </div>`;

    dom.dock.innerHTML = `
        <button class="dock-btn" id="dCry" ${p.cry ? "" : "disabled"} title="Som">${ICON.sound}</button>
        <button class="dock-btn shiny ${state.shiny ? "is-on" : ""}" id="dShiny" ${p.shinyImage ? "" : "disabled"} title="Shiny">${ICON.sparkle}</button>
        <button class="dock-btn" id="dRand" title="Surpresa (R)">${ICON.dice}</button>
        <button class="dock-btn fav ${state.favorites.has(p.id) ? "is-on" : ""}" id="dFav" title="Capturar">${ICON.heart}</button>`;

    wireDock(p);
    loadSpecies(p, token);
}

function wireDock(p) {
    const cry = document.getElementById("dCry");
    if (p.cry) cry.addEventListener("click", () => { cry.classList.add("playing"); Sound.cry(p.cry, () => cry.classList.remove("playing")); });

    const shiny = document.getElementById("dShiny");
    if (p.shinyImage) shiny.addEventListener("click", () => {
        state.shiny = !state.shiny;
        shiny.classList.toggle("is-on", state.shiny);
        dom.creature.classList.add("scanning");
        dom.creatureImg.src = state.shiny ? p.shinyImage : p.image;
        setTimeout(() => dom.creature.classList.remove("scanning"), 920);
        if (state.shiny) { FX.sparkleBurst(); Sound.shiny(); toast("✨ Variante shiny revelada!"); }
    });

    document.getElementById("dRand").addEventListener("click", surpriseMe);
    document.getElementById("dFav").addEventListener("click", () => toggleFavorite(p.id));
}

function radarSVG(stats) {
    const map = {};
    stats.forEach((s) => map[s.name] = s.value);
    const S = 200, c = S / 2, R = S * 0.34;
    const pt = (i, r) => { const ang = (-90 + i * 60) * Math.PI / 180; return [c + r * Math.cos(ang), c + r * Math.sin(ang)]; };
    let grid = "";
    [0.25, 0.5, 0.75, 1].forEach((f) => {
        const pts = STAT_SLOTS.map((_, i) => pt(i, R * f).map((n) => n.toFixed(1)).join(",")).join(" ");
        grid += `<polygon class="grid-poly" points="${pts}"/>`;
    });
    let axes = "", labels = "", shapePts = "";
    STAT_SLOTS.forEach((slot, i) => {
        const [ax, ay] = pt(i, R);
        axes += `<line class="axis" x1="${c}" y1="${c}" x2="${ax.toFixed(1)}" y2="${ay.toFixed(1)}"/>`;
        const [lx, ly] = pt(i, R * 1.26);
        labels += `<text class="lbl" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" dominant-baseline="middle">${slot.label}</text>`;
        const v = map[slot.key] || 0;
        const f = Math.min(1, v / 180);
        shapePts += pt(i, R * f).map((n) => n.toFixed(1)).join(",") + " ";
    });
    return `<svg class="radar" viewBox="0 0 ${S} ${S}">${grid}${axes}<polygon class="shape" points="${shapePts.trim()}"/>${labels}</svg>`;
}

function weaknessTags(types) {
    const weak = [];
    for (const atk of ALL_TYPES) {
        let m = 1;
        for (const def of types) {
            const c = TYPE_CHART[atk];
            if (c.se.includes(def)) m *= 2; else if (c.nve.includes(def)) m *= 0.5; else if (c.no.includes(def)) m *= 0;
        }
        if (m >= 2) weak.push({ atk, m });
    }
    weak.sort((a, b) => b.m - a.m);
    if (!weak.length) return `<span class="tag">Sem fraquezas notáveis</span>`;
    return weak.map((w) => `<span class="wtag" style="--tc:${color(w.atk)}">${label(w.atk)}<span class="x">×${w.m}</span></span>`).join("");
}

/* ===================== Espécie + evolução ===================== */
async function loadSpecies(p, token) {
    try {
        const sp = await getSpecies(p.id);
        if (token !== state.detailToken) return;
        const genus = pickByLang(sp.genera, "genus");
        dom.heroGenus.textContent = genus || formatName(p.types[0]);
        const fEl = document.getElementById("heroFlavor");
        if (fEl) fEl.textContent = flavorText(sp);
        const capEl = document.getElementById("heroCapture");
        if (capEl) capEl.textContent = sp.capture_rate != null ? Math.round((sp.capture_rate / 255) * 100) + "%" : "—";
        const metaEl = document.getElementById("heroMeta");
        if (metaEl) {
            const roman = (sp.generation?.name || "").replace("generation-", "").toUpperCase();
            const meta = [roman ? `Geração ${roman}` : null, sp.habitat?.name ? formatName(sp.habitat.name) : null, genderText(sp.gender_rate)].filter(Boolean);
            metaEl.innerHTML = meta.map((t) => `<span class="tag">${esc(t)}</span>`).join("");
        }
        await renderEvolution(sp, p.id, token);
    } catch {
        if (token !== state.detailToken) return;
        const fEl = document.getElementById("heroFlavor"); if (fEl) fEl.textContent = "Arquivo da espécie indisponível.";
        const evo = document.getElementById("heroEvo"); if (evo) evo.innerHTML = `<span class="tag">Indisponível</span>`;
    }
}
async function renderEvolution(species, currentId, token) {
    const el = document.getElementById("heroEvo");
    if (!el || !species.evolution_chain?.url) return;
    const chain = await getEvolution(species.evolution_chain.url);
    const stages = flattenEvo(chain.chain);
    const mons = await Promise.all(stages.map((s) => getPokemon(s.name).catch(() => null)));
    if (token !== state.detailToken) return;
    const parts = [];
    mons.forEach((m, i) => {
        if (!m) return;
        if (i > 0) parts.push(`<span class="evo-arrow">→${stages[i].trigger ? `<small>${esc(stages[i].trigger)}</small>` : ""}</span>`);
        parts.push(`<button class="evo-node ${m.id === currentId ? "cur" : ""}" data-evo="${m.id}"><img src="${m.sprite || m.image}" alt="${esc(m.displayName)}"><span>${esc(m.displayName)}</span></button>`);
    });
    el.innerHTML = parts.length ? parts.join("") : `<span class="tag">Não evolui</span>`;
    el.querySelectorAll("[data-evo]").forEach((n) => n.addEventListener("click", () => showById(Number(n.dataset.evo))));
}

function showById(id) {
    const idx = state.list.findIndex((p) => p.id === id);
    if (idx >= 0) { setActive(idx); return; }
    getPokemon(id).then((p) => { markSeen([p]); renderHero(p); Sound.select(); }).catch(() => {});
}

/* ===================== Favoritos ===================== */
function toggleFavorite(id) {
    const has = state.favorites.has(id);
    if (has) { state.favorites.delete(id); toast("Solto na natureza."); }
    else { state.favorites.add(id); toast("⚡ Capturado!"); Sound.capture(); }
    saveFavorites();
    updateDial();
    const cur = state.list[state.activeIndex];
    const dFav = document.getElementById("dFav");
    if (dFav && cur && cur.id === id) dFav.classList.toggle("is-on", state.favorites.has(id));
    const item = reelItems.find((it) => Number(it.dataset.id) === id);
    if (item) item.classList.toggle("has-fav", state.favorites.has(id));
    if (state.mode === "favorites") favoritesFromCache();
}
function surpriseMe() {
    Sound.tick();
    showById(Math.floor(Math.random() * MAX_DEX) + 1);
}

/* ===================== Dados ===================== */
async function getPokemon(identifier) {
    if (typeof identifier === "string" && identifier.startsWith("http")) return cachePokemon(await fetchJson(identifier));
    const key = String(identifier).toLowerCase();
    if (state.cache.has(key)) return state.cache.get(key);
    return cachePokemon(await fetchJson(`${API_BASE}/pokemon/${key}`));
}
function cachePokemon(data) {
    const p = normalizePokemon(data);
    state.cache.set(String(p.id), p); state.cache.set(p.name, p);
    return p;
}
function normalizePokemon(d) {
    const art = d.sprites?.other?.["official-artwork"] || {};
    const image = art.front_default || d.sprites?.other?.home?.front_default || d.sprites?.front_default || "";
    return {
        id: d.id, name: d.name, displayName: formatName(d.name), image,
        shinyImage: art.front_shiny || d.sprites?.other?.home?.front_shiny || "",
        sprite: d.sprites?.front_default || image,
        types: d.types.map((t) => t.type.name),
        height: d.height / 10, weight: d.weight / 10, baseExperience: d.base_experience,
        abilities: d.abilities.map((a) => ({ name: a.ability.name, hidden: a.is_hidden })),
        stats: d.stats.map((s) => ({ name: s.stat.name, value: s.base_stat })),
        cry: d.cries?.latest || d.cries?.legacy || ""
    };
}
async function getSpecies(id) {
    const k = String(id);
    if (state.speciesCache.has(k)) return state.speciesCache.get(k);
    const sp = await fetchJson(`${API_BASE}/pokemon-species/${id}`);
    state.speciesCache.set(k, sp);
    return sp;
}
async function getEvolution(url) {
    if (state.evoCache.has(url)) return state.evoCache.get(url);
    const ev = await fetchJson(url);
    state.evoCache.set(url, ev);
    return ev;
}
async function fetchJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}

/* ===================== Util ===================== */
function typeBadge(t) { return `<span class="type-badge" style="--tc:${color(t)}"><span class="tdot"></span>${label(t)}</span>`; }
function mergeById(cur, inc) { const m = new Map(cur.map((p) => [p.id, p])); inc.forEach((p) => m.set(p.id, p)); return [...m.values()]; }
function flattenEvo(node, trigger = "", out = []) {
    if (!node) return out;
    out.push({ name: node.species.name, trigger });
    (node.evolves_to || []).forEach((c) => flattenEvo(c, evoTrigger(c.evolution_details?.[0]), out));
    return out;
}
function evoTrigger(d) {
    if (!d) return "";
    if (d.min_level) return `Nv.${d.min_level}`;
    if (d.item) return formatName(d.item.name);
    if (d.trigger?.name === "trade") return "Troca";
    if (d.min_happiness) return "Amizade";
    if (d.trigger?.name) return formatName(d.trigger.name);
    return "";
}
function flavorText(sp) {
    const e = sp.flavor_text_entries || [];
    const pick = e.find((x) => x.language.name === "pt-br") || e.find((x) => x.language.name === "pt") || e.find((x) => x.language.name === "en");
    return (pick?.flavor_text || "Sem descrição registrada.").replace(/[\n\f\r­]+/g, " ").replace(/\s+/g, " ").trim();
}
function pickByLang(arr, field) {
    if (!arr) return "";
    const pick = arr.find((x) => x.language.name === "pt-br") || arr.find((x) => x.language.name === "pt") || arr.find((x) => x.language.name === "en");
    return pick?.[field] || "";
}
function genderText(rate) { if (rate === -1) return "Sem gênero"; const f = (rate / 8) * 100; return `♀${f}% ♂${100 - f}%`; }
function updateLoadMore() {
    const can = state.mode === "all" && (!state.type || state.typeOffset < state.typeRefs.length);
    dom.loadMoreButton.hidden = !can;
}
function setLoading(v) { state.isLoading = v; dom.loadMoreButton.disabled = v; }
function setOnline(v) { dom.statusLed.classList.toggle("off", !v); dom.statusLed.title = v ? "PokéAPI · online" : "PokéAPI · offline"; }
function markSeen(list) { list.forEach((p) => p?.id && state.seen.add(p.id)); updateDial(); }
function updateDial() { animateCount(dom.favoriteCount, state.favorites.size); animateCount(dom.seenCount, state.seen.size); }
function animateCount(el, target) {
    const from = Number(el.textContent) || 0;
    if (from === target) { el.textContent = target; return; }
    const start = performance.now();
    (function step(now) {
        const t = Math.min(1, (now - start) / 450);
        el.textContent = Math.round(from + (target - from) * (1 - Math.pow(1 - t, 3)));
        if (t < 1) requestAnimationFrame(step);
    })(start);
    setTimeout(() => { el.textContent = target; }, 500); // garante o valor final mesmo sem rAF
}
function applyTheme(primary, secondary) {
    const c = color(primary), rgb = hexToRgb(c), hsl = rgbToHsl(rgb);
    const sat = Math.min(86, Math.max(60, hsl.s));
    const c2 = secondary ? color(secondary) : hslStr((hsl.h + 40) % 360, 88, 66);
    const r = document.documentElement.style;
    r.setProperty("--accent", c);
    r.setProperty("--accent-2", c2);
    r.setProperty("--accent-rgb", `${rgb.r}, ${rgb.g}, ${rgb.b}`);
    r.setProperty("--accent-ink", luminance(rgb) > 0.55 ? "#0a0d16" : "#ffffff");
    // Fundo vívido tingido pelo tipo
    r.setProperty("--bg-deep", hslStr(hsl.h, Math.min(62, sat), 8));
    r.setProperty("--bg-mid", hslStr(hsl.h, Math.min(70, sat), 13));
    r.setProperty("--glow-1", `hsla(${hsl.h}, 96%, 63%, 0.42)`);
    r.setProperty("--glow-2", `hsla(${(hsl.h + 55) % 360}, 92%, 64%, 0.28)`);
    document.body.dataset.type = primary;
    FX.setProfile(primary);
}
function rgbToHsl({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0, s = 0, l = (mx + mn) / 2;
    if (d) {
        s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
        if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (mx === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
    }
    return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}
function hslStr(h, s, l) { return `hsl(${h}, ${s}%, ${l}%)`; }
function toast(msg) { dom.toast.textContent = msg; dom.toast.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => dom.toast.classList.remove("show"), 2400); }

function loadFavorites() { try { return new Set(JSON.parse(localStorage.getItem(FAVORITE_KEY) || "[]").map(Number).filter(Number.isFinite)); } catch { return new Set(); } }
function saveFavorites() { localStorage.setItem(FAVORITE_KEY, JSON.stringify([...state.favorites])); }

function label(t) { return TYPE_LABELS[t] || formatName(t); }
function color(t) { return TYPE_COLORS[t] || "#9aa3b8"; }
function formatName(s) { return String(s).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()); }
function num(id) { return `Nº${String(id).padStart(4, "0")}`; }
function fmtHeight(v) { return `${v.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}m`; }
function fmtWeight(v) { return `${v.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}kg`; }
function normalizeQuery(q) { return q.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""); }
function extractId(url) { const m = url.match(/\/(\d+)\/?$/); return m ? Number(m[1]) : Infinity; }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function esc(v) { return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c])); }
function hexToRgb(hex) { const h = hex.replace("#", ""); return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }; }
function mix(a, b, t) { const x = hexToRgb(a), y = hexToRgb(b); return `#${[x.r + (y.r - x.r) * t, x.g + (y.g - x.g) * t, x.b + (y.b - x.b) * t].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("")}`; }
function luminance({ r, g, b }) { return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }

const ICON = {
    sound: `<svg viewBox="0 0 24 24" fill="none"><path d="M4 9v6h4l5 4V5L8 9H4Z" fill="currentColor"/><path d="M16 9a3 3 0 0 1 0 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    sparkle: `<svg viewBox="0 0 24 24" fill="none"><path d="m12 3 1.8 4.9L19 9.6l-4.4 2.6L13 18l-1-5.4L7 11.2l5-1.4L12 3Z" fill="currentColor"/><circle cx="18.5" cy="5.5" r="1.3" fill="currentColor"/></svg>`,
    dice: `<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="4" width="16" height="16" rx="4" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="9" r="1.3" fill="currentColor"/><circle cx="15" cy="15" r="1.3" fill="currentColor"/><circle cx="15" cy="9" r="1.3" fill="currentColor"/><circle cx="9" cy="15" r="1.3" fill="currentColor"/></svg>`,
    heart: `<svg viewBox="0 0 24 24" fill="none"><path d="M12 20s-7-4.5-9.2-8.4C1 8.5 2.4 5 5.8 5 8 5 9.4 6.4 12 9c2.6-2.6 4-4 6.2-4 3.4 0 4.8 3.5 3 6.6C19 15.5 12 20 12 20Z" fill="currentColor"/></svg>`
};

/* ============================================================
   FX — partículas reativas ao tipo
   ============================================================ */
const FX = (() => {
    let canvas, ctx, w = 0, h = 0, dpr = 1, particles = [], profile = "none", raf = null;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const MAX = 90;
    const PROFILES = {
        fire: { rate: 2.4, colors: ["#ff7a2d", "#ffb347", "#ff4d2d", "#ffd23f"], make: ember },
        water: { rate: 1.4, colors: ["#4f9bff", "#74e0e3", "#9ad4ff"], make: bubble },
        grass: { rate: 1.0, colors: ["#57c84d", "#9acb3c", "#7bd97a"], make: leaf },
        bug: { rate: 1.2, colors: ["#9acb3c", "#bce05a"], make: leaf },
        electric: { rate: 2.0, colors: ["#ffce3f", "#fff07a", "#ffd23f"], make: spark },
        ice: { rate: 1.3, colors: ["#74e0e3", "#cffaff", "#bfe9ff"], make: snow },
        psychic: { rate: 1.4, colors: ["#ff6ca8", "#ffa6d4", "#d18bff"], make: star },
        fairy: { rate: 1.6, colors: ["#ff9ed6", "#ffd1ec", "#ffb3e6"], make: star },
        poison: { rate: 1.3, colors: ["#b25be0", "#d98bff", "#9b4ddb"], make: bubble },
        ghost: { rate: 1.1, colors: ["#8a7de0", "#b6a8ff", "#6f63c0"], make: wisp },
        dark: { rate: 1.0, colors: ["#6e6a78", "#9a93ad", "#4a4654"], make: wisp },
        dragon: { rate: 1.6, colors: ["#7b6cff", "#a99bff", "#6fd0ff"], make: star },
        ground: { rate: 1.1, colors: ["#e0a94b", "#caa15e", "#b08948"], make: dust },
        rock: { rate: 1.0, colors: ["#cbb069", "#a89150"], make: dust },
        steel: { rate: 1.2, colors: ["#cdd9e4", "#8fa8bc", "#ffffff"], make: glint },
        flying: { rate: 1.2, colors: ["#8fb4ff", "#cfe0ff", "#ffffff"], make: streak },
        fighting: { rate: 1.6, colors: ["#ff5a5f", "#ffb347"], make: spark },
        normal: { rate: 0.8, colors: ["#c8ccd6", "#9fa4af"], make: dust },
        none: { rate: 0.7, colors: ["#5cc7ff", "#8a7dff"], make: dust }
    };
    function init(el) {
        canvas = el; ctx = canvas.getContext("2d");
        resize(); new ResizeObserver(resize).observe(canvas);
        if (!reduce) loop();
    }
    function resize() {
        const r = canvas.getBoundingClientRect();
        dpr = Math.min(2, window.devicePixelRatio || 1);
        w = r.width; h = r.height;
        canvas.width = w * dpr; canvas.height = h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function setProfile(type) {
        const next = PROFILES[type] ? type : "none";
        if (next !== profile) for (const p of particles) p.max = Math.min(p.max, p.life + 14);
        profile = next;
    }
    function base(p) { return Object.assign({ rot: 0, vr: 0, wob: Math.random() * 6.28, kind: "circle", glow: 8 }, p); }
    function pick(cs) { return cs[(Math.random() * cs.length) | 0]; }
    function rand(a, b) { return a + Math.random() * (b - a); }
    function ember(cs) { return base({ kind: "ember", x: rand(0.15, 0.85) * w, y: h + 10, vx: rand(-0.2, 0.2), vy: -rand(0.5, 1.4), size: rand(2, 5), life: 0, max: rand(60, 120), color: pick(cs), glow: 14 }); }
    function bubble(cs) { return base({ kind: "bubble", x: rand(0.15, 0.85) * w, y: h + 8, vx: rand(-0.15, 0.15), vy: -rand(0.4, 1.0), size: rand(3, 9), life: 0, max: rand(80, 150), color: pick(cs), glow: 6 }); }
    function leaf(cs) { return base({ kind: "leaf", x: rand(0, 1) * w, y: -10, vx: rand(-0.3, 0.3), vy: rand(0.4, 0.9), size: rand(4, 7), life: 0, max: rand(120, 200), color: pick(cs), vr: rand(-0.05, 0.05), glow: 4 }); }
    function spark(cs) { return base({ kind: "spark", x: rand(0, 1) * w, y: rand(0.1, 0.8) * h, vx: rand(-1, 1), vy: rand(-1, 1), size: rand(6, 14), life: 0, max: rand(10, 22), color: pick(cs), glow: 16 }); }
    function snow(cs) { return base({ kind: "snow", x: rand(0, 1) * w, y: -8, vx: rand(-0.2, 0.2), vy: rand(0.3, 0.7), size: rand(2, 4), life: 0, max: rand(140, 240), color: pick(cs), glow: 8 }); }
    function star(cs) { return base({ kind: "star", x: rand(0.05, 0.95) * w, y: rand(0.1, 0.95) * h, vx: rand(-0.1, 0.1), vy: -rand(0.05, 0.35), size: rand(3, 7), life: 0, max: rand(50, 110), color: pick(cs), glow: 14 }); }
    function wisp(cs) { return base({ kind: "wisp", x: rand(0.1, 0.9) * w, y: h + 10, vx: rand(-0.25, 0.25), vy: -rand(0.3, 0.7), size: rand(8, 18), life: 0, max: rand(70, 130), color: pick(cs), glow: 10 }); }
    function dust(cs) { return base({ kind: "dust", x: rand(0, 1) * w, y: rand(0, 1) * h, vx: rand(-0.18, 0.18), vy: -rand(0.05, 0.25), size: rand(1.5, 3.5), life: 0, max: rand(120, 220), color: pick(cs), glow: 4 }); }
    function glint(cs) { return base({ kind: "glint", x: rand(0, 1) * w, y: rand(0, 1) * h, vx: rand(-0.1, 0.1), vy: rand(-0.1, 0.1), size: rand(3, 6), life: 0, max: rand(30, 60), color: pick(cs), glow: 12 }); }
    function streak(cs) { return base({ kind: "streak", x: -20, y: rand(0.1, 0.9) * h, vx: rand(2, 4), vy: rand(-0.2, 0.2), size: rand(16, 30), life: 0, max: rand(40, 70), color: pick(cs), glow: 6 }); }
    function spawn() {
        const cfg = PROFILES[profile];
        if (!cfg || particles.length >= MAX) return;
        let n = cfg.rate;
        while (n > 0) { if (Math.random() < n) particles.push(cfg.make(cfg.colors)); n -= 1; }
    }
    function sparkleBurst() {
        const cs = ["#fff7c2", "#ffe98a", "#ffffff", "#ffd23f"];
        for (let i = 0; i < 26; i++) { const a = Math.random() * 6.28, sp = rand(1, 4); particles.push(base({ kind: "star", x: w / 2, y: h * 0.46, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, size: rand(3, 8), life: 0, max: rand(30, 60), color: pick(cs), glow: 18 })); }
    }
    function loop() {
        ctx.clearRect(0, 0, w, h);
        spawn();
        ctx.globalCompositeOperation = "lighter";
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.life++; p.wob += 0.05;
            p.x += p.vx + (p.kind === "leaf" || p.kind === "snow" ? Math.sin(p.wob) * 0.5 : 0);
            p.y += p.vy; p.rot += p.vr;
            if (p.kind === "ember") p.vy -= 0.002;
            const t = p.life / p.max;
            if (t >= 1 || p.x < -30 || p.x > w + 30 || p.y < -30 || p.y > h + 30) { particles.splice(i, 1); continue; }
            draw(p, t);
        }
        ctx.globalCompositeOperation = "source-over";
        raf = requestAnimationFrame(loop);
    }
    function draw(p, t) {
        const fade = (p.kind === "spark" || p.kind === "glint" || p.kind === "streak") ? Math.sin(t * Math.PI) : (t < 0.15 ? t / 0.15 : 1 - Math.max(0, (t - 0.6) / 0.4));
        ctx.globalAlpha = Math.max(0, Math.min(1, fade));
        ctx.fillStyle = p.color; ctx.strokeStyle = p.color; ctx.shadowBlur = p.glow; ctx.shadowColor = p.color;
        switch (p.kind) {
            case "bubble": ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 6.28); ctx.stroke(); ctx.globalAlpha *= 0.5; ctx.beginPath(); ctx.arc(p.x - p.size * 0.3, p.y - p.size * 0.3, p.size * 0.25, 0, 6.28); ctx.fill(); break;
            case "spark": case "streak": ctx.lineWidth = 2.2; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * p.size * 0.5, p.y - p.vy * p.size * 0.5); ctx.stroke(); break;
            case "leaf": ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.beginPath(); ctx.ellipse(0, 0, p.size, p.size * 0.5, 0, 0, 6.28); ctx.fill(); ctx.restore(); break;
            case "star": drawStar(p.x, p.y, p.size); break;
            case "glint": ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(0.785); ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size); ctx.restore(); break;
            case "wisp": ctx.globalAlpha *= 0.4; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 6.28); ctx.fill(); break;
            default: ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 6.28); ctx.fill();
        }
        ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    }
    function drawStar(x, y, s) {
        ctx.save(); ctx.translate(x, y); ctx.beginPath();
        for (let i = 0; i < 4; i++) { ctx.rotate(1.5708); ctx.moveTo(0, 0); ctx.quadraticCurveTo(s * 0.3, s * 0.3, 0, s); ctx.quadraticCurveTo(-s * 0.3, s * 0.3, 0, 0); }
        ctx.fill(); ctx.restore();
    }
    return { init, setProfile, sparkleBurst };
})();

/* ============================================================
   Sound — UI sintetizada + cries
   ============================================================ */
const Sound = (() => {
    let actx = null, enabled = true, master = null;
    function init() {
        enabled = localStorage.getItem(SOUND_KEY) !== "off";
        reflect();
        const unlock = () => { ensure(); if (actx?.state === "suspended") actx.resume(); window.removeEventListener("pointerdown", unlock); window.removeEventListener("keydown", unlock); };
        window.addEventListener("pointerdown", unlock); window.addEventListener("keydown", unlock);
    }
    function ensure() { if (actx) return; const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; actx = new AC(); master = actx.createGain(); master.gain.value = 0.5; master.connect(actx.destination); }
    function reflect() { dom.soundToggle?.setAttribute("aria-pressed", String(enabled)); }
    function toggle() { enabled = !enabled; localStorage.setItem(SOUND_KEY, enabled ? "on" : "off"); reflect(); if (enabled) { ensure(); tone(660, 0.08, { type: "triangle", gain: 0.12 }); } }
    function tone(freq, dur, { type = "sine", gain = 0.18, when = 0, slideTo = null } = {}) {
        if (!enabled) return; ensure(); if (!actx) return;
        const t0 = actx.currentTime + when, osc = actx.createOscillator(), g = actx.createGain();
        osc.type = type; osc.frequency.setValueAtTime(freq, t0);
        if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(g).connect(master); osc.start(t0); osc.stop(t0 + dur + 0.02);
    }
    return {
        init, toggle,
        tick() { tone(520, 0.05, { type: "square", gain: 0.04 }); },
        select() { tone(440, 0.08, { type: "triangle", gain: 0.1, slideTo: 720 }); tone(880, 0.12, { type: "sine", gain: 0.05, when: 0.04 }); },
        capture() { tone(660, 0.09, { type: "triangle", gain: 0.12 }); tone(990, 0.12, { type: "triangle", gain: 0.11, when: 0.09 }); tone(1320, 0.16, { type: "sine", gain: 0.09, when: 0.18 }); },
        shiny() { [988, 1318, 1760, 2093].forEach((f, i) => tone(f, 0.18, { type: "sine", gain: 0.08, when: i * 0.06 })); },
        powerUp() { [330, 440, 587, 880].forEach((f, i) => tone(f, 0.3, { type: "sine", gain: 0.07, when: i * 0.08 })); },
        cry(url, onEnd) { const a = new Audio(url); a.volume = enabled ? 0.4 : 0; a.addEventListener("ended", () => onEnd && onEnd()); a.play().catch(() => onEnd && onEnd()); }
    };
})();
