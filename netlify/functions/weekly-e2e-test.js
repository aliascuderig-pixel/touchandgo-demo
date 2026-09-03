// Netlify Scheduled Function — test end-to-end settimanale, SOLO sullo
// spazio ospite (mai su produzione). Diverso per natura da
// daily-healthcheck.js (che verifica solo "il sito risponde?", a costo
// zero, ogni giorno): qui si rifà un vero acquisto simulato — due
// classificazioni AI reali, due acquisti, un gruppo di spedizione
// consolidato — perché è esattamente questo tipo di percorso profondo che
// ha fatto scoprire dal vivo un bug reale (limite di prezzo troppo basso
// in isValidPurchase(), corretto in PR #31): un controllo "il sito
// risponde" non lo avrebbe mai trovato. Vedi MANUALE.md, "Test end-to-end
// settimanale (spazio ospite)".
//
// Frequenza: UNA VOLTA A SETTIMANA, non giornaliera — a differenza di
// health.js (costo zero, vedi commento lì), qui classify.js fa una vera
// chiamata a pagamento all'API Anthropic, due volte per esecuzione: il
// costo reale, per quanto piccolo, va comunque contenuto.
//
// Stessa sintassi/comportamento di schedule() già verificato per
// daily-healthcheck.js: @netlify/functions v6.0.0, schedule(cron,
// handler) restituisce l'handler invariato a runtime (il cron è letto
// staticamente in fase di build) — chiamare l'URL manualmente esegue
// comunque l'handler reale.
const { schedule } = require("@netlify/functions");
const { getStore } = require("@netlify/blobs");
const { isGuestMode, guestScopedStoreName } = require("../lib/guest-mode");

// ===========================================================================
// SICUREZZA: unico punto della funzione da cui parte qualunque chiamata di
// rete verso "il sito" (classificazione, salvataggio acquisti/gruppo) — vedi
// guestUrl() più sotto, l'UNICO modo consentito per costruire uno di questi
// URL in tutto il file. KNOWN_PRODUCTION_URL non viene MAI passata a fetch()
// da nessuna parte: esiste solo come sentinella per l'autoverifica.
// ===========================================================================
const GUEST_BASE_URL = "https://touchandgo-guest.netlify.app/";
const KNOWN_PRODUCTION_URL = "https://benevolent-longma-57c78a.netlify.app/";

// Richiamata sia una volta in testa a runWeeklyE2ETest() sia dentro guestUrl()
// ad ogni singola chiamata (difesa in profondità, costo trascurabile): se
// GUEST_BASE_URL fosse mai modificata per errore in un modo che la fa
// somigliare al dominio di produzione (o smette di contenere il nome
// atteso), la funzione si ferma con un errore chiaro PRIMA di qualunque
// fetch — mai un tentativo silenzioso verso il sito vero.
function assertTargetIsGuestOrThrow() {
  if (typeof GUEST_BASE_URL !== "string" || !GUEST_BASE_URL.includes("touchandgo-guest.netlify.app")) {
    throw new Error(
      "SICUREZZA: GUEST_BASE_URL non risulta puntare allo spazio ospite atteso — interrotto prima di qualunque chiamata di rete."
    );
  }
  if (GUEST_BASE_URL === KNOWN_PRODUCTION_URL) {
    throw new Error("SICUREZZA: GUEST_BASE_URL coincide col dominio di produzione — interrotto prima di qualunque chiamata di rete.");
  }
}

function guestUrl(path) {
  assertTargetIsGuestOrThrow();
  return GUEST_BASE_URL + path;
}

const CLASSIFY_TIMEOUT_MS = 15000; // vera chiamata AI, più lenta di un semplice health-check
const CALL_TIMEOUT_MS = 6000; // save-purchase/save-shipment-group
const TOTAL_BUDGET_MS = 30000;
const REPORT_STORE_NAME = "weekly-e2e-reports";
const KEEP_REPORTS = 12; // ~3 mesi a cadenza settimanale

function blobsAuth() {
  return {
    siteID: process.env.NETLIFY_BLOBS_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  };
}

