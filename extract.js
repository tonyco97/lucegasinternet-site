/* TariffeOggi — euristiche di estrazione dal testo della bolletta.
   File senza dipendenze, usato dal browser (window.BillExtract) e dai test node. */
(function (root) {
  "use strict";

  const PROVIDERS = [
    "Enel Energia", "Eni Plenitude", "Plenitude", "Edison", "A2A", "Iren", "Acea",
    "Sorgenia", "Octopus", "NeN", "Illumia", "wekiwi", "Engie", "E.ON", "Pulsee",
    "Tate", "Alperia", "Dolomiti Energia", "Hera", "Poste Energia", "AGSM", "Estra",
    "Optima", "ABenergie", "Withu", "Bluenergy", "Duferco", "VIVI energia", "Repower",
    "Servizio Elettrico Nazionale",
  ];

  // formato italiano: la virgola è il decimale, il punto le migliaia.
  // Senza virgola: "2.700" (gruppi di 3 cifre) sono migliaia, "0.18" è un decimale.
  const toNum = (s) => {
    s = String(s);
    if (s.includes(",")) return parseFloat(s.replace(/\./g, "").replace(",", "."));
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) return parseFloat(s.replace(/\./g, ""));
    return parseFloat(s);
  };

  const extract = (text) => {
    const out = {};
    const pod = text.match(/\bIT\s?\d{3}\s?E\s?[0-9A-Z]{8,9}\b/i);
    const pdr = text.match(/\b(\d{14})\b/);
    if (pod) { out.type = "luce"; out.code = pod[0].replace(/\s/g, ""); }
    else if (pdr) { out.type = "gas"; out.code = pdr[1]; }

    // se il testo parla di Smc/gas naturale, forza gas
    if (/\bsmc\b|gas naturale/i.test(text) && !pod) out.type = "gas";

    for (const p of PROVIDERS) {
      if (new RegExp(p.replace(/\./g, "\\."), "i").test(text)) { out.provider = p; break; }
    }

    const unit = out.type === "gas" ? "Smc" : "kWh";
    // prezzo materia: valore plausibile più basso vicino a €/kWh o €/Smc
    const priceRe = new RegExp("(\\d+[.,]\\d{2,6})\\s*(?:€|euro)\\s*\\/?\\s*" + unit, "gi");
    let m; const prices = [];
    while ((m = priceRe.exec(text)) !== null) {
      const v = toNum(m[1]);
      if (out.type === "gas" ? v > 0.1 && v < 3 : v > 0.03 && v < 1) prices.push(v);
    }
    if (prices.length) out.price = Math.min(...prices);

    const cons = text.match(new RegExp("consumo\\s+annuo[^0-9]{0,80}([\\d.]+(?:,\\d+)?)\\s*" + unit, "i"))
      || text.match(new RegExp("([\\d.]+(?:,\\d+)?)\\s*" + unit + "[^.]{0,40}consumo\\s+annuo", "i"));
    if (cons) out.cons = Math.round(toNum(cons[1]));

    const fee = text.match(/(?:quota\s+fissa|commercializzazione)[^0-9]{0,60}(\d+[.,]\d{2})\s*(?:€|euro)?\s*\/?\s*mese/i);
    if (fee) out.fee = toNum(fee[1]);

    return out;
  };

  const api = { extract, PROVIDERS, toNum };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BillExtract = api;
})(typeof self !== "undefined" ? self : globalThis);
