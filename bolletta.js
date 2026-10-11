/* TariffeOggi — lettura bolletta e confronto (tutto client-side) */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const dropzone = $("#dropzone");
  const fileInput = $("#billFile");
  const statusBox = $("#billStatus");
  const form = $("#billForm");
  const savedBox = $("#billSaved");
  const compareBox = $("#billCompare");

  const STORE_KEY = "tariffe-bill"; // { luce: {...}, gas: {...} }
  const loadBills = () => {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
  };
  const saveBills = (b) => localStorage.setItem(STORE_KEY, JSON.stringify(b));

  const fmt = (n, dec = 2) => n.toLocaleString("it-IT", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- caricamento pdf.js on-demand ---------- */
  let pdfjsPromise = null;
  const getPdfjs = () => {
    if (!pdfjsPromise) {
      pdfjsPromise = import("./vendor/pdf.min.mjs").then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.mjs";
        return lib;
      });
    }
    return pdfjsPromise;
  };

  /* ---------- estrazione euristica (site/extract.js, testato in CI) ---------- */
  const extract = (text) => window.BillExtract.extract(text);

  const setStatus = (msg, kind = "") => {
    statusBox.hidden = false;
    statusBox.className = "bill-status " + kind;
    statusBox.textContent = msg;
  };

  const readPdf = async (file) => {
    setStatus("⏳ Leggo la bolletta…");
    try {
      const pdfjs = await getPdfjs();
      const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
      let text = "";
      for (let i = 1; i <= Math.min(doc.numPages, 10); i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map((it) => it.str).join(" ") + "\n";
      }
      if (text.trim().length < 50) {
        setStatus("⚠️ PDF senza testo estraibile (probabile scansione): inserisci i dati a mano qui sotto.", "warn");
        form.hidden = false;
        return;
      }
      const data = extract(text);
      fillForm(data);
      const found = ["code", "price", "cons", "provider"].filter((k) => data[k] != null).length;
      setStatus(found > 1
        ? `✅ Dati estratti (${found}/4 campi): controlla e correggi se serve.`
        : "⚠️ Estrazione parziale: completa i campi mancanti a mano.", found > 1 ? "ok" : "warn");
      form.hidden = false;
      form.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      setStatus("❌ Non riesco a leggere questo PDF: inserisci i dati a mano.", "warn");
      form.hidden = false;
    }
  };

  /* ---------- form ---------- */
  const syncUnits = () => {
    const t = $("#bfType").value;
    const net = t === "internet";
    $("#bfPriceUnit").textContent = net ? "€/mese (canone)" : t === "gas" ? "€/Smc" : "€/kWh";
    $("#bfConsUnit").textContent = t === "gas" ? "Smc" : "kWh";
    $("#bfCode").placeholder = t === "gas" ? "PDR (14 cifre)" : "POD (IT001E…)";
    $("#bfCodeLabel").hidden = net;
    $("#bfFeeLabel").hidden = net;
    $("#bfConsLabel").hidden = net;
  };
  $("#bfType").addEventListener("change", syncUnits);

  const fillForm = (d) => {
    if (d.type) $("#bfType").value = d.type;
    if (d.provider) $("#bfProvider").value = d.provider;
    if (d.code) $("#bfCode").value = d.code;
    if (d.price != null) $("#bfPrice").value = d.price;
    if (d.fee != null) $("#bfFee").value = d.fee;
    if (d.cons != null) $("#bfCons").value = d.cons;
    syncUnits();
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const bill = {
      type: $("#bfType").value,
      provider: $("#bfProvider").value.trim(),
      code: $("#bfCode").value.trim(),
      price: parseFloat($("#bfPrice").value) || null,
      fee: parseFloat($("#bfFee").value) || 0,
      cons: parseFloat($("#bfCons").value) || null,
      savedAt: new Date().toISOString(),
    };
    if (bill.type === "internet" ? bill.price == null : bill.price == null || bill.cons == null) {
      setStatus(bill.type === "internet"
        ? "⚠️ Serve il canone mensile attuale per il confronto."
        : "⚠️ Servono almeno prezzo materia e consumo annuo per il confronto.", "warn");
      return;
    }
    const bills = loadBills();
    bills[bill.type] = bill;
    saveBills(bills);
    form.hidden = true;
    statusBox.hidden = true;
    renderSaved();
  });

  /* ---------- confronto ---------- */
  const annualUser = (b) =>
    b.type === "internet" ? b.price * 12 : b.cons * b.price + (b.fee || 0) * 12;

  const annualOffer = (o, b, indices) => {
    if (o.category === "internet") return window.TARIFFE?.estimate?.(o)?.v ?? null;
    const fee = (o.monthlyFee || 0) * 12;
    if (typeof o.price === "number") return b.cons * o.price + fee;
    if (o.priceType === "variabile" && o.spreadValue != null) {
      const idx = o.category === "luce" ? indices.pun : indices.psv;
      if (idx != null) return b.cons * (idx + o.spreadValue) + fee;
    }
    return null;
  };

  const renderCompare = (type) => {
    const bills = loadBills();
    const b = bills[type];
    compareBox.innerHTML = "";
    if (!b || !window.TARIFFE) return;
    const { offers, indices } = window.TARIFFE;
    const mine = annualUser(b);
    const rows = offers
      .filter((o) => o.category === type)
      .map((o) => ({ o, est: annualOffer(o, b, indices || {}) }))
      .filter((r) => r.est != null)
      .sort((a, z) => a.est - z.est);

    const idxNote = type === "internet"
      ? "Stima del primo anno: promo per la sua durata + listino + attivazione."
      : (indices && (type === "luce" ? indices.pun : indices.psv)) != null
      ? `Le offerte variabili sono stimate con l'indice ${type === "luce" ? "PUN" : "PSV"} di riferimento (${type === "luce" ? indices.pun + " €/kWh" : indices.psv + " €/Smc"}${indices.punMonth || indices.psvMonth ? ", " + esc(type === "luce" ? indices.punMonth || "" : indices.psvMonth || "") : ""}).`
      : "Offerte variabili escluse: indice di riferimento non disponibile.";

    const skipped = offers.filter((o) => o.category === type).length - rows.length;

    const typeLabel = { luce: "⚡ luce", gas: "🔥 gas", internet: "🌐 internet" }[type];
    compareBox.innerHTML = `
      <h3>Confronto per la tua bolletta ${typeLabel}</h3>
      <div class="bill-mine">
        <span>${type === "internet" ? "Il tuo canone attuale su base annua" : "La tua spesa materia stimata"}</span>
        <strong>${fmt(mine)} €/anno</strong>
        <small>${esc(b.provider || "fornitore attuale")}${type === "internet" ? "" : ` · ${fmt(b.cons, 0)} ${type === "gas" ? "Smc" : "kWh"}/anno · componenti regolate e imposte escluse`}</small>
      </div>
      <div class="bill-rows">
        ${rows.slice(0, 12).map(({ o, est }) => {
          const delta = mine - est;
          const good = delta > 0;
          return `<div class="bill-row ${good ? "good" : "bad"}">
            <div class="bill-row-name">
              <strong>${esc(o.name)}</strong>
              <span>${esc(o.provider)}${o.priceType ? " · " + o.priceType : ""}</span>
            </div>
            <div class="bill-row-est">${fmt(est)} €/anno</div>
            <div class="bill-row-delta">${good ? "▼ risparmi " + fmt(delta) : "▲ spendi " + fmt(-delta)} €</div>
            <a href="${esc(o.url)}" target="_blank" rel="noopener noreferrer">Vai ↗</a>
          </div>`;
        }).join("")}
      </div>
      <p class="bill-note">${idxNote}${skipped > 0 ? ` ${skipped} offerte senza prezzo stimabile non sono mostrate.` : ""}
      Stima sulla sola componente materia prima con i tuoi consumi: oneri di rete, imposte e promo una tantum esclusi.</p>`;
  };

  const renderSaved = () => {
    const bills = loadBills();
    const types = Object.keys(bills);
    savedBox.innerHTML = "";
    if (!types.length) { compareBox.innerHTML = ""; return; }
    savedBox.innerHTML = types.map((t) => {
      const b = bills[t];
      const emoji = { luce: "⚡", gas: "🔥", internet: "🌐" }[t];
      const detail = t === "internet"
        ? `${fmt(b.price)} €/mese`
        : `${fmt(b.price, 4)} ${t === "gas" ? "€/Smc" : "€/kWh"} · ${fmt(b.cons, 0)} ${t === "gas" ? "Smc" : "kWh"}/anno`;
      return `<div class="bill-chip">
        <span>${emoji} <strong>${esc(b.provider || t)}</strong> · ${detail}</span>
        <button data-show="${t}">Confronta</button>
        <button data-del="${t}" aria-label="Elimina">🗑</button>
      </div>`;
    }).join("");
    renderCompare(types[0]);
  };

  savedBox.addEventListener("click", (e) => {
    const show = e.target.closest("[data-show]");
    const del = e.target.closest("[data-del]");
    if (show) renderCompare(show.dataset.show);
    if (del) {
      const bills = loadBills();
      delete bills[del.dataset.del];
      saveBills(bills);
      renderSaved();
    }
  });

  /* ---------- dropzone ---------- */
  const handleFile = (f) => {
    if (!f) return;
    if (f.type !== "application/pdf" && !/\.pdf$/i.test(f.name)) {
      setStatus("⚠️ Serve un PDF: esporta la bolletta in PDF dall'area clienti del tuo fornitore.", "warn");
      return;
    }
    readPdf(f);
  };
  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fileInput.click(); });
  fileInput.addEventListener("change", () => handleFile(fileInput.files[0]));
  ["dragover", "dragenter"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("is-drag"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("is-drag"); })
  );
  dropzone.addEventListener("drop", (e) => handleFile(e.dataTransfer.files[0]));

  document.addEventListener("bill-open", renderSaved);
  document.addEventListener("offers-ready", () => {
    if (!$("#billPanel").hidden) renderSaved();
  });
})();