// Suffisso "-guest" INCONDIZIONATO, non tramite guestScopedStoreName() (che
// dipenderebbe da GUEST_MODE di QUESTA esecuzione — sempre false qui, questa
// function gira sul deploy di produzione, vedi la guardia isGuestMode() in
// testa a runWeeklyE2ETest). Stesso principio di guestSuffixedStoreName() in
// touchandgo-internal/netlify/lib/guest-mode.js: da qui vogliamo SEMPRE
// leggere i dati dello spazio ospite, indipendentemente da come gira questa
// esecuzione — usato SOLO per le verifiche di lettura del passo 5, MAI per
// scrivere (le scritture avvengono solo via le tre fetch verso guestUrl()).
function guestSuffixedStore(baseName) {
  return getStore({ name: `${baseName}-guest`, ...blobsAuth() });
}

// ---------------------------------------------------------------------
// Dati del test — stessa forma dello schema di classificazione reale
// (CLASSIFY_SCHEMA in dist/assets/app.js) e stesso prompt testuale già
// usato da classifyText() lì: testo, non foto, per non dover
// gestire/generare immagini qui. Due descrizioni diverse, riconoscibili
// come test automatico anche solo leggendole nel CRM ospite.
// ---------------------------------------------------------------------
const CLASSIFY_SCHEMA =
  '{"object_it":"...","object_en":"...","hs_code":"6 cifre","hs_description_it":"...","hs_description_en":"...","category":"Ceramica|Abbigliamento|Alimentari|Vino & Spirits|Accessori Moda|Arte & Antiquariato|Gioielleria|Artigianato|Altro","material":"materiale costruttivo principale, breve (es. pelle, cotone, ceramica, vetro, legno, metallo, misto)","weight_kg":1.0,"length_cm":0,"width_cm":0,"height_cm":0,"value_eur":0,"fragile":false,"made_in_italy":true,"confidence":"alta|media|bassa","shipping_note_it":"...","shipping_note_en":"..."}';

const LABEL_1 = "Test automatico settimanale — oggetto artigianale in legno, non cancellare manualmente se visto nel CRM ospite";
const LABEL_2 = "Test automatico settimanale — sciarpa di seta dipinta a mano, non cancellare manualmente se visto nel CRM ospite";

// Francia/Germania (Unione Europea) — deliberatamente diversa dal Giappone
// già usato nei test manuali dal vivo di oggi (PR #31), per non confondere
// i dati. "Unione Europea" è il valore esatto già presente in DESTINATIONS
// (dist/assets/app.js): non esiste una voce separata per singolo paese UE.
const DESTINATION_COUNTRY = "Unione Europea";
const ADDRESS_LABEL = "Test E2E settimanale — Parigi, Francia (Unione Europea)";
const TOURIST_NAME = "Test E2E Settimanale";
const TOURIST_EMAIL = "weekly-e2e-test@touchandgo-internal-test.it";

// ---------------------------------------------------------------------
// Prezzo: REPLICA delle formule in dist/assets/app.js (SHIPPING_RATES,
// SHIPPING_MARGIN, FULL_FEE, volumetricWeight, bracketPrice,
// consolidatedGroupPrice) — duplicata qui perché quel codice è
// interamente client-side (verificato: nessun modulo server-side lo
// esporta), non richiamabile direttamente da una Netlify Function. Solo
// il sottoinsieme necessario per il caso di questo test (zona
// "transfrontaliero", pricingTier sempre "pieno" — niente abbonamento,
// breakeven o sconti partner, mai usati da questo test). Se le formule in
// app.js cambiano, questa replica va aggiornata a mano — nessun modo
// automatico di tenerle sincronizzate finché restano in due posti.
// ---------------------------------------------------------------------
const FULL_FEE = 39;
const SHIPPING_MARGIN = 0.25;
const ZONE_TRANSFRONTALIERO = {
  brackets: [[1, 15], [2, 20], [5, 26], [10, 34], [20, 44], [30, 55]],
  perKgOver: 2.2,
};

function volumetricWeight(dims) {
  if (!dims) return 0;
  const l = parseFloat(dims.length_cm) || 0;
  const w = parseFloat(dims.width_cm) || 0;
  const h = parseFloat(dims.height_cm) || 0;
  if (!l || !w || !h) return 0;
  return (l * w * h) / 5000;
}

function bracketPrice(weightKg) {
  for (const [maxKg, price] of ZONE_TRANSFRONTALIERO.brackets) {
    if (weightKg <= maxKg) return price;
  }
  const [lastMaxKg, lastPrice] = ZONE_TRANSFRONTALIERO.brackets[ZONE_TRANSFRONTALIERO.brackets.length - 1];
  return lastPrice + (weightKg - lastMaxKg) * ZONE_TRANSFRONTALIERO.perKgOver;
}

