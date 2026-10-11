/* TariffeOggi — rendering e filtri */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const grid = $("#grid");
  const empty = $("#empty");
  const loading = $("#loading");
  const counter = $("#counter");
  const chipsBox = $("#chips");
  const searchInput = $("#search");
  const searchClear = $("#searchClear");

  const state = {
    cat: "all",
    q: "",
    sort: "est-asc",
    chips: new Set(), // filtri attivi per categoria
    offers: [],
    indices: {},
    history: null, // mappa id → offerta della rilevazione precedente
    saved: new Set(JSON.parse(localStorage.getItem("tariffe-star") || "[]")),
    cons: Object.assign({ luce: 2700, gas: 1400 }, JSON.parse(localStorage.getItem("tariffe-cons") || "{}")),
  };
  const persistSaved = () => localStorage.setItem("tariffe-star", JSON.stringify([...state.saved]));
  const persistCons = () => localStorage.setItem("tariffe-cons", JSON.stringify(state.cons));

  /* ---------- tema ---------- */
  const themeBtn = $("#themeBtn");
  const applyTheme = (t) => {
    document.documentElement.dataset.theme = t;
    localStorage.setItem("theme", t);
  };
  applyTheme(
    localStorage.getItem("theme") ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
  );
  themeBtn.addEventListener("click", () =>
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark")
  );

  /* ---------- chips per categoria ---------- */
  const SAVED_CHIP = { id: "saved", label: "⭐ Salvate" };
  const CHIP_SETS = {
    all: [SAVED_CHIP],
    luce: [
      { id: "fisso", label: "Prezzo fisso" },
      { id: "variabile", label: "Prezzo variabile" },
      { id: "green", label: "100% green" },
      SAVED_CHIP,
    ],
    gas: [
      { id: "fisso", label: "Prezzo fisso" },
      { id: "variabile", label: "Prezzo variabile" },
      SAVED_CHIP,
    ],
    internet: [
      { id: "FTTH", label: "Fibra FTTH" },
      { id: "FWA", label: "FWA" },
      { id: "modem", label: "Modem incluso" },
      { id: "noactivation", label: "Attivazione gratis" },
      { id: "nocommitment", label: "Senza vincoli" },
      { id: "national", label: "Solo nazionali" },
      SAVED_CHIP,
    ],
  };
  CHIP_SETS.all.unshift({ id: "dualfuel", label: "⚡+🔥 Dual fuel" });

  const renderChips = () => {
    chipsBox.innerHTML = "";
    for (const c of CHIP_SETS[state.cat] || []) {
      const b = document.createElement("button");
      b.className = "chip" + (state.chips.has(c.id) ? " is-on" : "");
      b.textContent = c.label;
      b.addEventListener("click", () => {
        state.chips.has(c.id) ? state.chips.delete(c.id) : state.chips.add(c.id);
        // fisso/variabile mutuamente esclusivi
        if (c.id === "fisso" && state.chips.has("fisso")) state.chips.delete("variabile");
        if (c.id === "variabile" && state.chips.has("variabile")) state.chips.delete("fisso");
        if (c.id === "FTTH" && state.chips.has("FTTH")) state.chips.delete("FWA");
        if (c.id === "FWA" && state.chips.has("FWA")) state.chips.delete("FTTH");
        renderChips();
        render();
      });
      chipsBox.appendChild(b);
    }
  };

  /* ---------- tabs ---------- */
  $("#tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (!tab) return;
    state.cat = tab.dataset.cat;
    state.chips.clear();
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t === tab));
    const isBill = state.cat === "bolletta";
    $(".toolbar").hidden = isBill;
    chipsBox.hidden = isBill;
    counter.hidden = isBill;
    grid.hidden = isBill;
    empty.hidden = true;
    $("#billPanel").hidden = !isBill;
    if (isBill) {
      document.dispatchEvent(new CustomEvent("bill-open"));
      return;
    }
    renderChips();
    render();
  });

  /* ---------- ricerca ---------- */
  searchInput.addEventListener("input", () => {
    state.q = searchInput.value.trim().toLowerCase();
    searchClear.hidden = !state.q;
    render();
  });
  searchClear.addEventListener("click", () => {
    searchInput.value = "";
    state.q = "";
    searchClear.hidden = true;
    render();
    searchInput.focus();
  });

  /* ---------- sort ---------- */
  $("#sort").addEventListener("change", (e) => {
    state.sort = e.target.value;
    render();
  });

  /* ---------- helpers ---------- */
  const CAT_LABEL = { luce: "Luce", gas: "Gas", internet: "Internet" };
  const AVATAR_COLORS = [
    "#2563eb", "#7c3aed", "#db2777", "#ea580c", "#16a34a",
    "#0891b2", "#dc2626", "#ca8a04", "#4f46e5", "#0d9488",
  ];
  const avatarColor = (name) => {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
  };
  const initials = (name) =>
    name.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

  const fmtPrice = (n) =>
    n.toLocaleString("it-IT", { minimumFractionDigits: n < 1 ? 3 : 2, maximumFractionDigits: n < 1 ? 4 : 2 });
  const fmtEur = (n) => n.toLocaleString("it-IT", { maximumFractionDigits: 0 });

  const slug = (o) =>
    (o.provider + "-" + o.name).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const isExpired = (o) =>
    o.promoExpiry && new Date(o.promoExpiry + "T23:59:59") < new Date();

  /* ---------- stima costo annuo ----------
     luce/gas: componente materia con i consumi impostati (oneri e imposte esclusi).
     internet: costo del primo anno (promo per la sua durata + listino + attivazione). */
  const estimate = (o) => {
    if (o.category === "internet") {
      const act = o.activationCost ?? 0;
      const usePromo = o.promoPrice != null && !isExpired(o);
      const base = o.price;
      if (usePromo) {
        const m = Math.min(o.promoMonths ?? 12, 12); // senza durata nota: sconto permanente
        if (m < 12 && base == null) return null;
        return { v: o.promoPrice * m + (base ?? o.promoPrice) * (12 - m) + act, label: "1° anno" };
      }
      if (base == null) return null;
      return { v: base * 12 + act, label: "1° anno" };
    }
    const cons = state.cons[o.category];
    const fee = (o.monthlyFee ?? 0) * 12;
    if (typeof o.price === "number") return { v: cons * o.price + fee, label: "anno" };
    if (o.priceType === "variabile" && o.spreadValue != null) {
      const idx = o.category === "luce" ? state.indices.pun : state.indices.psv;
      if (idx != null) return { v: cons * (idx + o.spreadValue) + fee, label: "anno", approx: true };
    }
    return null;
  };

  // ordinamento a livelli: per prezzo unitario, prezzi pieni e spread non sono
  // comparabili, quindi prima categoria, poi fisso/variabile, poi valore.
  // Per stima annua basta la categoria: la stima rende tutto comparabile.
  const CAT_ORDER = { luce: 0, gas: 1, internet: 2 };
  const sortValue = (o) => {
    if (state.sort.startsWith("est")) {
      return { tier: CAT_ORDER[o.category], v: estimate(o)?.v ?? Infinity };
    }
    const tier = CAT_ORDER[o.category] * 2 + (o.priceType === "variabile" ? 1 : 0);
    let v;
    if (o.category === "internet") v = o.promoPrice ?? o.price;
    else if (typeof o.price === "number") v = o.price;
    else v = o.spreadValue; // variabile: usa lo spread
    return { tier, v: v ?? Infinity };
  };

  /* ---------- storico: delta vs rilevazione precedente ---------- */
  const priceDelta = (o) => {
    const old = state.history?.get(o._id);
    if (!old) return null;
    const cur = typeof o.price === "number" ? o.price : o.spreadValue;
    const prev = typeof old.price === "number" ? old.price : old.spreadValue;
    if (cur == null || prev == null || cur === prev) return null;
    return cur - prev;
  };

  /* ---------- sparkline: serie singola, linea 2px, niente assi (identità nel testo) ---------- */
  const sparkline = (points, w = 64, h = 20) => {
    if (!points || points.length < 2) return "";
    const vals = points.map((p) => p[1]);
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = max - min || 1;
    const pad = 2;
    const xy = vals.map((v, i) => [
      pad + (i / (vals.length - 1)) * (w - pad * 2),
      h - pad - ((v - min) / span) * (h - pad * 2),
    ]);
    const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    const first = points[0], last = points[points.length - 1];
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img">
      <title>Andamento dal ${first[0]} al ${last[0]}: ${fmtPrice(first[1])} → ${fmtPrice(last[1])}</title>
      <path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  };

  /* ---------- novità: offerte mai viste in una visita precedente ---------- */
  const newIds = new Set();
  const detectNew = () => {
    let seen;
    try { seen = JSON.parse(localStorage.getItem("tariffe-seen")); } catch { /* primo accesso */ }
    if (Array.isArray(seen) && seen.length) {
      const prev = new Set(seen);
      for (const o of state.offers) if (!prev.has(o._id)) newIds.add(o._id);
    }
    localStorage.setItem("tariffe-seen", JSON.stringify(state.offers.map((o) => o._id)));
  };

  /* ---------- banner risparmio (bolletta salvata in localStorage) ---------- */
  const savingsBanner = () => {
    let bills;
    try { bills = JSON.parse(localStorage.getItem("tariffe-bill")) || {}; } catch { return; }
    const msgs = [];
    for (const [type, b] of Object.entries(bills)) {
      if (!b?.price) continue;
      const mine = type === "internet" ? b.price * 12 : b.cons * b.price + (b.fee || 0) * 12;
      const better = state.offers.filter((o) => {
        if (o.category !== type) return false;
        const e = estimate(o);
        return e != null && mine - e.v > 50;
      }).length;
      if (better) msgs.push(`${{ luce: "⚡", gas: "🔥", internet: "🌐" }[type]} ${better} offert${better === 1 ? "a" : "e"} ${type} ti fa${better === 1 ? "" : "nno"} risparmiare oltre 50 €/anno`);
    }
    if (!msgs.length) return;
    const bar = document.createElement("div");
    bar.className = "savings-banner";
    bar.innerHTML = `<span>💰 ${msgs.join(" · ")}</span>
      <button class="savings-go">Confronta</button>
      <button class="savings-close" aria-label="Chiudi">✕</button>`;
    $(".main").prepend(bar);
    bar.querySelector(".savings-go").addEventListener("click", () =>
      document.querySelector('[data-cat="bolletta"]').click());
    bar.querySelector(".savings-close").addEventListener("click", () => bar.remove());
  };

  /* ---------- dual fuel: coppie luce+gas dello stesso fornitore ---------- */
  const renderDualFuel = () => {
    const best = {};
    for (const o of state.offers) {
      if (o.category === "internet") continue;
      const e = estimate(o);
      if (e == null) continue;
      const slot = (best[o.provider] ||= {});
      if (!slot[o.category] || e.v < slot[o.category].v) slot[o.category] = { o, v: e.v };
    }
    const combos = Object.entries(best)
      .filter(([, s]) => s.luce && s.gas)
      .map(([provider, s]) => ({ provider, tot: s.luce.v + s.gas.v, luce: s.luce, gas: s.gas }))
      .sort((a, b) => a.tot - b.tot);
    grid.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "dualfuel";
    wrap.innerHTML = `<p class="dualfuel-note">Coppia luce+gas più economica per fornitore, stimata sui tuoi consumi
      (${fmtEur(state.cons.luce)} kWh + ${fmtEur(state.cons.gas)} Smc). Gli sconti dual fuel dichiarati sono nelle promo delle singole offerte.</p>
      ${combos.slice(0, 12).map((c, i) => `
        <div class="bill-row ${i === 0 ? "good" : ""}">
          <div class="bill-row-name"><strong>${esc(c.provider)}</strong>
            <span>⚡ ${esc(c.luce.o.name)} + 🔥 ${esc(c.gas.o.name)}</span></div>
          <div class="bill-row-est">${fmtEur(c.tot)} €/anno</div>
          <a href="${esc(c.luce.o.url)}" target="_blank" rel="noopener noreferrer">Vai ↗</a>
        </div>`).join("")}`;
    grid.appendChild(wrap);
    empty.hidden = true;
    counter.hidden = false;
    counter.textContent = `${combos.length} fornitori con luce + gas`;
  };

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- filtro ---------- */
  const passes = (o) => {
    if (state.cat !== "all" && o.category !== state.cat) return false;
    if (state.q) {
      const hay = `${o.provider} ${o.name} ${o.promo || ""}`.toLowerCase();
      if (!hay.includes(state.q)) return false;
    }
    for (const chip of state.chips) {
      if (chip === "fisso" && o.priceType !== "fisso") return false;
      if (chip === "variabile" && o.priceType !== "variabile") return false;
      if (chip === "green" && !o.greenEnergy) return false;
      if (chip === "FTTH" && !(o.technology || "").includes("FTTH")) return false;
      if (chip === "FWA" && !(o.technology || "").includes("FWA")) return false;
      if (chip === "modem" && !o.modemIncluded) return false;
      if (chip === "noactivation" && o.activationCost !== 0) return false;
      if (chip === "national" && o.coverage) return false;
      if (chip === "nocommitment" && o.commitment !== 0) return false;
      if (chip === "saved" && !state.saved.has(o._id)) return false;
    }
    return true;
  };

  /* ---------- card ---------- */
  const priceBlock = (o) => {
    if (o.category === "internet") {
      const main = o.promoPrice ?? o.price;
      if (main == null) return `<div class="price-row"><span class="price price--formula">n.d.</span></div>`;
      const strike = o.promoPrice != null && o.price != null && o.promoPrice !== o.price
        ? `<span class="price-unit" style="text-decoration:line-through">${fmtPrice(o.price)} €</span>` : "";
      return `<div class="price-row">
        <span class="price">${fmtPrice(main)} €</span><span class="price-unit">/mese</span>${strike}
        ${o.technology ? `<span class="price-note">${esc(o.technology)}</span>` : ""}
      </div>`;
    }
    const unit = o.category === "luce" ? "€/kWh" : "€/Smc";
    if (typeof o.price === "number") {
      return `<div class="price-row">
        <span class="price">${fmtPrice(o.price)}</span><span class="price-unit">${unit}</span>
      </div>`;
    }
    if (o.price) {
      return `<div class="price-row"><span class="price price--formula">${esc(o.price)}</span></div>`;
    }
    return `<div class="price-row"><span class="price price--formula">n.d.</span><span class="price-note">prezzo sul sito del fornitore</span></div>`;
  };

  const card = (o) => {
    const el = document.createElement("article");
    el.className = `card cat-${o.category}`;
    el.id = "o-" + o._id;

    const badges = [`<span class="badge badge-${o.category}">${CAT_LABEL[o.category]}</span>`];
    if (newIds.has(o._id)) badges.unshift(`<span class="badge badge-new">nuova</span>`);
    if (o.priceType) badges.push(`<span class="badge badge-${o.priceType}">${o.priceType}</span>`);
    if (o.greenEnergy) badges.push(`<span class="badge badge-green">🌱 green</span>`);
    if (o.coverage) badges.push(`<span class="badge badge-coverage">📍 ${esc(o.coverage)}</span>`);
    if (o.commitment === 0) badges.push(`<span class="badge badge-coverage">senza vincoli</span>`);
    else if (o.commitment) badges.push(`<span class="badge badge-coverage">vincolo ${o.commitment} mesi</span>`);

    // scadenza promo/offerta
    let expiry = "";
    if (o.promoExpiry) {
      const exp = new Date(o.promoExpiry + "T23:59:59");
      const days = Math.ceil((exp - Date.now()) / 86400000);
      const dateStr = exp.toLocaleDateString("it-IT", { day: "numeric", month: "short" });
      if (days < 0) expiry = `<span class="expiry expired">promo scaduta il ${dateStr}</span>`;
      else if (days <= 7) expiry = `<span class="expiry soon">⏳ scade ${days === 0 ? "oggi" : "il " + dateStr}${days > 0 ? ` (${days} g)` : ""}</span>`;
      else expiry = `<span class="expiry">fino al ${dateStr}</span>`;
    }

    // stima annua + variazione vs rilevazione precedente
    const est = estimate(o);
    const delta = priceDelta(o);
    const unit = o.category === "luce" ? "€/kWh" : "€/Smc";
    const deltaHtml = delta == null ? "" :
      `<span class="delta ${delta < 0 ? "down" : "up"}">${delta < 0 ? "▼" : "▲"} ${fmtPrice(Math.abs(delta))} ${o.category === "internet" ? "€/mese" : unit}</span>`;
    const sparkHtml = sparkline(state.trend?.offers?.[o._id]);
    const estHtml = est == null ? "" :
      `<div class="estimate">${est.approx ? "≈ " : ""}<strong>${fmtEur(est.v)} €</strong>/${est.label}
       <span class="estimate-note">${o.category === "internet" ? "incl. attivazione" : `per ${fmtEur(state.cons[o.category])} ${o.category === "luce" ? "kWh" : "Smc"}`}</span>${deltaHtml}${sparkHtml}</div>`;

    const feeParts = [];
    if (o.monthlyFee != null) feeParts.push(`Commercializzazione <strong>${fmtPrice(o.monthlyFee)} €/mese</strong>`);
    if (o.activationCost != null)
      feeParts.push(o.activationCost === 0 ? `Attivazione <strong>gratuita</strong>` : `Attivazione <strong>${fmtPrice(o.activationCost)} €</strong>`);
    if (o.modemIncluded === true) feeParts.push(`Modem <strong>incluso</strong>`);

    const extras = (o.extraCosts || []).concat(o.notes ? [o.notes] : []);

    const starred = state.saved.has(o._id);
    el.innerHTML = `
      <div class="card-head">
        <div class="card-provider">
          <div class="avatar" style="background:${avatarColor(o.provider)}">${esc(initials(o.provider))}</div>
          <div class="card-titles">
            <div class="card-name">${esc(o.name)}</div>
            <div class="card-brand">${esc(o.provider)}</div>
          </div>
        </div>
        <div class="badges">${badges.join("")}</div>
      </div>
      ${priceBlock(o)}
      ${estHtml}
      ${feeParts.length ? `<div class="fee">${feeParts.join(" · ")}</div>` : ""}
      ${o.promo ? `<div class="promo${isExpired(o) ? " promo-expired" : ""}"><span>${esc(o.promo)} ${expiry}</span></div>` : expiry ? `<div class="fee">${expiry}</div>` : ""}
      ${extras.length ? `<details class="details"><summary>Dettagli e costi aggiuntivi</summary><ul>${extras.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}
      <div class="card-actions">
        <button class="star ${starred ? "is-on" : ""}" data-star="${o._id}" aria-label="${starred ? "Rimuovi dalle salvate" : "Salva offerta"}" title="Salva">${starred ? "★" : "☆"}</button>
        <button class="linkbtn" data-share="${o._id}" aria-label="Copia link all'offerta" title="Copia link">🔗</button>
        <a class="card-cta" href="${esc(o.url)}" target="_blank" rel="noopener noreferrer">
          Vai all'offerta
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9"/></svg>
        </a>
      </div>`;
    return el;
  };

  grid.addEventListener("click", (e) => {
    const star = e.target.closest("[data-star]");
    if (star) {
      const id = star.dataset.star;
      state.saved.has(id) ? state.saved.delete(id) : state.saved.add(id);
      persistSaved();
      star.classList.toggle("is-on");
      star.textContent = state.saved.has(id) ? "★" : "☆";
      if (state.chips.has("saved")) render();
      return;
    }
    const share = e.target.closest("[data-share]");
    if (share) {
      const url = `${location.origin}${location.pathname}?o=${share.dataset.share}`;
      navigator.clipboard?.writeText(url).then(() => {
        share.textContent = "✓";
        setTimeout(() => (share.textContent = "🔗"), 1200);
      });
    }
  });

  /* ---------- render ---------- */
  const render = () => {
    if (state.cat === "all" && state.chips.has("dualfuel")) { renderDualFuel(); return; }
    const list = state.offers.filter(passes);
    list.sort((a, b) => {
      if (state.sort === "provider") return a.provider.localeCompare(b.provider, "it");
      const va = sortValue(a), vb = sortValue(b);
      if (va.tier !== vb.tier) return va.tier - vb.tier;
      return state.sort === "price-desc" ? vb.v - va.v : va.v - vb.v;
    });
    grid.innerHTML = "";
    for (const o of list) grid.appendChild(card(o));
    empty.hidden = list.length > 0;
    counter.hidden = false;
    counter.innerHTML = `${list.length} offert${list.length === 1 ? "a" : "e"}${state.cat !== "all" ? ` · ${CAT_LABEL[state.cat]}` : ""}`;
    if (state.cat === "luce" || state.cat === "gas") {
      const unit = state.cat === "luce" ? "kWh" : "Smc";
      counter.innerHTML += ` · stima per <input id="consInput" class="cons-input" type="number" min="1" step="100" value="${state.cons[state.cat]}"> ${unit}/anno`;
      counter.querySelector("#consInput").addEventListener("change", (e) => {
        const v = parseInt(e.target.value, 10);
        if (v > 0) { state.cons[state.cat] = v; persistCons(); render(); }
      });
    }
  };

  /* ---------- deep link ?o=id ---------- */
  const openDeepLink = () => {
    const id = new URLSearchParams(location.search).get("o");
    if (!id) return;
    const target = document.getElementById("o-" + id);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("is-highlight");
    setTimeout(() => target.classList.remove("is-highlight"), 3000);
  };

  /* ---------- striscia indici PUN/PSV ---------- */
  const renderIndices = () => {
    const { pun, psv, punMonth } = state.indices || {};
    if (pun == null && psv == null) return;
    const strip = document.createElement("div");
    strip.className = "indices-strip";
    strip.innerHTML = `Indici di riferimento${punMonth ? ` (${esc(punMonth)})` : ""}:
      ${pun != null ? `<strong>PUN ${fmtPrice(pun)} €/kWh</strong><span class="idx-spark idx-pun"></span>` : ""}
      ${psv != null ? `<strong>PSV ${fmtPrice(psv)} €/Smc</strong><span class="idx-spark idx-psv"></span>` : ""}`;
    $(".main").prepend(strip);
    // sparkline degli indici quando lo storico avrà ≥2 punti
    fetch("data/trend.json").then((r) => r.json()).then((t) => {
      if (t.pun?.length >= 2) strip.querySelector(".idx-pun").innerHTML = sparkline(t.pun);
      if (t.psv?.length >= 2) strip.querySelector(".idx-psv").innerHTML = sparkline(t.psv);
    }).catch(() => {});
  };

  /* ---------- storico ---------- */
  const loadHistory = (updatedAt) => {
    const today = (updatedAt || "").slice(0, 10);
    fetch("data/history/index.json")
      .then((r) => r.json())
      .then((dates) => {
        const prev = dates.filter((d) => d < today).sort().pop();
        if (!prev) return null;
        return fetch(`data/history/${prev}.json`).then((r) => r.json());
      })
      .then((old) => {
        if (!old) return;
        state.history = new Map(old.offers.map((o) => [slug(o), o]));
        render();
      })
      .catch(() => {});
  };

  /* ---------- load ---------- */
  fetch("data/offers.json")
    .then((r) => r.json())
    .then((data) => {
      state.offers = data.offers || [];
      state.indices = data.indices || {};
      for (const o of state.offers) o._id = slug(o);
      window.TARIFFE = { offers: state.offers, indices: state.indices, estimate };
      document.dispatchEvent(new CustomEvent("offers-ready"));
      const d = new Date(data.updatedAt);
      $("#updated").textContent = `Aggiornato: ${d.toLocaleDateString("it-IT", { day: "numeric", month: "short", year: "numeric" })}`;
      loading.hidden = true;
      detectNew();
      renderIndices();
      renderChips();
      render();
      openDeepLink();
      savingsBanner();
      loadHistory(data.updatedAt);
      fetch("data/trend.json")
        .then((r) => r.json())
        .then((t) => { state.trend = t; render(); })
        .catch(() => {});
    })
    .catch(() => {
      loading.textContent = "Errore nel caricamento delle offerte 😕";
    });

  /* ---------- service worker ---------- */
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