// Prezzo individuale stimato per UN oggetto da solo — stessa formula di
// priceFor()/shippingCost() in app.js con pricingTier "pieno" (FULL_FEE).
function computeIndividualPrice(weightKg, dims) {
  const realWeight = Math.max(0.3, parseFloat(weightKg) || 1);
  const billableWeight = Math.max(realWeight, volumetricWeight(dims));
  const rawCost = bracketPrice(billableWeight);
  const shipping = parseFloat((rawCost * (1 + SHIPPING_MARGIN)).toFixed(2));
  return parseFloat((shipping + FULL_FEE).toFixed(2));
}

// Prezzo consolidato per il GRUPPO — stessa formula di
// consolidatedGroupPrice() in app.js: peso reale combinato (somma dei pesi
// individuali, ciascuno mai sotto 0.3kg), peso volumetrico combinato
// (somma, non un unico volume "ottimizzato" — vedi commento in app.js), il
// maggiore dei due è il peso fatturabile, UNA sola fee di servizio per
// l'intero gruppo (mai una per oggetto).
function computeConsolidatedPrice(items) {
  const combinedRealWeight = items.reduce((sum, it) => sum + Math.max(0.3, parseFloat(it.weightKg) || 1), 0);
  const combinedVolumetricWeight = items.reduce((sum, it) => sum + volumetricWeight(it.dims), 0);
  const billableWeight = Math.max(combinedRealWeight, combinedVolumetricWeight);
  const rawCost = bracketPrice(billableWeight);
  const shipping = parseFloat((rawCost * (1 + SHIPPING_MARGIN)).toFixed(2));
  const total = Math.round((shipping + FULL_FEE) * 100) / 100;
  return { weightKg: parseFloat(billableWeight.toFixed(2)), shipping, fee: FULL_FEE, total };
}

// Controllo di business esplicitamente richiesto: il prezzo consolidato del
// gruppo non deve mai superare la somma dei prezzi individuali stimati (il
// consolidamento risparmia una fee di servizio, non ne aggiunge mai) — se
// succede, è un bug reale in consolidatedGroupPrice()/nella sua replica
// qui, da segnalare nel report, mai silenziare. Piccola tolleranza (1
// centesimo) solo per arrotondamenti in virgola mobile, non per
// mascherare un problema reale.
function checkConsolidatedNotGreaterThanSum(individualPrices, consolidatedTotal) {
  const sum = Math.round(individualPrices.reduce((s, p) => s + p, 0) * 100) / 100;
  const withinBounds = consolidatedTotal <= sum + 0.01;
  const result = { status: withinBounds ? "ok" : "problem", individualSum: sum, consolidatedTotal };
  if (!withinBounds) {
    result.error = `Prezzo consolidato (€${consolidatedTotal}) MAGGIORE della somma dei prezzi individuali (€${sum}) — bug reale in consolidatedGroupPrice() o nella sua replica qui, non un arrotondamento.`;
  }
  return result;
}

async function timedFetch(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || CALL_TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return { res, responseTimeMs: Date.now() - start };
  } finally {
    clearTimeout(timeout);
  }
}

// Passi 1/2: classificazione AI reale (testo, non foto) sullo spazio
// ospite — stesso prompt/schema esatti di classifyText() in app.js.
async function classifyOnGuest(label) {
  const prompt = `Sei un esperto di classificazione doganale per acquisti turistici in Italia.\nClassifica: "${label}"\nRispondi SOLO con JSON valido:\n${CLASSIFY_SCHEMA}`;
  const { res, responseTimeMs } = await timedFetch(
    guestUrl(".netlify/functions/classify"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
    },
    CLASSIFY_TIMEOUT_MS
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Errore classificazione AI");
  const text = data.content && data.content[0] && data.content[0].text;
  if (!text) throw new Error("Risposta AI vuota");
  const parsed = JSON.parse(String(text).replace(/```json|```/g, "").trim());
  return { parsed, responseTimeMs };
}

// Passo 3: salva un acquisto sullo spazio ospite — status "in sospeso"
// (come richiesto: non si simula un ritiro reale, solo l'intake).
async function savePurchaseOnGuest(item) {
  const { res, responseTimeMs } = await timedFetch(guestUrl(".netlify/functions/save-purchase"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(item),
  });
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    // corpo non-JSON: gestito sotto come errore generico HTTP
  }
  if (res.status !== 200 || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return { responseTimeMs };
}

// Passo 4: salva il gruppo di spedizione consolidato sullo spazio ospite.
async function saveShipmentGroupOnGuest(group) {
  const { res, responseTimeMs } = await timedFetch(guestUrl(".netlify/functions/save-shipment-group"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(group),
  });
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    // corpo non-JSON: gestito sotto come errore generico HTTP
  }
  if (res.status !== 200 || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return { responseTimeMs };
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

async function cleanupOldReports(store) {
  try {
    const { blobs } = await store.list();
    const keys = blobs.map((b) => b.key).sort();
    const toDelete = keys.slice(0, Math.max(0, keys.length - KEEP_REPORTS));
    await Promise.all(toDelete.map((key) => store.delete(key).catch(() => {})));
  } catch (e) {
    // Best-effort: un errore nella pulizia non deve mai far fallire il
    // salvataggio del report di questa esecuzione, già avvenuto prima.
  }
}

async function saveReport(report) {
  const store = getStore({ name: guestScopedStoreName(REPORT_STORE_NAME), ...blobsAuth() });
  await store.setJSON(report.date, report);
  await cleanupOldReports(store);
}

// ---------------------------------------------------------------------
// Orchestrazione principale — sequenziale e dipendente (a differenza dei
// quattro controlli indipendenti di daily-healthcheck.js): non si può
// salvare il prezzo di un gruppo senza aver prima classificato entrambi
// gli oggetti, né verificarne il salvataggio senza averli prima salvati.
// Un fallimento in un passo iniziale interrompe i passi successivi che ne
// dipendono, MA il report viene comunque sempre salvato con lo stato
// parziale raccolto fino a quel momento — mai un'eccezione non gestita
// che faccia sparire ogni traccia dell'esecuzione.
// ---------------------------------------------------------------------
async function runWeeklyE2ETest() {
  // Stessa ragione di daily-healthcheck.js: questa function esiste nello
  // stesso repository deployato anche come sito ospite (GUEST_MODE=true
  // lì) — se eseguita da quel deploy produrrebbe un secondo, inutile,
  // giro di classificazioni reali (costo AI raddoppiato) e un report
  // duplicato. Il test è responsabilità del solo deploy di produzione,
  // che verifica lo spazio ospite dall'esterno.
  if (isGuestMode()) {
    return { skipped: true, reason: "guest_mode" };
  }
  // Verifica di sicurezza esplicita PRIMA di qualunque altra cosa, come
  // richiesto: se il target non è verificabile con certezza come lo
  // spazio ospite, ci si ferma qui, senza aver fatto alcuna chiamata.
  assertTargetIsGuestOrThrow();

  const startedAt = Date.now();
  const checkedAt = new Date(startedAt).toISOString();
  const steps = {};
  const generatedIds = {};
  let overallStatus = "ok";

  function fail(stepName, err) {
    steps[stepName] = { status: "problem", error: (err && err.message) || String(err) };
    overallStatus = "problem";
  }

  async function finalize() {
    const totalDurationMs = Date.now() - startedAt;
    const withinTimeBudget = totalDurationMs <= TOTAL_BUDGET_MS;
    if (!withinTimeBudget) overallStatus = "problem";
    const report = {
      date: checkedAt.slice(0, 10),
      checkedAt,
      overallStatus,
      totalDurationMs,
      withinTimeBudget,
      generatedIds,
      steps,
    };
    try {
      await saveReport(report);
    } catch (e) {
      // Anche se il salvataggio del report stesso fallisse (store
      // irraggiungibile), la funzione non deve propagare un'eccezione non
      // gestita — il risultato resta comunque nel valore restituito, solo
      // "reportSaveError" registra che la persistenza non è riuscita.
      report.reportSaveError = e.message || String(e);
    }
    return report;
  }

  // ---- Passi 1+2: classificazione AI reale sui due oggetti di test ----
  let classification1 = null;
  let classification2 = null;
  try {
    const r1 = await classifyOnGuest(LABEL_1);
    classification1 = r1.parsed;
    steps.classifyItem1 = {
      status: "ok",
      responseTimeMs: r1.responseTimeMs,
      objectName: classification1.object_it,
      weightKg: classification1.weight_kg,
    };
  } catch (e) {
    fail("classifyItem1", e);
  }
  try {
    const r2 = await classifyOnGuest(LABEL_2);
    classification2 = r2.parsed;
    steps.classifyItem2 = {
      status: "ok",
      responseTimeMs: r2.responseTimeMs,
      objectName: classification2.object_it,
      weightKg: classification2.weight_kg,
    };
  } catch (e) {
    fail("classifyItem2", e);
  }

  if (!classification1 || !classification2) {
    // Senza entrambe le classificazioni non si può costruire un gruppo
    // coerente: i passi successivi vengono esplicitamente segnati come
    // saltati, non semplicemente omessi dal report.
    steps.savePurchase1 = steps.savePurchase1 || { status: "skipped", reason: "classificazione mancante" };
    steps.savePurchase2 = steps.savePurchase2 || { status: "skipped", reason: "classificazione mancante" };
    steps.saveShipmentGroup = { status: "skipped", reason: "classificazione mancante" };
    steps.verifyPurchasesSaved = { status: "skipped", reason: "classificazione mancante" };
    steps.verifyShipmentGroupSaved = { status: "skipped", reason: "classificazione mancante" };
    steps.priceSanityCheck = { status: "skipped", reason: "classificazione mancante" };
    return finalize();
  }

  // ---- Passo 3: costruzione + salvataggio dei due acquisti (status "in sospeso") ----
  const now = new Date().toISOString();
  const item1 = {
    id: `TG-E2E-${randomSuffix()}`,
    date: now,
    objectName: classification1.object_it || "Test E2E oggetto 1",
    hsCode: classification1.hs_code || "000000",
    category: classification1.category || null,
    material: classification1.material || null,
    weightKg: typeof classification1.weight_kg === "number" ? classification1.weight_kg : 1,
    dims: {
      length_cm: classification1.length_cm || 10,
      width_cm: classification1.width_cm || 10,
      height_cm: classification1.height_cm || 10,
    },
    itemValue: typeof classification1.value_eur === "number" ? classification1.value_eur : 10,
    pricingTier: "pieno",
    pickupPoint: "Negozio Test E2E",
    addressLabel: ADDRESS_LABEL,
    touristName: TOURIST_NAME,
    touristEmail: TOURIST_EMAIL,
    status: "in sospeso",
  };
  item1.price = computeIndividualPrice(item1.weightKg, item1.dims);

  const item2 = {
    id: `TG-E2E-${randomSuffix()}`,
    date: now,
    objectName: classification2.object_it || "Test E2E oggetto 2",
    hsCode: classification2.hs_code || "000000",
    category: classification2.category || null,
    material: classification2.material || null,
    weightKg: typeof classification2.weight_kg === "number" ? classification2.weight_kg : 1,
    dims: {
      length_cm: classification2.length_cm || 10,
      width_cm: classification2.width_cm || 10,
      height_cm: classification2.height_cm || 10,
    },
    itemValue: typeof classification2.value_eur === "number" ? classification2.value_eur : 10,
    pricingTier: "pieno",
    pickupPoint: "Negozio Test E2E",
    addressLabel: ADDRESS_LABEL,
    touristName: TOURIST_NAME,
    touristEmail: TOURIST_EMAIL,
    status: "in sospeso",
  };
  item2.price = computeIndividualPrice(item2.weightKg, item2.dims);

  generatedIds.purchase1Id = item1.id;
  generatedIds.purchase2Id = item2.id;

  let purchase1Saved = false;
  let purchase2Saved = false;
  try {
    const r = await savePurchaseOnGuest(item1);
    steps.savePurchase1 = { status: "ok", responseTimeMs: r.responseTimeMs, id: item1.id, price: item1.price };
    purchase1Saved = true;
  } catch (e) {
    fail("savePurchase1", e);
  }
  try {
    const r = await savePurchaseOnGuest(item2);
    steps.savePurchase2 = { status: "ok", responseTimeMs: r.responseTimeMs, id: item2.id, price: item2.price };
    purchase2Saved = true;
  } catch (e) {
    fail("savePurchase2", e);
  }

  if (!purchase1Saved || !purchase2Saved) {
    steps.saveShipmentGroup = { status: "skipped", reason: "uno o entrambi gli acquisti non salvati" };
    steps.verifyPurchasesSaved = { status: "skipped", reason: "uno o entrambi gli acquisti non salvati" };
    steps.verifyShipmentGroupSaved = { status: "skipped", reason: "gruppo non salvato" };
    steps.priceSanityCheck = { status: "skipped", reason: "gruppo non salvato" };
    return finalize();
  }

  // ---- Passo 4: prezzo consolidato + salvataggio del gruppo ----
  const pricing = computeConsolidatedPrice([item1, item2]);
  const groupCode = `TG-E2E-GRP-${randomSuffix()}`;
  generatedIds.groupCode = groupCode;
  const group = {
    code: groupCode,
    dest: ADDRESS_LABEL,
    destinationCountry: DESTINATION_COUNTRY,
    itemIds: [item1.id, item2.id],
    itemCount: 2,
    weightKg: pricing.weightKg,
    shipping: pricing.shipping,
    fee: pricing.fee,
    total: pricing.total,
    touristEmail: TOURIST_EMAIL,
    createdAt: now,
  };

  let groupSaved = false;
  try {
    const r = await saveShipmentGroupOnGuest(group);
    steps.saveShipmentGroup = { status: "ok", responseTimeMs: r.responseTimeMs, code: groupCode, total: pricing.total };
    groupSaved = true;
  } catch (e) {
    fail("saveShipmentGroup", e);
  }

  // ---- Controllo di business: consolidato <= somma degli individuali ----
  steps.priceSanityCheck = checkConsolidatedNotGreaterThanSum([item1.price, item2.price], pricing.total);
  if (steps.priceSanityCheck.status !== "ok") overallStatus = "problem";

  // ---- Passo 5: verifica leggendo indietro dallo store (sola lettura) ----
  try {
    const purchases = guestSuffixedStore("purchases");
    const [saved1, saved2] = await Promise.all([
      purchases.get(item1.id, { type: "json" }),
      purchases.get(item2.id, { type: "json" }),
    ]);
    const item1Found = !!saved1;
    const item2Found = !!saved2;
    steps.verifyPurchasesSaved = {
      status: item1Found && item2Found ? "ok" : "problem",
      item1Found,
      item2Found,
    };
    if (!item1Found || !item2Found) {
      steps.verifyPurchasesSaved.error = "Uno o entrambi gli acquisti non risultano presenti in purchases-guest dopo il salvataggio.";
      overallStatus = "problem";
    }
  } catch (e) {
    fail("verifyPurchasesSaved", e);
  }

  if (groupSaved) {
    try {
      const shipmentGroups = guestSuffixedStore("shipment-groups");
      const savedGroup = await shipmentGroups.get(groupCode, { type: "json" });
      const found = !!savedGroup;
      steps.verifyShipmentGroupSaved = { status: found ? "ok" : "problem", found };
      if (!found) {
        steps.verifyShipmentGroupSaved.error = "Il gruppo di spedizione non risulta presente in shipment-groups-guest dopo il salvataggio.";
        overallStatus = "problem";
      }
    } catch (e) {
      fail("verifyShipmentGroupSaved", e);
    }
  } else {
    steps.verifyShipmentGroupSaved = { status: "skipped", reason: "gruppo non salvato" };
  }

  return finalize();
}

exports.handler = schedule("0 7 * * 1", async () => {
  try {
    const report = await runWeeklyE2ETest();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify(report),
    };
  } catch (err) {
    // Copre in particolare il caso in cui assertTargetIsGuestOrThrow()
    // interrompe l'esecuzione prima ancora che ci sia un "report" da
    // costruire — mai un'eccezione non gestita, ma nemmeno un tentativo
    // di salvare un report parziale quando la garanzia di sicurezza
    // stessa è quella fallita.
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: false, error: err.message || "weekly_e2e_test_error" }),
    };
  }
});

// Esportate per i test — vedi __tests__/weekly-e2e-test.test.js.
exports.runWeeklyE2ETest = runWeeklyE2ETest;
exports.computeIndividualPrice = computeIndividualPrice;
exports.computeConsolidatedPrice = computeConsolidatedPrice;
exports.checkConsolidatedNotGreaterThanSum = checkConsolidatedNotGreaterThanSum;
exports.GUEST_BASE_URL = GUEST_BASE_URL;
exports.KNOWN_PRODUCTION_URL = KNOWN_PRODUCTION_URL;
