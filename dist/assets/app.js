// Touch&Go — demo app (rebuilt: clean structure, same functionality)

const STATS = [
  { val: "57,4M", lbl: "Turisti/anno in Italia", sub: "fonte UNIMPRESE / ENIT" },
  { val: "20–25%", lbl: "Acquisti non avvenuti per problemi valigia", sub: "stima di mercato" },
  { val: "€1,27B", lbl: "Opportunità vendite mancate/anno", sub: "Italia" },
  { val: "2,8M", lbl: "Turisti cinesi/anno in Europa", sub: "spesa media 3× superiore" },
];

const STEPS = [
  "Fotografa l'oggetto con la camera dello smartphone",
  "AI identifica il codice doganale HS in 3 secondi",
  "Touch&Go orchestra il corriere internazionale più adatto",
  "Pagamento via Stripe · Apple Pay · Alipay+ · WeChat Pay",
  "QR univoco generato istantaneamente — valido 48h, monouso",
  "Il corriere ritira direttamente in negozio",
  "Tracking live fino alla consegna a casa",
];

const CLASSIFY_SCHEMA = `{"object_it":"...","object_en":"...","hs_code":"6 cifre","hs_description":"...","category":"Ceramica|Abbigliamento|Alimentari|Vino & Spirits|Accessori Moda|Arte & Antiquariato|Gioielleria|Artigianato|Altro","weight_kg":1.0,"length_cm":0,"width_cm":0,"height_cm":0,"value_eur":0,"fragile":false,"made_in_italy":true,"confidence":"alta|media|bassa","shipping_note":"..."}`;

// L'imballo non è un margine fisso: più l'oggetto è grande, più materiale
// serve in termini assoluti (stessa percentuale); se è fragile, il
// materiale protettivo (bolle d'aria, angolari, doppia parete) quasi
// raddoppia il margine necessario per lato.
const PACKAGING_BASE_RATE = 0.08; // 8% della dimensione, margine strutturale di base
const PACKAGING_MIN_CM = 2; // margine minimo anche per oggetti minuscoli
const PACKAGING_FRAGILE_MULTIPLIER = 1.8; // materiale protettivo extra se fragile

function packagingPadding(dimCm, fragile) {
  const dim = parseFloat(dimCm) || 0;
  const base = Math.max(PACKAGING_MIN_CM, dim * PACKAGING_BASE_RATE);
  return base * (fragile ? PACKAGING_FRAGILE_MULTIPLIER : 1);
}

function packagedDimensions(r) {
  if (!r || !r.length_cm || !r.width_cm || !r.height_cm) return null;
  const fragile = !!r.fragile;
  const pad = (n) => {
    const dim = parseFloat(n) || 0;
    return Math.round((dim + packagingPadding(dim, fragile)) * 10) / 10;
  };
  return { l: pad(r.length_cm), w: pad(r.width_cm), h: pad(r.height_cm) };
}

function formatDims(l, w, h) {
  return `${l} × ${w} × ${h} cm`;
}

const FULL_FEE = 39;
const SUBSCRIBED_FEE = 19;

const DESTINATIONS = [
  { name: "Italia", zone: "domestico" },
  { name: "Unione Europea", zone: "transfrontaliero" },
  { name: "Regno Unito", zone: "transfrontaliero" },
  { name: "Svizzera", zone: "transfrontaliero" },
  { name: "Stati Uniti", zone: "worldwide" },
  { name: "Emirati Arabi Uniti", zone: "worldwide" },
  { name: "Cina", zone: "worldwide" },
  { name: "Giappone", zone: "worldwide" },
  { name: "Altro / non specificata", zone: "worldwide" },
];

// Tariffe a fasce di peso per zona — costo GREZZO del corriere, prima del
// margine Touch&Go (vedi SHIPPING_MARGIN sotto). Valori aggiornati da
// ricerca reale sui corrieri aggregati da Packlink (BRT/Poste per il
// domestico, TNT/Poste Crono Internazionale per l'EU, screenshot reale
// Packlink per il worldwide: 0,5kg Italia→USA = €49-55).
// brackets: [peso_max_kg, prezzo]. Oltre l'ultima fascia si applica
// perKgOver per ogni kg eccedente i 30kg.
const SHIPPING_RATES = {
  domestico: { brackets: [[1, 9], [2, 11], [5, 14], [10, 18], [20, 25], [30, 33]], perKgOver: 1.1, eta: "24–48 ore" },
  transfrontaliero: { brackets: [[1, 15], [2, 20], [5, 26], [10, 34], [20, 44], [30, 55]], perKgOver: 2.2, eta: "2–4 giorni lavorativi" },
  worldwide: { brackets: [[1, 50], [2, 58], [5, 75], [10, 95], [20, 130], [30, 165]], perKgOver: 5.5, eta: "4–8 giorni lavorativi" },
};

// Margine Touch&Go applicato sopra il costo grezzo del corriere. Applicato
// una sola volta, dentro shippingCost() — ogni preventivo, riepilogo e
// salvataggio a save-purchase.js legge sempre e solo il valore già
// comprensivo di margine, mai il grezzo.
const SHIPPING_MARGIN = 0.2;

// I corrieri espresso reali fatturano sul maggiore tra peso reale e peso
// volumetrico (L×W×H in cm / 5000) — un pacco grande ma leggero occupa
// comunque spazio nel mezzo di trasporto.
function volumetricWeight(dims) {
  if (!dims) return 0;
  const l = parseFloat(dims.length_cm) || 0;
  const w = parseFloat(dims.width_cm) || 0;
  const h = parseFloat(dims.height_cm) || 0;
  if (!l || !w || !h) return 0;
  return (l * w * h) / 5000;
}

function bracketPrice(zone, weightKg) {
  for (const [maxKg, price] of zone.brackets) {
    if (weightKg <= maxKg) return price;
  }
  const [lastMaxKg, lastPrice] = zone.brackets[zone.brackets.length - 1];
  return lastPrice + (weightKg - lastMaxKg) * zone.perKgOver;
}

function shippingCost(weightKg, destinationName, dims) {
  const realWeight = Math.max(0.3, parseFloat(weightKg) || 1);
  const billableWeight = Math.max(realWeight, volumetricWeight(dims));
  const dest = DESTINATIONS.find((d) => d.name === destinationName) || DESTINATIONS[DESTINATIONS.length - 1];
  const zone = SHIPPING_RATES[dest.zone];
  const rawCost = bracketPrice(zone, billableWeight);
  return {
    shipping: parseFloat((rawCost * (1 + SHIPPING_MARGIN)).toFixed(2)),
    eta: zone.eta,
  };
}

// Restituisce le due quotazioni sempre confrontate esplicitamente: prezzo
// pieno e prezzo con abbonamento — mostrate fin dalla primissima spedizione,
// per ogni cliente, senza eccezioni.
function priceQuotes(weightKg, destinationName, dims) {
  const { shipping, eta } = shippingCost(weightKg, destinationName, dims);
  const round = (n) => parseFloat(n.toFixed(2));
  return {
    shipping,
    eta,
    full: round(shipping + FULL_FEE),
    subscribed: round(shipping + SUBSCRIBED_FEE),
    breakeven: round(shipping),
  };
}

// Prezzo effettivo da applicare dato lo stato del cliente (usato per
// compatibilità con il resto del codice che si aspetta un unico totale).
// Se è attivo un codice invito valido e non ancora usato, la fee di
// servizio Touch&Go viene azzerata per questa sola spedizione: il turista
// paga solo il servizio di spedizione (che include comunque il margine
// SHIPPING_MARGIN — non è più a costo vivo per Touch&Go, solo la fee è
// azzerata).
function priceFor(weightKg, destinationName, dims) {
  const q = priceQuotes(weightKg, destinationName, dims);
  const onBreakeven = state.promoValid && !state.promoRedeemedThisOrder;
  const grandTotal = onBreakeven ? q.breakeven : state.isSubscribed ? q.subscribed : q.full;
  return { grandTotal, eta: q.eta, quotes: q };
}

async function classify(messages) {
  const res = await fetch("/.netlify/functions/classify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Errore AI");
  const text = data.content && data.content[0] && data.content[0].text;
  if (!text) throw new Error("Risposta vuota");
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

function classifyImage(base64, mediaType) {
  return classify([
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        {
          type: "text",
          text: `Sei un esperto di classificazione doganale per acquisti turistici in Italia. Analizza l'immagine e rispondi SOLO con JSON valido:\n${CLASSIFY_SCHEMA}`,
        },
      ],
    },
  ]);
}

function classifyText(label) {
  return classify([
    {
      role: "user",
      content: `Sei un esperto di classificazione doganale per acquisti turistici in Italia.\nClassifica: "${label}"\nRispondi SOLO con JSON valido:\n${CLASSIFY_SCHEMA}`,
    },
  ]);
}

// ---------------- App state & rendering ----------------

const state = {
  mode: "turista",
  screen: "cover",
  error: null,
  result: null,
  price: null,
  addresses: [],
  selectedAddressId: null,
  destinationFromProfile: true,
  addAddressReturnTo: "destination",
  pendingInput: null,
  location: null,
  locationPhoto: null,
  pickupPoint: "Catania",
  pickupSource: null,
  isOffline: typeof navigator !== "undefined" && "onLine" in navigator ? !navigator.onLine : false,
  locationReminderDismissed: false,
  bookingCode: null,
  pendingItems: [],
  lastQueuedItem: null,
  shippedGroups: [],
  purchaseHistory: [],
  activePartnerCode: null,
  partnerLoggedCode: null,
  partnerLoginLoading: false,
  partnerLoginError: null,
  partnerStats: null,
  showPartnerQr: false,
  editingItemId: null,
  viewingItemId: null,
  viewingDocsItemId: null,
  checkingItemId: null,
  docsReturnTo: null,
  touristName: null,
  touristEmail: null,
  guestDestinationCountry: null,
  identifyPrompt: null,
  identifyReturnTo: null,
  biometricCredentialId: null,
  biometricVerified: false,
  isSubscribed: false,
  priceConfirmedForThisResult: false,
  priceConfirmedAsBreakeven: false,
  idDocument: null,
  signatureDetected: false,
  promoCode: null,
  promoChecked: false,
  promoValid: false,
  promoRedeemedThisOrder: false,
  showPromoInput: false,
  showPartnerDiscountInput: false,
  partnerDiscountCodeInput: "",
  partnerDiscountChecking: false,
  partnerDiscountApplied: false,
  partnerDiscountCode: null,
  partnerDiscountAmount: 0,
  partnerDiscountError: null,
  partnerCreditRedeeming: false,
  partnerCreditRedeemResult: null,
  partnerCreditRedeemError: null,
  partnerDiscountGenerating: false,
  partnerGeneratedDiscountCode: null,
  partnerDiscountGenerateError: null,
  assistantDismissed: {},
};
const app = document.getElementById("app");

function render() {
  app.innerHTML = "";
  app.appendChild(Header());
  if (state.mode === "partner") app.appendChild(PartnerScreen());
  else if (state.screen === "biometric-lock") app.appendChild(BiometricLockScreen());
  else if (state.screen === "cover") app.appendChild(CoverScreen());
  else if (state.screen === "identify") app.appendChild(IdentifyScreen());
  else if (state.screen === "home") app.appendChild(HomeScreen());
  else if (state.screen === "destination") app.appendChild(DestinationScreen());
  else if (state.screen === "add-address") app.appendChild(AddAddressScreen());
  else if (state.screen === "choose-address") app.appendChild(ChooseAddressScreen());
  else if (state.screen === "analyzing") app.appendChild(AnalyzingScreen());
  else if (state.screen === "result") app.appendChild(ResultScreen());
  else if (state.screen === "queued") app.appendChild(QueuedScreen());
  else if (state.screen === "conclude") app.appendChild(ConcludeScreen());
  else if (state.screen === "shipped") app.appendChild(ShippedScreen());
  else if (state.screen === "history") app.appendChild(HistoryScreen());
  else if (state.screen === "edit-item-address") app.appendChild(EditItemAddressScreen());
  else if (state.screen === "view-item-photo") app.appendChild(ViewItemPhotoScreen());
  else if (state.screen === "dashboard") app.appendChild(DashboardScreen());
  else if (state.screen === "documents") app.appendChild(DocumentsScreen());
  else if (state.screen === "package-check") app.appendChild(PackageCheckScreen());
  if (state.screen === "home") app.appendChild(Footer());
  if (state.mode !== "partner" && state.screen === "result") {
    requestAnimationFrame(() => animateResult(state.result, state.price));
  }
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function Header() {
  const wrap = el("div");
  const header = el("div", "header");
  header.innerHTML = `
    <div class="brand"><span class="brand-name">Touch<b>&amp;</b>Go</span></div>
    <div class="header-actions">
      <a class="header-site-link" href="/site/index.html" target="_blank" rel="noopener">🌐 Sito</a>
      <button class="header-reset" id="header-reset" title="Resetta profilo e ricomincia">⟲ Reset</button>
    </div>`;
  wrap.appendChild(header);
  header.querySelector("#header-reset").addEventListener("click", resetEverything);

  if (state.isOffline) {
    wrap.appendChild(el("div", "offline-banner", "📡 Sei offline — la classificazione AI e le foto delle città non sono disponibili finché non torni online. I tuoi acquisti, indirizzi e dashboard restano comunque consultabili."));
  }

  const toggle = el("div", "mode-toggle");
  toggle.innerHTML = `
    <button class="mode-btn ${state.mode === "turista" ? "on" : ""}" data-mode="turista">Turista</button>
    <button class="mode-btn ${state.mode === "partner" ? "on" : ""}" data-mode="partner">Partner</button>`;
  toggle.querySelectorAll("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      state.mode = b.dataset.mode;
      render();
    })
  );
  wrap.appendChild(toggle);
  return wrap;
}

function PartnerScreen() {
  const wrap = el("div", "section");

  wrap.appendChild(el("div", "tg-lbl", "Per negozi, hotel e tour operator"));
  const intro = el("div", "info-card");
  intro.innerHTML = `<div class="info-line">Offri Touch&amp;Go ai tuoi clienti: spedizione doganale con codice AI, esenzione IVA export automatica e tracciamento incluso — con un guadagno su ogni spedizione venduta tramite il tuo codice.</div>
    <div class="info-line">Piani, canoni e dettagli sulla commissione sono nella sezione partner del sito.</div>`;
  wrap.appendChild(intro);

  const cta = el("button", "btn-primary", "Scopri i piani partner →");
  cta.addEventListener("click", () => {
    window.open("/site/index.html#partner", "_blank", "noopener");
  });
  wrap.appendChild(cta);

  wrap.appendChild(PartnerLoginAndHistory());

  return wrap;
}

function PartnerLoginAndHistory() {
  const wrap = el("div");
  wrap.appendChild(el("div", "tg-lbl", "Area riservata partner"));

  if (!state.partnerLoggedCode) {
    const intro = el(
      "div",
      "identify-intro",
      "Inserisci il tuo codice partner per vedere solo le vendite generate tramite il tuo negozio e le commissioni maturate."
    );
    wrap.appendChild(intro);

    const field = el("div", "dest-field");
    field.innerHTML = `<div class="dest-lbl">Codice partner</div><input class="dest-input" id="partner-code-input" placeholder="Es. NEGOZIO123" value="${state.activePartnerCode || ""}" />`;
    wrap.appendChild(field);

    if (state.partnerLoginError) {
      wrap.appendChild(el("div", "alert", `⚠️ ${state.partnerLoginError}`));
    }

    const loginBtn = el("button", "btn-secondary", state.partnerLoginLoading ? "Verifico…" : "Accedi");
    loginBtn.disabled = state.partnerLoginLoading;
    loginBtn.addEventListener("click", async () => {
      const code = document.getElementById("partner-code-input").value.trim().toUpperCase();
      if (!code || state.partnerLoginLoading) return;
      state.partnerLoginLoading = true;
      state.partnerLoginError = null;
      render();
      try {
        const res = await fetch("/.netlify/functions/partner-stats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        const data = await res.json();
        if (data.valid) {
          state.partnerLoggedCode = code;
          state.partnerStats = {
            partnerName: data.partnerName || "",
            salesCount: data.salesCount || 0,
            totalSalesValue: data.totalSalesValue || 0,
            totalCommission: data.totalCommission || 0,
            creditBalance: data.creditBalance || 0,
          };
        } else {
          state.partnerLoginError = "Codice partner non riconosciuto.";
        }
      } catch (e) {
        state.partnerLoginError = "Errore di connessione. Riprova.";
      }
      state.partnerLoginLoading = false;
      render();
    });
    wrap.appendChild(loginBtn);
    return wrap;
  }

  const stats = state.partnerStats || { partnerName: "", salesCount: 0, totalSalesValue: 0, totalCommission: 0, creditBalance: 0 };
  const summary = el("div", "info-card");
  summary.innerHTML = `
    <div class="info-row"><span>Codice partner</span><b>${state.partnerLoggedCode}</b></div>
    ${stats.partnerName ? `<div class="info-row"><span>Nome registrato</span><b>${stats.partnerName}</b></div>` : ""}
    <div class="info-row"><span>Vendite registrate</span><b>${stats.salesCount}</b></div>
    <div class="info-row"><span>Valore generato tramite il tuo negozio</span><b>€${stats.totalSalesValue.toFixed(2)}</b></div>
    <div class="info-row"><span>Commissioni maturate (10%)</span><b>€${stats.totalCommission.toFixed(2)}</b></div>
    <div class="info-row total"><span>Credito disponibile</span><b>€${stats.creditBalance.toFixed(2)}</b></div>`;
  wrap.appendChild(summary);

  wrap.appendChild(PartnerCreditSection(stats));

  wrap.appendChild(PartnerQRSection(state.partnerLoggedCode));

  const logoutBtn = el("button", "reset-link", "Esci dall'area partner");
  logoutBtn.addEventListener("click", () => {
    state.partnerLoggedCode = null;
    state.partnerStats = null;
    state.partnerLoginError = null;
    state.showPartnerQr = false;
    state.partnerCreditRedeemResult = null;
    state.partnerCreditRedeemError = null;
    state.partnerGeneratedDiscountCode = null;
    state.partnerDiscountGenerateError = null;
    render();
  });
  wrap.appendChild(logoutBtn);

  return wrap;
}

// Ricarica le statistiche (incluso creditBalance) del partner loggato —
// usata dopo un riscatto credito, così il saldo mostrato resta coerente
// con quanto appena scalato lato server.
async function refreshPartnerStats() {
  if (!state.partnerLoggedCode) return;
  try {
    const res = await fetch("/.netlify/functions/partner-stats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: state.partnerLoggedCode }),
    });
    const data = await res.json();
    if (data.valid) {
      state.partnerStats = {
        partnerName: data.partnerName || "",
        salesCount: data.salesCount || 0,
        totalSalesValue: data.totalSalesValue || 0,
        totalCommission: data.totalCommission || 0,
        creditBalance: data.creditBalance || 0,
      };
    }
  } catch (e) {
    // Aggiornamento saldo non riuscito — resta il valore già mostrato,
    // il riscatto stesso ha comunque avuto successo lato server.
  }
}

// Riscatto del credito partner: pagare il canone (fino a coprirlo) o
// generare un codice sconto monouso da dare a un cliente.
function PartnerCreditSection(stats) {
  const wrap = el("div");

  if (stats.creditBalance > 0) {
    const redeemBtn = el("button", "btn-secondary", state.partnerCreditRedeeming ? "Applico il credito…" : "Usa credito per il canone");
    redeemBtn.disabled = state.partnerCreditRedeeming;
    redeemBtn.addEventListener("click", async () => {
      state.partnerCreditRedeeming = true;
      state.partnerCreditRedeemError = null;
      state.partnerCreditRedeemResult = null;
      render();
      try {
        const res = await fetch("/.netlify/functions/crm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "redeem-credit-for-invoice", code: state.partnerLoggedCode }),
        });
        const data = await res.json();
        if (res.ok && data.invoice) {
          state.partnerCreditRedeemResult = data.invoice;
          await refreshPartnerStats();
        } else {
          state.partnerCreditRedeemError = data.error || "Riscatto non riuscito. Riprova.";
        }
      } catch (e) {
        state.partnerCreditRedeemError = "Errore di connessione. Riprova.";
      }
      state.partnerCreditRedeeming = false;
      render();
    });
    wrap.appendChild(redeemBtn);
  }

  if (state.partnerCreditRedeemResult) {
    const r = state.partnerCreditRedeemResult;
    const note = el("div", "promo-active-note");
    note.textContent =
      r.creditApplied > 0
        ? `✓ Fattura ${r.id}: -€${r.creditApplied.toFixed(2)} di credito applicato — importo residuo da pagare €${r.amount.toFixed(2)}`
        : `Fattura ${r.id} generata — nessun credito applicato (importo €${r.amount.toFixed(2)})`;
    wrap.appendChild(note);
  }
  if (state.partnerCreditRedeemError) {
    wrap.appendChild(el("div", "alert", `⚠️ ${state.partnerCreditRedeemError}`));
  }

  const genBtn = el("button", "btn-secondary", state.partnerDiscountGenerating ? "Genero il codice…" : "Genera codice sconto per un cliente");
  genBtn.disabled = state.partnerDiscountGenerating;
  genBtn.addEventListener("click", async () => {
    state.partnerDiscountGenerating = true;
    state.partnerDiscountGenerateError = null;
    render();
    try {
      const res = await fetch("/.netlify/functions/crm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate-partner-discount-code", code: state.partnerLoggedCode }),
      });
      const data = await res.json();
      if (res.ok && data.discountCode) {
        state.partnerGeneratedDiscountCode = data.discountCode;
      } else {
        state.partnerDiscountGenerateError = data.error || "Generazione codice non riuscita. Riprova.";
      }
    } catch (e) {
      state.partnerDiscountGenerateError = "Errore di connessione. Riprova.";
    }
    state.partnerDiscountGenerating = false;
    render();
  });
  wrap.appendChild(genBtn);

  if (state.partnerGeneratedDiscountCode) {
    wrap.appendChild(
      el(
        "div",
        "promo-active-note",
        `✓ Codice sconto generato: ${state.partnerGeneratedDiscountCode} — comunicalo al cliente, vale il 10% sulla fee di servizio, una sola volta`
      )
    );
  }
  if (state.partnerDiscountGenerateError) {
    wrap.appendChild(el("div", "alert", `⚠️ ${state.partnerDiscountGenerateError}`));
  }

  return wrap;
}

// QR che incorpora l'URL dell'app con ?partner=CODICE già impostato —
// chi lo scansiona apre l'app con capturePartnerCode() che salva il
// codice partner in automatico (vedi capturePartnerCode(), non toccata).
function PartnerQRSection(code) {
  const wrap = el("div");

  if (!state.showPartnerQr) {
    const qrBtn = el("button", "btn-secondary", "Genera QR per il tuo negozio");
    qrBtn.addEventListener("click", () => {
      state.showPartnerQr = true;
      render();
    });
    wrap.appendChild(qrBtn);
    return wrap;
  }

  const partnerUrl = `${window.location.origin}/?partner=${encodeURIComponent(code)}`;
  const qrData = encodeURIComponent(partnerUrl);
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=8&color=15-15-15&bgcolor=250-248-244&data=${qrData}`;

  const card = el("div", "qr-card");
  card.innerHTML = `
    <img src="${qrUrl}" alt="QR del tuo negozio" class="qr-img" />
    <div class="qr-code">${code}</div>
    <div class="qr-note">Chi lo scansiona apre Touch&amp;Go con il tuo codice partner già applicato — ogni spedizione generata da questo QR viene attribuita a te.</div>`;
  wrap.appendChild(card);

  const downloadBtn = el("button", "btn-secondary", "⬇️ Scarica il QR");
  downloadBtn.addEventListener("click", () => downloadQR(qrUrl, `touchandgo-partner-qr-${code}.png`));
  wrap.appendChild(downloadBtn);

  return wrap;
}

async function downloadQR(qrUrl, filename) {
  try {
    const res = await fetch(qrUrl);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  } catch (e) {
    window.open(qrUrl, "_blank", "noopener");
  }
}

function getGPSCoords() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    const timer = setTimeout(() => resolve(null), 6000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
      { timeout: 5500, maximumAge: 300000 }
    );
  });
}

async function reverseGeocode(lat, lon) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=it`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    const data = await res.json();
    const city = data.city || data.locality || data.principalSubdivision;
    if (!city) return null;
    return { city, country: data.countryName };
  } catch (e) {
    clearTimeout(timeout);
    return null;
  }
}

async function locateByGPS() {
  const coords = await getGPSCoords();
  if (!coords) return null;
  return reverseGeocode(coords.lat, coords.lon);
}

async function locateTourist() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch("https://ipapi.co/json/", { signal: controller.signal });
    clearTimeout(timeout);
    const data = await res.json();
    if (!data.city) return null;
    return { city: data.city, country: data.country_name };
  } catch (e) {
    clearTimeout(timeout);
    return null;
  }
}

async function cityPhoto(city) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(city)}`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    const data = await res.json();
    return (data.originalimage && data.originalimage.source) || (data.thumbnail && data.thumbnail.source) || null;
  } catch (e) {
    clearTimeout(timeout);
    return null;
  }
}

async function loadLocation() {
  let place = await locateByGPS();
  let source = "gps";
  if (!place) {
    place = await locateTourist();
    source = "ip";
  }
  if (!place) return;
  const photo = await cityPhoto(place.city);
  state.location = place;
  state.locationPhoto = photo;
  state.pickupPoint = place.city;
  state.pickupSource = source;
  if ((state.screen === "cover" || state.screen === "home") && state.mode === "turista") render();
}

function TrustRow() {
  const row = el("div", "trust-row");
  row.innerHTML = `
    <div class="trust-item"><span class="trust-ic">🛡️</span>Copertura inclusa</div>
    <div class="trust-item"><span class="trust-ic">📍</span>Tracciato via WhatsApp</div>
    <div class="trust-item"><span class="trust-ic">✓</span>Dogana automatica</div>`;
  return row;
}

const ASSISTANT_TIPS = {
  home: "Fotografa l'oggetto che hai comprato, o descrivilo se preferisci — ci penso io a classificarlo.",
  destination: "Conferma da dove ritirare l'acquisto e dove deve arrivare — poi calcolo il prezzo.",
  analyzing: "Un attimo, sto analizzando l'oggetto e calcolando peso e categoria doganale.",
  options: "Touch&Go si occupa di tutta la spedizione — corriere, dogana e assicurazione inclusi in base a peso, valore e destinazione.",
  result: "Scegli tra prezzo pieno o abbonamento, poi genera il codice QR per lasciare l'oggetto in negozio.",
  queued: "Mostra questo QR in negozio quando lasci l'acquisto — il ritiro parte a fine soggiorno.",
  history: "Qui trovi tutti i tuoi acquisti passati e il loro stato di consegna.",
};

function AssistantAvatar(screenKey) {
  if (state.assistantDismissed && state.assistantDismissed[screenKey]) return el("div");
  const tip = ASSISTANT_TIPS[screenKey];
  if (!tip) return el("div");

  const wrap = el("div", "assistant-tip");
  wrap.innerHTML = `
    <div class="assistant-avatar">T&amp;G</div>
    <div class="assistant-text">${tip}</div>
    <button class="assistant-dismiss" aria-label="Chiudi suggerimento">✕</button>
  `;
  wrap.querySelector(".assistant-dismiss").addEventListener("click", (e) => {
    e.stopPropagation();
    if (!state.assistantDismissed) state.assistantDismissed = {};
    state.assistantDismissed[screenKey] = true;
    render();
  });
  return wrap;
}

function CoverScreen() {
  const wrap = el("div", "cover-screen");
  if (state.locationPhoto) {
    wrap.classList.add("has-photo");
    wrap.style.backgroundImage = `linear-gradient(180deg, rgba(15,15,15,.15) 0%, rgba(15,15,15,.35) 55%, rgba(15,15,15,.85) 100%), url('${state.locationPhoto}')`;
  } else {
    wrap.classList.add("no-photo");
  }
  wrap.innerHTML = `
    <div class="cover-caption">📍 Punto di ritiro rilevato<br><span>${state.pickupPoint}</span></div>
    <div class="cover-tap">Tocca per iniziare →</div>`;
  wrap.addEventListener("click", () => {
    state.screen = "home";
    render();
  });
  return wrap;
}

function HomeScreen() {
  const wrap = el("div");
  wrap.appendChild(AssistantAvatar("home"));
  wrap.appendChild(TrustRow());

  if (state.pickupSource !== "gps" && !state.locationReminderDismissed) {
    const loc = el("div", "location-reminder");
    loc.innerHTML = `
      <div class="loc-avatar">📍</div>
      <div class="loc-text"><b>Attiva la posizione dal telefono</b><br/>Così rileviamo il punto di ritiro con precisione (ora usiamo una stima meno precisa dalla rete).</div>
      <button class="loc-dismiss" aria-label="Chiudi">✕</button>`;
    loc.querySelector(".loc-dismiss").addEventListener("click", () => {
      state.locationReminderDismissed = true;
      render();
    });
    loc.querySelector(".loc-avatar").addEventListener("click", () => loadLocation());
    wrap.appendChild(loc);
  }

  if (state.pendingItems.length > 0) {
    const banner = el("div", "pending-banner");
    banner.innerHTML = `<div class="pending-count">🧳 ${state.pendingItems.length} acquist${state.pendingItems.length === 1 ? "o" : "i"} in sospeso presso i negozi</div>
      <div class="pending-sub">Il ritiro parte solo quando concludi il soggiorno</div>`;
    const concludeBtn = el("button", "btn-secondary", "Concludi il soggiorno e invia il ritiro →");
    concludeBtn.addEventListener("click", () => {
      state.screen = "conclude";
      render();
    });
    banner.appendChild(concludeBtn);
    wrap.appendChild(banner);
  }

  if (state.error) {
    wrap.appendChild(el("div", "alert", `⚠️ ${state.error}`));
  }

  const section = el("div", "section");
  if (state.touristName) {
    section.appendChild(el("div", "greeting", `Ciao, ${state.touristName}`));
  }
  section.appendChild(el("div", "step-lbl", "Passo 1 · Fotografa l'acquisto"));
  const captureCard = el("div", "capture-card");
  captureCard.innerHTML = `
    <div class="capture-icon">📷</div>
    <h3>Fotografa l'oggetto</h3>
    <p>Tocca per aprire la fotocamera</p>`;
  const cameraInput = el("input");
  cameraInput.type = "file";
  cameraInput.accept = "image/*";
  cameraInput.capture = "environment";
  cameraInput.style.display = "none";
  cameraInput.addEventListener("change", (e) => handleFile(e.target.files[0]));
  captureCard.appendChild(cameraInput);
  captureCard.addEventListener("click", () => cameraInput.click());
  section.appendChild(captureCard);

  const galleryCard = el("div", "gallery-card");
  galleryCard.innerHTML = `<span>Scegli dalla galleria</span>`;
  const galleryInput = el("input");
  galleryInput.type = "file";
  galleryInput.accept = "image/*";
  galleryInput.style.display = "none";
  galleryInput.addEventListener("change", (e) => handleFile(e.target.files[0]));
  galleryCard.appendChild(galleryInput);
  galleryCard.addEventListener("click", () => galleryInput.click());
  section.appendChild(galleryCard);

  const describeBox = el("div", "describe-box");
  const describeLbl = el("div", "tg-lbl", "Non puoi fotografarlo? Descrivilo");
  const input = el("input");
  input.type = "text";
  input.placeholder = "Es. bottiglia di vino, borsa in pelle…";
  const goBtn = el("button", null, "→");
  goBtn.addEventListener("click", () => {
    if (input.value.trim()) handleDescribe(input.value.trim());
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) handleDescribe(input.value.trim());
  });
  describeBox.appendChild(input);
  describeBox.appendChild(goBtn);
  section.appendChild(describeLbl);
  section.appendChild(describeBox);

  const foot = el("div", "home-foot", "Peso e dimensioni stimati dalla foto · prezzo calcolato sulla destinazione");
  section.appendChild(foot);

  if (!state.promoValid) {
    if (!state.showPromoInput) {
      const promoLink = el("div", "promo-link", "Hai un codice invito?");
      promoLink.addEventListener("click", () => {
        state.showPromoInput = true;
        render();
      });
      section.appendChild(promoLink);
    } else {
      const promoBox = el("div", "describe-box");
      const promoInput = el("input");
      promoInput.type = "text";
      promoInput.placeholder = "Codice invito";
      promoInput.value = state.promoCode || "";
      const promoGo = el("button", null, "→");
      promoGo.addEventListener("click", () => {
        if (promoInput.value.trim()) checkPromoCode(promoInput.value.trim());
      });
      promoInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && promoInput.value.trim()) checkPromoCode(promoInput.value.trim());
      });
      promoBox.appendChild(promoInput);
      promoBox.appendChild(promoGo);
      section.appendChild(promoBox);
      if (state.promoChecked && !state.promoValid) {
        section.appendChild(el("div", "promo-invalid", "Codice non valido o già utilizzato."));
      }
    }
  } else {
    section.appendChild(el("div", "promo-active-note", `✓ Codice invito ${state.promoCode} attivo — sconto applicato alla prossima spedizione`));
  }

  wrap.appendChild(section);

  return wrap;
}

function DestinationScreen() {
  const wrap = el("div", "section");
  wrap.appendChild(AssistantAvatar("destination"));
  const back = el("div", "back", "← Rifai la foto");
  back.addEventListener("click", () => {
    state.screen = "home";
    state.pendingInput = null;
    render();
  });
  wrap.appendChild(back);

  if (state.error) {
    wrap.appendChild(el("div", "alert", `⚠️ ${state.error}`));
  }

  wrap.appendChild(el("div", "step-lbl", "Passo 2 · Conferma ritiro e destinazione"));

  if (state.pendingInput && state.pendingInput.type === "image") {
    const preview = el("img", "capture-preview");
    preview.src = state.pendingInput.dataUrl;
    wrap.appendChild(preview);
  } else if (state.pendingInput && state.pendingInput.type === "text") {
    wrap.appendChild(el("div", "pending-desc", `"${state.pendingInput.label}"`));
  }

  wrap.appendChild(PickupField());
  wrap.appendChild(DestinationField());

  const note = el(
    "div",
    "home-foot",
    "Il prezzo verrà calcolato su peso e dimensioni stimati dalla foto, in base a questa destinazione."
  );
  wrap.appendChild(note);

  const goBtn = el("button", "btn-primary", "Analizza e calcola il prezzo →");
  goBtn.addEventListener("click", () => {
    if (!state.pendingInput) return;
    if (state.isOffline) {
      state.error = "Sei offline: la classificazione AI richiede una connessione. Riprova quando torni online.";
      render();
      return;
    }
    const promise =
      state.pendingInput.type === "image"
        ? classifyImage(state.pendingInput.base64, state.pendingInput.mediaType)
        : classifyText(state.pendingInput.label);
    runClassification(promise);
  });
  wrap.appendChild(goBtn);

  return wrap;
}

function PickupField() {
  const wrap = el("div");
  const field = el("div", "dest-field");
  const label =
    state.pickupSource === "gps"
      ? "Punto di ritiro (GPS)"
      : state.pickupSource === "ip"
      ? "Punto di ritiro (rete)"
      : "Punto di ritiro";
  field.innerHTML = `
    <div class="dest-lbl">${label}</div>
    <input class="dest-input" id="pickup-input" value="${state.pickupPoint}" />`;
  field.querySelector("#pickup-input").addEventListener("input", (e) => {
    state.pickupPoint = e.target.value;
    state.pickupSource = null;
  });
  wrap.appendChild(field);
  wrap.appendChild(
    el(
      "div",
      "pickup-note",
      "Modificabile se il ritiro avviene altrove (es. un servizio di imballaggio esterno), non solo presso il punto vendita."
    )
  );
  return wrap;
}

function InfoSection() {
  const wrap = el("div", "section info-section");

  wrap.appendChild(el("div", "tg-lbl", "Come funziona il prezzo"));
  const priceInfo = el("div", "info-card");
  priceInfo.innerHTML = `
    <div class="info-row"><span>Fee di servizio Touch&amp;Go</span><b>€39</b></div>
    <div class="info-row"><span>Costo servizio di spedizione (varia per peso/destinazione)</span><b>calcolato all'istante</b></div>
    <div class="info-row"><span>Nessun costo nascosto: vedi il totale prima di confermare</span></div>
    <div class="info-line" style="margin-top:8px">🎁 <b>Prima spedizione senza fee di servizio</b> — paghi solo il servizio di spedizione, a tariffa piena. Un modo per provare il servizio prima di scegliere se abbonarti.</div>`;
  wrap.appendChild(priceInfo);

  wrap.appendChild(el("div", "tg-lbl", "Copertura e dogana"));
  const coverage = el("div", "info-card");
  coverage.innerHTML = `
    <div class="info-line">🛡️ Copertura assicurativa standard inclusa in ogni spedizione; copertura estesa disponibile su richiesta per articoli di alto valore.</div>
    <div class="info-line">📄 Documentazione doganale (MRN/DAE) ed esenzione IVA export (art. 8 DPR 633/72) generate automaticamente — nessuna pratica in aeroporto.</div>
    <div class="info-line">📍 Tracciamento in tempo reale via WhatsApp, disponibile in 180+ Paesi.</div>`;
  wrap.appendChild(coverage);

  return wrap;
}

function AnalyzingScreen() {
  const wrap = el("div", "analyzing");
  wrap.appendChild(AssistantAvatar("analyzing"));
  const spinnerBlock = el("div");
  spinnerBlock.innerHTML = `<div class="spinner"></div><p>Analisi in corso…</p>`;
  wrap.appendChild(spinnerBlock);
  return wrap;
}

function ResultScreen() {
  const r = state.result;
  const p = state.price;
  const q = p.quotes || priceQuotes(r.weight_kg, currentDestinationName(), r);
  const wrap = el("div");
  wrap.appendChild(AssistantAvatar("result"));
  wrap.appendChild(AssistantAvatar("options"));

  const topbar = el("div", "topbar");
  const back = el("button", "back", "←");
  back.addEventListener("click", () => {
    state.screen = "home";
    state.pendingInput = null;
    render();
  });
  topbar.appendChild(back);
  topbar.appendChild(el("h2", null, "Passo 3 · Risultato"));
  wrap.appendChild(topbar);

  const card = el("div", "result-card");
  const top = el("div", "result-top");
  top.innerHTML = `
    <span class="confidence">✓ Identificato · confidenza ${r.confidence || "alta"}</span>
    <div class="result-title" id="res-title"></div>
    <div class="result-sub" id="res-sub"></div>`;
  card.appendChild(top);

  const grid = el("div", "result-grid");
  const pkg = packagedDimensions(r);
  const objDims = r.length_cm && r.width_cm && r.height_cm ? formatDims(r.length_cm, r.width_cm, r.height_cm) : "—";
  grid.innerHTML = `
    <div><div class="result-lbl">Peso stimato</div><div class="result-val">${r.weight_kg ?? "—"} kg</div></div>
    <div><div class="result-lbl">Dimensioni oggetto</div><div class="result-val">${objDims}</div></div>
    <div><div class="result-lbl">Dimensioni pacco (con imballo)</div><div class="result-val">${pkg ? formatDims(pkg.l, pkg.w, pkg.h) : "—"}</div></div>
    <div><div class="result-lbl">Fragilità</div><div class="result-val ${r.fragile ? "warn" : ""}">${r.fragile ? "⚠️ Fragile" : "Non fragile"}</div></div>
    <div><div class="result-lbl">Ritiro da</div><div class="result-val">${state.pickupPoint}</div></div>
    <div><div class="result-lbl">Destinazione</div><div class="result-val">${
      getSelectedAddress() ? formatAddress(getSelectedAddress()) : state.guestDestinationCountry || "—"
    }</div></div>`;
  card.appendChild(grid);

  const hs = el("div", "hs-block");
  hs.innerHTML = `
    <div class="hs-left"><div class="hs-lbl">Codice doganale HS</div><div class="hs-code" id="res-hscode"></div></div>
    <div class="hs-desc" id="res-desc"></div>`;
  card.appendChild(hs);
  wrap.appendChild(card);

  if (r.shipping_note) {
    const tip = el("div", "tip", `💡 ${r.shipping_note}`);
    wrap.appendChild(tip);
  }

  if (r.value_eur > 500 || r.confidence === "bassa") {
    const secure = el(
      "div",
      "secure-note",
      `🛡️ Valore dichiarato elevato: copertura assicurativa estesa consigliata — richiedibile senza costi aggiuntivi prima del ritiro.`
    );
    wrap.appendChild(secure);
  }

  let priceCard;
  const onBreakeven = state.promoValid && !state.promoRedeemedThisOrder;
  const isFirstEverShipment = state.purchaseHistory.length === 0;
  const firstTimeFree = !onBreakeven && !state.isSubscribed && isFirstEverShipment;

  if (onBreakeven && !state.priceConfirmedForThisResult) {
    const promo = el("div", "promo-card-inline");
    promo.innerHTML = `
      <div class="promo-badge">Una tantum · invito ${state.promoCode}</div>
      <div class="promo-headline-inline">La tua prima spedizione,<br><em>al prezzo che costa a noi.</em></div>
      <div class="promo-price-row">
        <span class="promo-price-new">€${q.breakeven.toFixed(2)}</span>
        <span class="promo-price-old">€${q.full.toFixed(2)}</span>
      </div>
      <div class="info-row waived"><span>Fee di servizio Touch&amp;Go</span><b>€0</b></div>
      <div class="info-row"><span>Servizio di spedizione internazionale</span><b>€${q.shipping.toFixed(2)}</b></div>
      <div class="promo-note-inline">Nessuna fee di servizio su questa spedizione — offerta valida una sola volta.</div>`;
    const promoBtn = el("button", "btn-primary", "Attiva l'offerta e continua →");
    promoBtn.addEventListener("click", () => {
      state.price = { grandTotal: q.breakeven, eta: q.eta, quotes: q };
      state.priceConfirmedForThisResult = true;
      state.priceConfirmedAsBreakeven = true;
      render();
    });
    promo.appendChild(promoBtn);
    wrap.appendChild(promo);
  } else if (firstTimeFree && !state.priceConfirmedForThisResult) {
    const promo = el("div", "promo-card-inline");
    promo.innerHTML = `
      <div class="promo-badge">Prova gratuita · prima spedizione</div>
      <div class="promo-headline-inline">La tua prima spedizione,<br><em>senza fee di servizio.</em></div>
      <div class="promo-price-row">
        <span class="promo-price-new">€${q.breakeven.toFixed(2)}</span>
        <span class="promo-price-old">€${q.full.toFixed(2)}</span>
      </div>
      <div class="info-row waived"><span>Fee di servizio Touch&amp;Go</span><b>€0</b></div>
      <div class="info-row"><span>Servizio di spedizione internazionale</span><b>€${q.shipping.toFixed(2)}</b></div>
      <div class="promo-note-inline">Paghi solo il servizio di spedizione, a tariffa piena — così puoi provare il servizio prima di scegliere se abbonarti. Vale una sola volta.</div>`;
    const promoBtn = el("button", "btn-primary", "Attiva l'offerta e continua →");
    promoBtn.addEventListener("click", () => {
      state.price = { grandTotal: q.breakeven, eta: q.eta, quotes: q };
      state.priceConfirmedForThisResult = true;
      state.priceConfirmedAsBreakeven = true;
      render();
    });
    promo.appendChild(promoBtn);
    wrap.appendChild(promo);
  } else if (!state.isSubscribed && !state.priceConfirmedForThisResult) {
    const dual = el("div", "price-dual");
    dual.innerHTML = `<div class="tg-lbl" style="margin-bottom:10px">Scegli come pagare — confronto sempre visibile, per ogni spedizione</div>`;
    const optFull = el("div", "price-option");
    optFull.innerHTML = `
      <div class="price-option-lbl">Prezzo pieno</div>
      <div class="price-option-total">€${q.full.toFixed(2)}</div>
      <div class="price-option-note">Fee €${FULL_FEE} + spedizione €${q.shipping.toFixed(2)} — nessun impegno</div>`;
    const fullBtn = el("button", "btn-secondary", "Continua a prezzo pieno");
    fullBtn.addEventListener("click", () => {
      state.price = { grandTotal: q.full, eta: q.eta, quotes: q };
      state.priceConfirmedForThisResult = true;
      render();
    });
    optFull.appendChild(fullBtn);
    dual.appendChild(optFull);

    const optSub = el("div", "price-option highlight");
    optSub.innerHTML = `
      <div class="price-option-lbl">Con abbonamento</div>
      <div class="price-option-total">€${q.subscribed.toFixed(2)}</div>
      <div class="price-option-note">Fee scontata €${SUBSCRIBED_FEE} + spedizione €${q.shipping.toFixed(2)} — su questa e le prossime spedizioni</div>`;
    const subBtn = el("button", "btn-primary", "Abbonati e risparmia →");
    subBtn.addEventListener("click", () => {
      state.isSubscribed = true;
      saveProfile();
      state.price = { grandTotal: q.subscribed, eta: q.eta, quotes: q };
      state.priceConfirmedForThisResult = true;
      render();
    });
    optSub.appendChild(subBtn);
    dual.appendChild(optSub);
    wrap.appendChild(dual);
  } else {
    const fee = state.priceConfirmedAsBreakeven ? 0 : state.isSubscribed ? SUBSCRIBED_FEE : FULL_FEE;
    const discount = state.partnerDiscountApplied ? state.partnerDiscountAmount : 0;
    priceCard = el("div", "price-card");
    priceCard.innerHTML = `
      <div class="tg-lbl" style="margin-bottom:10px">Preventivo trasparente ${state.priceConfirmedAsBreakeven ? "· offerta breakeven" : state.isSubscribed ? "· prezzo abbonato" : ""}</div>
      <div class="info-row"><span>Fee di servizio Touch&amp;Go</span><b>€${fee}</b></div>
      ${discount > 0 ? `<div class="info-row"><span>Sconto codice partner (${state.partnerDiscountCode})</span><b>-€${discount.toFixed(2)}</b></div>` : ""}
      <div class="info-row"><span>Servizio di spedizione internazionale</span><b>€${q.shipping.toFixed(2)}</b></div>
      <div class="info-row total"><span>Totale</span><b id="res-total">€0</b></div>
      <div class="info-line" style="margin-top:8px">Consegna in ${q.eta} · tracciamento incluso · copertura standard inclusa</div>`;
    wrap.appendChild(priceCard);
    if (fee > 0) {
      wrap.appendChild(PartnerDiscountField(fee));
    }
  }

  const actions = el("div", "result-actions");
  const bookBtn = el("button", "btn-primary", "Genera QR code →");
  bookBtn.addEventListener("click", () => {
    state.screen = "choose-address";
    render();
  });
  actions.appendChild(bookBtn);

  const restart = el("button", "btn-secondary", "Classifica un altro oggetto");
  restart.addEventListener("click", () => {
    state.screen = "home";
    state.error = null;
    state.pendingInput = null;
    render();
  });
  actions.appendChild(restart);
  wrap.appendChild(actions);

  return wrap;
}

// Campo "Hai un codice sconto partner?" nella schermata di conferma
// prezzo — stesso pattern del codice invito in HomeScreen (link che apre
// un piccolo input), ma valida/consuma il codice tramite
// partner-discount.js invece di promo.js.
function PartnerDiscountField(fee) {
  const wrap = el("div");

  if (state.partnerDiscountApplied) {
    wrap.appendChild(
      el(
        "div",
        "promo-active-note",
        `✓ Codice sconto partner ${state.partnerDiscountCode} applicato — -€${state.partnerDiscountAmount.toFixed(2)} sulla fee di servizio`
      )
    );
    return wrap;
  }

  if (!state.showPartnerDiscountInput) {
    const link = el("div", "promo-link", "Hai un codice sconto partner?");
    link.addEventListener("click", () => {
      state.showPartnerDiscountInput = true;
      render();
    });
    wrap.appendChild(link);
    return wrap;
  }

  const box = el("div", "describe-box");
  const input = el("input");
  input.type = "text";
  input.placeholder = "Codice sconto partner";
  input.value = state.partnerDiscountCodeInput || "";
  input.addEventListener("input", (e) => {
    state.partnerDiscountCodeInput = e.target.value;
  });
  const go = el("button", null, state.partnerDiscountChecking ? "…" : "→");
  go.disabled = state.partnerDiscountChecking;
  const submit = () => {
    const code = (input.value || "").trim();
    if (!code || state.partnerDiscountChecking) return;
    applyPartnerDiscountCode(code, fee);
  };
  go.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  box.appendChild(input);
  box.appendChild(go);
  wrap.appendChild(box);

  if (state.partnerDiscountError) {
    wrap.appendChild(el("div", "promo-invalid", state.partnerDiscountError));
  }

  return wrap;
}

async function applyPartnerDiscountCode(code, fee) {
  state.partnerDiscountChecking = true;
  state.partnerDiscountError = null;
  render();
  try {
    const res = await fetch("/.netlify/functions/partner-discount", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "redeem", code, fee, touristEmail: state.touristEmail }),
    });
    const data = await res.json();
    if (data.valid) {
      state.partnerDiscountApplied = true;
      state.partnerDiscountCode = code.trim().toUpperCase();
      state.partnerDiscountAmount = data.discountAmount || 0;
      if (state.price) {
        state.price.grandTotal = Math.max(0, Math.round((state.price.grandTotal - state.partnerDiscountAmount) * 100) / 100);
      }
    } else {
      state.partnerDiscountError = data.error || "Codice non valido o già utilizzato.";
    }
  } catch (e) {
    state.partnerDiscountError = "Errore di connessione. Riprova.";
  }
  state.partnerDiscountChecking = false;
  render();
}

// ---------------- Reveal animations ----------------

function typewriter(elNode, text, speed = 18) {
  return new Promise((resolve) => {
    if (!text) return resolve();
    let i = 0;
    elNode.textContent = "";
    elNode.classList.add("caret");
    const tick = () => {
      elNode.textContent = text.slice(0, i + 1);
      i++;
      if (i < text.length) {
        setTimeout(tick, speed);
      } else {
        elNode.classList.remove("caret");
        resolve();
      }
    };
    tick();
  });
}

function countUp(elNode, target, duration = 600) {
  return new Promise((resolve) => {
    const start = performance.now();
    const step = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      const val = (target * progress).toFixed(2);
      elNode.textContent = `€${val}`;
      if (progress < 1) requestAnimationFrame(step);
      else {
        elNode.textContent = `€${target}`;
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
}

async function animateResult(r, p) {
  const title = document.getElementById("res-title");
  const sub = document.getElementById("res-sub");
  const hscode = document.getElementById("res-hscode");
  const desc = document.getElementById("res-desc");
  const total = document.getElementById("res-total");
  if (!title) return;
  await typewriter(title, r.object_it || "Oggetto", 16);
  await typewriter(sub, `${r.object_en || ""} · ${r.category || ""}`, 8);
  await typewriter(hscode, r.hs_code || "——", 60);
  await typewriter(desc, r.hs_description || "", 8);
  if (total) await countUp(total, p.grandTotal, 700);
}

function syncPurchaseToCRM(item) {
  const payload = item.touristEmail ? item : Object.assign({}, item, { touristEmail: state.touristEmail });
  fetch("/.netlify/functions/save-purchase", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Offline or server unavailable — the purchase still lives in the
    // tourist's local history; it just won't appear centrally until
    // the next successful sync attempt.
  });
}

function historyStatusClass(status) {
  if (status === "ritirato") return "done";
  if (status === "ritiro richiesto") return "requested";
  if (status === "in confezionamento") return "packaging";
  return "pending";
}

// Applica sull'oggetto locale i campi eventualmente aggiornati lato CRM
// (es. lo staff ha inviato l'oggetto a confezionamento o ha cambiato il
// punto di ritiro da un altro dispositivo). Ritorna true se qualcosa è
// cambiato, per sapere se salvare/ri-renderizzare.
function applyRemotePurchaseUpdate(local, remote) {
  let changed = false;
  ["status", "pickupPoint", "pickupPointChanged", "pickupPointChangedAt", "previousPickupPoint", "packagingDispatch", "pickupRequestedAt"].forEach((key) => {
    if (remote[key] !== undefined && JSON.stringify(remote[key]) !== JSON.stringify(local[key])) {
      local[key] = remote[key];
      changed = true;
    }
  });
  return changed;
}

// Allinea localmente lo stato degli acquisti già noti con quanto
// aggiornato nel frattempo dallo staff nel CRM (invio a confezionamento,
// cambio punto di ritiro). Chiamata all'avvio e ogni volta che il turista
// apre lo storico acquisti — è così che il banner "punto di ritiro
// aggiornato" compare quando il turista riapre l'app.
async function syncPurchaseUpdatesFromCRM() {
  const ids = state.purchaseHistory.map((it) => it.id).filter(Boolean);
  if (!ids.length) return;
  try {
    const res = await fetch("/.netlify/functions/crm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get-purchases", ids }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const byId = {};
    (data.items || []).forEach((it) => {
      if (it && it.id) byId[it.id] = it;
    });
    let changed = false;
    state.purchaseHistory.forEach((local) => {
      const remote = byId[local.id];
      if (remote && applyRemotePurchaseUpdate(local, remote)) changed = true;
    });
    state.pendingItems.forEach((local) => {
      const remote = byId[local.id];
      if (remote && applyRemotePurchaseUpdate(local, remote)) changed = true;
    });
    if (changed) {
      saveHistory();
      savePending();
      render();
    }
  } catch (e) {
    // Offline o server irraggiungibile — lo storico locale resta quello
    // che era, si riproverà al prossimo avvio/apertura dello storico.
  }
}

function markPickupPointSeen(item) {
  item.pickupPointChanged = false;
  saveHistory();
  savePending();
  fetch("/.netlify/functions/crm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "ack-pickup-point", id: item.id }),
  }).catch(() => {
    // Se la conferma non arriva al server, il banner potrebbe ripresentarsi
    // al prossimo sync — non blocca comunque il turista.
  });
  render();
}

function pickupPointUpdateBanner(item) {
  if (!item.pickupPointChanged) return null;
  const banner = el("div", "pickup-update-banner");
  banner.innerHTML = `📍 Punto di ritiro aggiornato: ${item.pickupPoint}<div class="pickup-update-note">Tocca per confermare di aver visto l'aggiornamento</div>`;
  banner.addEventListener("click", (e) => {
    e.stopPropagation();
    markPickupPointSeen(item);
  });
  return banner;
}

function PackageCheckScreen() {
  const wrap = el("div", "section");
  const item =
    state.pendingItems.find((it) => it.id === state.checkingItemId) ||
    state.purchaseHistory.find((it) => it.id === state.checkingItemId);
  const back = el("div", "back", "← Torna indietro");
  back.addEventListener("click", () => {
    state.screen = state.lastQueuedItem && state.lastQueuedItem.id === state.checkingItemId ? "queued" : "history";
    render();
  });
  wrap.appendChild(back);

  if (!item) {
    wrap.appendChild(el("div", "identify-intro", "Acquisto non trovato."));
    return wrap;
  }

  wrap.appendChild(el("div", "step-lbl", "Verifica imballo"));

  if (item.packageDims) {
    const recCard = el("div", "pack-card");
    recCard.innerHTML = `<div class="pack-label">Dimensioni consigliate</div><div class="pack-dims">${formatDims(item.packageDims.l, item.packageDims.w, item.packageDims.h)}</div>`;
    wrap.appendChild(recCard);
  }

  const resultBox = el("div", "id", "package-check-result");
  resultBox.id = "package-check-result";
  if (item.packageCheck) {
    resultBox.appendChild(renderPackageCheckResult(item.packageCheck));
  }

  const captureCard = el("div", "capture-card");
  captureCard.innerHTML = `<div class="capture-icon">📷</div><h3>Fotografa l'imballo pronto</h3><p>Tocca per aprire la fotocamera</p>`;
  const input = el("input");
  input.type = "file";
  input.accept = "image/*";
  input.capture = "environment";
  input.style.display = "none";
  input.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (state.isOffline) {
      alert("Sei offline: la verifica dell'imballo richiede una connessione.");
      return;
    }
    resultBox.innerHTML = `<div class="pack-checking">🔎 Verifico l'imballo…</div>`;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const photo = await compressImage(reader.result, 500, 0.6);
        const check = await checkPackage(photo, item.packageDims);
        item.packageCheck = check;
        savePending();
        saveHistory();
        resultBox.innerHTML = "";
        resultBox.appendChild(renderPackageCheckResult(check));
      } catch (err) {
        resultBox.innerHTML = `<div class="alert">⚠️ Verifica non riuscita. Riprova.</div>`;
      }
    };
    reader.readAsDataURL(file);
  });
  captureCard.appendChild(input);
  captureCard.addEventListener("click", () => input.click());
  wrap.appendChild(captureCard);
  wrap.appendChild(resultBox);

  return wrap;
}

function renderPackageCheckResult(check) {
  const box = el("div", "pack-check-result " + (check.oversized ? "warn" : "ok"));
  box.innerHTML = `
    <div class="pack-check-title">${check.oversized ? "⚠️ Imballo più grande del necessario" : "✓ Imballo conforme"}</div>
    <div class="pack-check-dims">Dimensioni rilevate: ${formatDims(check.length_cm, check.width_cm, check.height_cm)}</div>
    <div class="pack-check-note">${check.note || ""}</div>`;
  return box;
}

async function checkPackage(photoDataUrl, recommendedDims) {
  const base64 = photoDataUrl.split(",")[1];
  const mediaType = photoDataUrl.split(";")[0].split(":")[1] || "image/jpeg";
  const recText = recommendedDims
    ? `Le dimensioni consigliate per questo imballo erano ${recommendedDims.l} x ${recommendedDims.w} x ${recommendedDims.h} cm.`
    : "Non ci sono dimensioni consigliate di riferimento.";
  return classify([
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        {
          type: "text",
          text: `Sei un esperto di imballaggi per spedizioni. Analizza questa foto di un pacco pronto per la spedizione e stima le sue dimensioni esterne in centimetri. ${recText} Rispondi SOLO con JSON valido: {"length_cm":0,"width_cm":0,"height_cm":0,"oversized":true o false,"note":"breve commento, es. se è più grande del necessario rispetto alle dimensioni consigliate"}`,
        },
      ],
    },
  ]);
}

async function shareQR(item, qrUrl) {
  const text = `Touch&Go — QR di deposito per "${item.objectName}"\nCodice: ${item.id}\nPunto di ritiro: ${item.pickupPoint}\nDestinazione: ${item.addressLabel}`;
  try {
    if (navigator.share) {
      try {
        const res = await fetch(qrUrl);
        const blob = await res.blob();
        const file = new File([blob], `touchandgo-qr-${item.id}.png`, { type: "image/png" });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], text, title: "QR Touch&Go" });
          return;
        }
      } catch (e) {
        // fetch/File sharing not supported — fall through to text share
      }
      await navigator.share({ text, title: "QR Touch&Go", url: qrUrl });
      return;
    }
  } catch (e) {
    // user cancelled or share failed — fall back to clipboard
  }
  try {
    await navigator.clipboard.writeText(`${text}\n${qrUrl}`);
    alert("Link e dettagli del QR copiati — incollali nel messaggio a chi imballa.");
  } catch (e) {
    alert("Copia manualmente questo codice per chi imballa: " + item.id);
  }
}

function generateBookingCode() {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `TG-${rand}`;
}

function QueuedScreen() {
  const item = state.lastQueuedItem;
  const wrap = el("div", "section booked-screen");
  wrap.appendChild(AssistantAvatar("queued"));
  const qrData = encodeURIComponent(`TouchAndGo|${item.id}|negozio:${item.pickupPoint}|dest:${item.addressLabel}`);
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=8&color=15-15-15&bgcolor=250-248-244&data=${qrData}`;
  const intro = el("div");
  intro.innerHTML = `
    <div class="booked-icon">🕓</div>
    <div class="booked-title">QR generato — in sospeso</div>
    <div class="booked-text">Mostra questo QR al negozio per lasciare l'oggetto. <b>Il ritiro non parte ancora:</b> resta in sospeso finché non concludi il soggiorno e invii l'ordine di ritiro per tutti gli acquisti.</div>
    <div class="qr-card">
      <img src="${qrUrl}" alt="QR di deposito" class="qr-img" />
      <div class="qr-code">${item.id}</div>
      <div class="qr-note">Il QR contiene il codice di riferimento — lettera di vettura, fattura e documento sono collegati a questo codice</div>
    </div>`;
  wrap.appendChild(intro);
  const shareBtn = el("button", "btn-secondary", "📤 Invia il QR a chi imballa");
  shareBtn.addEventListener("click", () => shareQR(item, qrUrl));
  wrap.appendChild(shareBtn);
  if (item.packageDims) {
    const pkgCard = el("div", "pack-card");
    pkgCard.innerHTML = `
      <div class="pack-label">📦 Per chi imballa — dimensioni consigliate</div>
      <div class="pack-dims">${formatDims(item.packageDims.l, item.packageDims.w, item.packageDims.h)}</div>
      <div class="pack-warn">Un imballo più grande del necessario aumenta il costo di spedizione: usa una scatola il più vicino possibile a queste misure.</div>`;
    wrap.appendChild(pkgCard);
    const checkBtn = el("button", "btn-secondary", "📷 Fotografa l'imballo per validarlo");
    checkBtn.addEventListener("click", () => {
      state.checkingItemId = item.id;
      state.screen = "package-check";
      render();
    });
    wrap.appendChild(checkBtn);
  }
  wrap.appendChild(el("div", "booked-note", `Hai ora ${state.pendingItems.length} acquist${state.pendingItems.length === 1 ? "o" : "i"} in sospeso.`));
  const docsBtn = el("button", "btn-secondary", "Vedi lettera di vettura e fattura →");
  docsBtn.addEventListener("click", () => {
    state.viewingDocsItemId = item.id;
    state.screen = "documents";
    render();
  });
  wrap.appendChild(docsBtn);
  const backBtn = el("button", "btn-primary", "Torna alla home");
  backBtn.addEventListener("click", () => {
    state.screen = "home";
    state.pendingInput = null;
    render();
  });
  wrap.appendChild(backBtn);
  return wrap;
}

function DocumentsScreen() {
  const wrap = el("div", "section");
  const item =
    state.pendingItems.find((it) => it.id === state.viewingDocsItemId) ||
    state.purchaseHistory.find((it) => it.id === state.viewingDocsItemId);
  const back = el("div", "back", "← Torna indietro");
  back.addEventListener("click", () => {
    state.screen = state.docsReturnTo || "home";
    render();
  });
  wrap.appendChild(back);

  if (!item) {
    wrap.appendChild(el("div", "identify-intro", "Documenti non trovati."));
    return wrap;
  }

  const addr = state.addresses.find((a) => a.id === item.addressId);
  const dateStr = new Date(item.date).toLocaleDateString("it-IT", { day: "2-digit", month: "long", year: "numeric" });

  wrap.appendChild(el("div", "step-lbl", "Lettera di vettura"));
  const waybill = el("div", "doc-card");
  waybill.innerHTML = `
    <div class="doc-row"><span>Riferimento</span><b>${item.id}</b></div>
    <div class="doc-row"><span>Mittente</span><b>${item.touristName || "—"}</b></div>
    <div class="doc-row"><span>Punto di ritiro</span><b>${item.pickupPoint}</b></div>
    <div class="doc-row"><span>Destinatario</span><b>${item.touristName || "—"}</b></div>
    <div class="doc-row"><span>Indirizzo di consegna</span><b>${item.addressLabel}</b></div>
    <div class="doc-row"><span>Contenuto</span><b>${item.objectName}</b></div>
    <div class="doc-row"><span>Codice doganale HS</span><b>${item.hsCode}</b></div>
    <div class="doc-row"><span>Peso</span><b>${item.weightKg} kg</b></div>
    <div class="doc-row"><span>Dimensioni pacco</span><b>${item.packageDims ? formatDims(item.packageDims.l, item.packageDims.w, item.packageDims.h) : "—"}</b></div>
    <div class="doc-row"><span>Data emissione</span><b>${dateStr}</b></div>`;
  wrap.appendChild(waybill);

  wrap.appendChild(el("div", "tg-lbl", "Fattura proforma"));
  const invoice = el("div", "doc-card");
  invoice.innerHTML = `
    <div class="doc-row"><span>Numero fattura</span><b>PF-${item.id}</b></div>
    <div class="doc-row"><span>Venditore</span><b>Touch&amp;Go — spedizione turistica</b></div>
    <div class="doc-row"><span>Acquirente</span><b>${item.touristName || "—"}</b></div>
    <div class="doc-row"><span>Descrizione merce</span><b>${item.objectName}</b></div>
    <div class="doc-row"><span>Valore dichiarato</span><b>€${(item.itemValue || 0).toFixed(2)}</b></div>
    <div class="doc-row"><span>Esenzione IVA</span><b>Art. 8 DPR 633/72</b></div>
    <div class="doc-row"><span>Costo spedizione</span><b>€${item.price}</b></div>`;
  wrap.appendChild(invoice);

  const sigBlock = el("div", "sig-block");
  if (item.hasSignedInvoice) {
    sigBlock.innerHTML = `<div class="tg-lbl">Firma</div><div class="identify-intro">✓ Firma rilevata sul documento di riconoscimento caricato in fase di registrazione da ${item.touristName || "il turista"} — usata per firmare digitalmente questa fattura.</div>`;
  } else {
    sigBlock.innerHTML = `<div class="tg-lbl">Firma</div><div class="identify-intro">Nessuna firma rilevata sul documento caricato in fase di registrazione. La fattura non risulta firmata digitalmente.</div>`;
  }
  wrap.appendChild(sigBlock);

  wrap.appendChild(el("div", "tg-lbl", "Documento di riconoscimento"));
  if (item.hasIdOnFile) {
    wrap.appendChild(el("div", "identify-intro", "✓ Copia del documento associata a questo mittente, conservata sul dispositivo. Non riprodotta qui per riservatezza — disponibile al corriere tramite il codice di riferimento del QR."));
  } else {
    wrap.appendChild(el("div", "identify-intro", "Nessun documento di riconoscimento associato a questo profilo."));
  }

  return wrap;
}

function ConcludeScreen() {
  const wrap = el("div", "section");
  const back = el("div", "back", "← Torna alla home");
  back.addEventListener("click", () => {
    state.screen = "home";
    render();
  });
  wrap.appendChild(back);

  wrap.appendChild(el("div", "step-lbl", "Concludi il soggiorno"));
  wrap.appendChild(
    el(
      "div",
      "identify-intro",
      "Questi sono gli acquisti raccolti nei negozi durante il soggiorno. Confermando, invii un unico ordine di ritiro consolidato per ciascuna destinazione."
    )
  );

  const list = el("div", "queue-list");
  state.pendingItems.forEach((it) => {
    const row = el("div", "queue-item clickable");
    row.innerHTML = `<div class="queue-item-name">${it.objectName}</div>
      <div class="queue-item-meta">Negozio: ${it.pickupPoint} · HS ${it.hsCode}</div>
      <div class="queue-item-meta">→ ${it.addressLabel} · €${it.price}</div>`;
    row.addEventListener("click", () => {
      state.viewingItemId = it.id;
      state.viewItemReturnTo = "conclude";
      state.screen = "view-item-photo";
      render();
    });
    const changeBtn = el("button", "queue-item-change", "Cambia destinazione");
    changeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.editingItemId = it.id;
      state.editItemReturnTo = "conclude";
      state.screen = "edit-item-address";
      render();
    });
    row.appendChild(changeBtn);
    list.appendChild(row);
  });
  wrap.appendChild(list);

  const totalsByDest = {};
  state.pendingItems.forEach((it) => {
    totalsByDest[it.addressLabel] = (totalsByDest[it.addressLabel] || 0) + it.price;
  });
  const groups = Object.keys(totalsByDest).length;
  const summary = el(
    "div",
    "info-line",
    `${state.pendingItems.length} oggetti verranno consolidati in ${groups} spedizion${groups === 1 ? "e" : "i"} (una per destinazione), invece di ${state.pendingItems.length} separate.`
  );
  wrap.appendChild(summary);

  const confirmBtn = el("button", "btn-primary", "Conferma e invia ordine di ritiro consolidato →");
  confirmBtn.addEventListener("click", () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Invio ordine…";
    setTimeout(() => {
      state.shippedGroups = Object.entries(totalsByDest).map(([dest, total]) => ({
        dest,
        total: total.toFixed(2),
        code: generateBookingCode(),
        count: state.pendingItems.filter((it) => it.addressLabel === dest).length,
      }));
      state.pendingItems.forEach((it) => {
        it.status = "ritirato";
        syncPurchaseToCRM(it);
      });
      state.pendingItems = [];
      savePending();
      saveHistory();
      state.screen = "shipped";
      render();
    }, 800);
  });
  wrap.appendChild(confirmBtn);

  return wrap;
}

function ShippedScreen() {
  const wrap = el("div", "section booked-screen");
  wrap.appendChild(el("div", "booked-icon", "✓"));
  wrap.appendChild(el("div", "booked-title", "Ordine di ritiro inviato"));
  wrap.appendChild(
    el(
      "div",
      "booked-text",
      `Il corriere passerà a ritirare tutti gli oggetti lasciati nei negozi entro le prossime 24 ore, consolidati in ${state.shippedGroups.length} spedizion${state.shippedGroups.length === 1 ? "e" : "i"}.`
    )
  );
  (state.shippedGroups || []).forEach((g) => {
    const card = el("div", "qr-card");
    card.innerHTML = `<div class="qr-code">${g.code}</div>
      <div class="qr-note">${g.count} oggett${g.count === 1 ? "o" : "i"} → ${g.dest}</div>
      <div class="qr-note">Totale €${g.total}</div>`;
    wrap.appendChild(card);
  });
  wrap.appendChild(el("div", "booked-note", "Prototipo — nessuna richiesta reale è stata inviata a un corriere."));
  const backBtn = el("button", "btn-primary", "Torna alla home");
  backBtn.addEventListener("click", () => {
    state.screen = "home";
    render();
  });
  wrap.appendChild(backBtn);
  return wrap;
}

function IdentifyScreen() {
  const wrap = el("div", "section identify-screen");
  const isBookingGate = !!state.identifyPrompt;
  wrap.innerHTML = `
    <div class="step-lbl">${isBookingGate ? "Ultimo passo · Registrati per spedire" : "Prima di iniziare · Chi sei"}</div>
    <div class="identify-intro">${
      state.identifyPrompt ||
      "Ci serve sapere chi sei e dove deve arrivare l'acquisto — così calcoliamo il prezzo giusto e prepariamo i documenti doganali a tuo nome. Il documento viene chiesto una sola volta."
    }</div>`;

  const nameField = el("div", "dest-field");
  nameField.innerHTML = `<div class="dest-lbl">Il tuo nome</div><input class="dest-input" id="name-input" placeholder="Es. Maria Rossi" />`;
  wrap.appendChild(nameField);

  const emailField = el("div", "dest-field");
  emailField.innerHTML = `<div class="dest-lbl">Email (per il tuo account)</div><input class="dest-input" id="email-input" type="email" placeholder="maria@esempio.com" />`;
  wrap.appendChild(emailField);

  wrap.appendChild(el("div", "tg-lbl", "Indirizzo di destinazione"));
  const addressFields = AddressFormFields("identify");
  wrap.appendChild(addressFields);
  if (state.guestDestinationCountry) {
    const countrySelect = addressFields.querySelector("#identify-country");
    if (countrySelect) countrySelect.value = state.guestDestinationCountry;
  }

  wrap.appendChild(el("div", "tg-lbl", "Documento di riconoscimento"));
  const idCard = el("div", "id-upload-card");
  idCard.innerHTML = `<div class="id-upload-ic">🪪</div><div class="id-upload-txt">Tocca per fotografare o caricare un documento (carta d'identità, passaporto)</div><div class="id-upload-status" id="id-upload-status">Nessun documento caricato</div>`;
  const idInput = el("input");
  idInput.type = "file";
  idInput.accept = "image/*";
  idInput.style.display = "none";
  let idDocumentData = null;
  let signatureDetected = false;
  idInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const statusEl = document.getElementById("id-upload-status");
    const reader = new FileReader();
    reader.onload = async () => {
      idDocumentData = await compressImage(reader.result, 700, 0.6);
      statusEl.textContent = "🔎 Verifico se il documento contiene una firma…";
      statusEl.classList.remove("ok");
      try {
        const detection = await detectSignature(idDocumentData);
        signatureDetected = !!detection.has_signature;
        statusEl.textContent = signatureDetected
          ? "✓ Documento caricato — firma rilevata sul documento"
          : "✓ Documento caricato — nessuna firma rilevata sul documento";
        if (signatureDetected) statusEl.classList.add("ok");
      } catch (err) {
        signatureDetected = false;
        statusEl.textContent = "✓ Documento caricato — verifica firma non riuscita, riprova più tardi";
      }
    };
    reader.readAsDataURL(file);
  });
  idCard.appendChild(idInput);
  idCard.addEventListener("click", () => idInput.click());
  wrap.appendChild(idCard);
  wrap.appendChild(
    el("div", "home-foot", "Se il documento contiene già una firma visibile, verrà usata per firmare digitalmente le tue fatture proforma — nessuna firma aggiuntiva richiesta. Il documento resta salvato solo sul tuo dispositivo.")
  );

  const goBtn = el("button", "btn-primary", "Salva e continua →");
  goBtn.addEventListener("click", async () => {
    const name = document.getElementById("name-input").value.trim();
    const email = document.getElementById("email-input").value.trim();
    const addr = readAddressForm("identify");
    if (!addr.city || !addr.country) return;
    if (!email || !email.includes("@")) {
      alert("Inserisci un'email valida — serve per il tuo account.");
      return;
    }
    state.touristName = name || "Ospite";
    state.touristEmail = email;
    addr.label = "Casa";
    addr.id = "addr-" + Date.now();
    state.addresses = [addr];
    state.selectedAddressId = addr.id;
    state.idDocument = idDocumentData;
    state.signatureDetected = signatureDetected;
    saveProfile();

    if (isBiometricSupported()) {
      goBtn.disabled = true;
      goBtn.textContent = "Attivo lo sblocco biometrico…";
      try {
        const credentialId = await registerBiometric(email, name);
        state.biometricCredentialId = credentialId;
        state.biometricVerified = true;
        saveProfile();
      } catch (e) {
        // L'utente ha annullato o il dispositivo non supporta il sensore —
        // si continua comunque senza sblocco biometrico.
      }
    }

    const returnTo = state.identifyReturnTo;
    state.identifyPrompt = null;
    state.identifyReturnTo = null;
    state.screen = returnTo || "home";
    render();
  });
  wrap.appendChild(goBtn);

  return wrap;
}

async function detectSignature(idDocumentDataUrl) {
  const base64 = idDocumentDataUrl.split(",")[1];
  const mediaType = idDocumentDataUrl.split(";")[0].split(":")[1] || "image/jpeg";
  const result = await classify([
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        {
          type: "text",
          text: 'Analizza questa immagine di un documento di identità. Contiene una firma manoscritta visibile del titolare? Rispondi SOLO con JSON valido: {"has_signature": true o false}',
        },
      ],
    },
  ]);
  return result;
}

function AddressFormFields(prefix) {
  const wrap = el("div", "address-form");
  wrap.innerHTML = `
    <input class="addr-input" id="${prefix}-street" placeholder="Via e numero civico" />
    <div class="addr-row">
      <input class="addr-input" id="${prefix}-city" placeholder="Città" />
      <input class="addr-input addr-cap" id="${prefix}-cap" placeholder="CAP" />
    </div>
    <select class="dest-select addr-country" id="${prefix}-country">
      ${DESTINATIONS.map((d) => `<option value="${d.name}">${d.name}</option>`).join("")}
    </select>`;
  return wrap;
}

function readAddressForm(prefix) {
  const g = (id) => {
    const node = document.getElementById(id);
    return node ? node.value.trim() : "";
  };
  return {
    street: g(`${prefix}-street`),
    city: g(`${prefix}-city`),
    cap: g(`${prefix}-cap`),
    country: g(`${prefix}-country`),
  };
}

function formatAddress(a) {
  if (!a) return "—";
  const parts = [a.street, [a.cap, a.city].filter(Boolean).join(" "), a.country].filter(Boolean);
  return parts.join(", ");
}

function getSelectedAddress() {
  return state.addresses.find((a) => a.id === state.selectedAddressId) || state.addresses[0] || null;
}

// Destinazione da usare per il calcolo prezzo: l'indirizzo salvato se il
// turista è registrato, altrimenti il solo paese generico scelto in Passo 2
// (nessun indirizzo completo richiesto finché non si conferma davvero).
function currentDestinationName() {
  const addr = getSelectedAddress();
  return addr ? addr.country : state.guestDestinationCountry;
}

function GuestDestinationField() {
  if (!state.guestDestinationCountry) state.guestDestinationCountry = DESTINATIONS[0].name;
  const wrap = el("div", "dest-field-block");
  const field = el("div", "dest-field");
  field.innerHTML = `<div class="dest-lbl">Paese di destinazione</div>
    <select class="dest-select" id="guest-country-input">
      ${DESTINATIONS.map(
        (d) => `<option value="${d.name}" ${d.name === state.guestDestinationCountry ? "selected" : ""}>${d.name}</option>`
      ).join("")}
    </select>`;
  field.querySelector("#guest-country-input").addEventListener("change", (e) => {
    state.guestDestinationCountry = e.target.value;
  });
  wrap.appendChild(field);
  wrap.appendChild(
    el(
      "div",
      "pickup-note",
      "Basta il paese per calcolare subito il prezzo — l'indirizzo completo verrà chiesto solo quando confermi davvero la spedizione."
    )
  );
  return wrap;
}

function DestinationField() {
  if (state.addresses.length === 0) return GuestDestinationField();
  const wrap = el("div", "dest-field-block");
  const label = state.destinationFromProfile ? "Dal tuo profilo" : "Destinazione selezionata";
  const current = getSelectedAddress();
  wrap.innerHTML = `<div class="dest-lbl">${label}</div>
    <div class="addr-summary">${current ? `<b>${current.label || "Indirizzo"}</b> · ${formatAddress(current)}` : "Nessun indirizzo salvato"}</div>`;

  const list = el("div", "addr-list");
  state.addresses.forEach((a) => {
    const row = el("div", "addr-option" + (a.id === state.selectedAddressId ? " selected" : ""));
    row.innerHTML = `<span>${a.label || "Indirizzo"} — ${formatAddress(a)}</span>`;
    row.addEventListener("click", () => {
      state.selectedAddressId = a.id;
      state.destinationFromProfile = false;
      saveProfile();
      render();
    });
    list.appendChild(row);
  });
  wrap.appendChild(list);

  const addBtn = el("button", "btn-secondary", "+ Aggiungi un nuovo indirizzo");
  addBtn.addEventListener("click", () => {
    state.addAddressReturnTo = "destination";
    state.screen = "add-address";
    render();
  });
  wrap.appendChild(addBtn);

  return wrap;
}

function AddAddressScreen() {
  const wrap = el("div", "section");
  const back = el("div", "back", "← Torna indietro");
  back.addEventListener("click", () => {
    state.screen = state.addAddressReturnTo || "destination";
    render();
  });
  wrap.appendChild(back);
  wrap.appendChild(el("div", "step-lbl", "Nuovo indirizzo di destinazione"));

  const labelField = el("div", "dest-field");
  labelField.innerHTML = `<div class="dest-lbl">Etichetta</div><input class="dest-input" id="newaddr-label" placeholder="Es. Casa, Ufficio…" />`;
  wrap.appendChild(labelField);

  wrap.appendChild(AddressFormFields("newaddr"));

  const saveBtn = el("button", "btn-primary", "Salva indirizzo →");
  saveBtn.addEventListener("click", () => {
    const addr = readAddressForm("newaddr");
    if (!addr.city || !addr.country) return;
    addr.label = document.getElementById("newaddr-label").value.trim() || "Indirizzo";
    addr.id = "addr-" + Date.now();
    state.addresses.push(addr);
    state.selectedAddressId = addr.id;
    state.destinationFromProfile = false;
    saveProfile();
    state.screen = state.addAddressReturnTo || "destination";
    render();
  });
  wrap.appendChild(saveBtn);

  return wrap;
}

function ChooseAddressScreen() {
  const wrap = el("div", "section");
  const back = el("div", "back", "← Torna al risultato");
  back.addEventListener("click", () => {
    state.screen = "result";
    render();
  });
  wrap.appendChild(back);

  wrap.appendChild(el("div", "step-lbl", "A quale indirizzo destiniamo questo acquisto?"));
  wrap.appendChild(
    el("div", "identify-intro", `${state.result ? state.result.object_it : "Oggetto"} — scegli l'indirizzo per questa spedizione.`)
  );

  if (state.addresses.length === 0) {
    wrap.appendChild(
      el(
        "div",
        "identify-intro",
        `Destinazione indicata finora: ${state.guestDestinationCountry || "—"}. L'indirizzo completo verrà chiesto al passo successivo, quando confermi davvero la spedizione.`
      )
    );
  } else {
    const list = el("div", "addr-list");
    state.addresses.forEach((a) => {
      const row = el("div", "addr-option" + (a.id === state.selectedAddressId ? " selected" : ""));
      row.innerHTML = `<span>${a.label || "Indirizzo"} — ${formatAddress(a)}</span>`;
      row.addEventListener("click", () => {
        state.selectedAddressId = a.id;
        state.destinationFromProfile = false;
        render();
      });
      list.appendChild(row);
    });
    wrap.appendChild(list);

    const addBtn = el("button", "btn-secondary", "+ Aggiungi un nuovo indirizzo");
    addBtn.addEventListener("click", () => {
      state.addAddressReturnTo = "choose-address";
      state.screen = "add-address";
      render();
    });
    wrap.appendChild(addBtn);
  }

  wrap.appendChild(el("div", "tg-lbl", "Punto di ritiro per questo acquisto"));
  const pickupField = el("div", "dest-field");
  pickupField.innerHTML = `<div class="dest-lbl">Se diverso dal punto vendita rilevato</div><input class="dest-input" id="item-pickup-input" value="${state.pickupPoint}" />`;
  wrap.appendChild(pickupField);
  wrap.appendChild(
    el("div", "home-foot", "Utile se chi imballa/consegna l'oggetto non è lo stesso negozio dove hai fatto l'acquisto.")
  );

  const confirmBtn = el("button", "btn-primary", "Conferma e genera QR →");
  confirmBtn.addEventListener("click", async () => {
    if (!state.touristName) {
      state.identifyPrompt = "Ultimo passo: registrati per completare la spedizione — il preventivo resta questo.";
      state.identifyReturnTo = "choose-address";
      state.screen = "identify";
      render();
      return;
    }
    if (!state.selectedAddressId) return;
    const itemPickupPoint = document.getElementById("item-pickup-input").value.trim() || state.pickupPoint;
    const addr = getSelectedAddress();
    if (state.result) {
      state.price = priceFor(state.result.weight_kg, currentDestinationName(), state.result);
    }
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Genero QR…";
    if (state.priceConfirmedAsBreakeven) redeemPromoCode();

    let photo = null;
    let textDescription = null;
    if (state.pendingInput && state.pendingInput.type === "image") {
      photo = await compressImage(state.pendingInput.dataUrl, 480, 0.6);
    } else if (state.pendingInput && state.pendingInput.type === "text") {
      textDescription = state.pendingInput.label;
    }

    setTimeout(() => {
      const item = {
        id: generateBookingCode(),
        objectName: (state.result && state.result.object_it) || "Oggetto",
        hsCode: (state.result && state.result.hs_code) || "—",
        weightKg: state.result ? state.result.weight_kg : 1,
        dims: state.result
          ? { length_cm: state.result.length_cm, width_cm: state.result.width_cm, height_cm: state.result.height_cm }
          : null,
        packageDims: packagedDimensions(state.result),
        itemValue: state.result && typeof state.result.value_eur === "number" ? state.result.value_eur : 0,
        pricingTier: state.priceConfirmedAsBreakeven ? "breakeven" : state.isSubscribed ? "abbonato" : "pieno",
        pickupPoint: itemPickupPoint,
        pickupSource: itemPickupPoint === state.pickupPoint ? state.pickupSource : null,
        addressId: addr ? addr.id : null,
        addressLabel: addr ? `${addr.label || "Indirizzo"} — ${formatAddress(addr)}` : "—",
        price: state.price ? state.price.grandTotal : 0,
        touristName: state.touristName,
        partnerCode: state.activePartnerCode || null,
        partnerDiscountCode: state.partnerDiscountApplied ? state.partnerDiscountCode : null,
        partnerDiscountAmount: state.partnerDiscountApplied ? state.partnerDiscountAmount : null,
        status: "in sospeso",
        date: new Date().toISOString(),
        photo,
        textDescription,
        hasSignedInvoice: !!state.signatureDetected,
        hasIdOnFile: !!state.idDocument,
      };
      state.pendingItems.push(item);
      state.purchaseHistory.push(item);
      savePending();
      saveHistory();
      syncPurchaseToCRM(item);
      state.lastQueuedItem = item;
      state.screen = "queued";
      render();
    }, 700);
  });
  wrap.appendChild(confirmBtn);

  return wrap;
}

function EditItemAddressScreen() {
  const wrap = el("div", "section");
  const item = state.pendingItems.find((it) => it.id === state.editingItemId);
  const returnTo = state.editItemReturnTo || "conclude";

  const back = el("div", "back", "← Annulla");
  back.addEventListener("click", () => {
    state.editingItemId = null;
    state.screen = returnTo;
    render();
  });
  wrap.appendChild(back);

  if (!item) {
    wrap.appendChild(el("div", "identify-intro", "Acquisto non trovato."));
    return wrap;
  }

  wrap.appendChild(el("div", "step-lbl", "Cambia destinazione"));
  wrap.appendChild(el("div", "identify-intro", `${item.objectName} — attualmente verso: ${item.addressLabel}`));

  const list = el("div", "addr-list");
  state.addresses.forEach((a) => {
    const row = el("div", "addr-option" + (a.id === item.addressId ? " selected" : ""));
    row.innerHTML = `<span>${a.label || "Indirizzo"} — ${formatAddress(a)}</span>`;
    row.addEventListener("click", () => {
      item.addressId = a.id;
      item.addressLabel = `${a.label || "Indirizzo"} — ${formatAddress(a)}`;
      item.price = priceFor(item.weightKg, a.country, item.dims).grandTotal;
      savePending();
      saveHistory();
      state.editingItemId = null;
      state.screen = returnTo;
      render();
    });
    list.appendChild(row);
  });
  wrap.appendChild(list);

  const addBtn = el("button", "btn-secondary", "+ Aggiungi un nuovo indirizzo");
  addBtn.addEventListener("click", () => {
    state.addAddressReturnTo = "edit-item-address";
    state.screen = "add-address";
    render();
  });
  wrap.appendChild(addBtn);

  return wrap;
}

function compressImage(dataUrl, maxDim, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width;
      let h = img.height;
      if (w > h && w > maxDim) {
        h = Math.round((h * maxDim) / w);
        w = maxDim;
      } else if (h > maxDim) {
        w = Math.round((w * maxDim) / h);
        h = maxDim;
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function ViewItemPhotoScreen() {
  const wrap = el("div", "section");
  const item =
    state.purchaseHistory.find((it) => it.id === state.viewingItemId) ||
    state.pendingItems.find((it) => it.id === state.viewingItemId);
  const back = el("div", "back", "← Torna indietro");
  back.addEventListener("click", () => {
    state.viewingItemId = null;
    state.screen = state.viewItemReturnTo || "history";
    render();
  });
  wrap.appendChild(back);

  if (!item) {
    wrap.appendChild(el("div", "identify-intro", "Acquisto non trovato."));
    return wrap;
  }

  wrap.appendChild(el("div", "step-lbl", "Foto originale dell'acquisto"));
  if (item.photo) {
    const img = el("img", "capture-preview");
    img.src = item.photo;
    wrap.appendChild(img);
  } else if (item.textDescription) {
    wrap.appendChild(el("div", "pending-desc", `"${item.textDescription}"`));
    wrap.appendChild(el("div", "identify-intro", "Questo acquisto è stato descritto a testo, senza foto."));
  } else {
    wrap.appendChild(el("div", "identify-intro", "Nessuna foto disponibile per questo acquisto."));
  }

  const info = el("div", "info-card");
  info.innerHTML = `
    <div class="info-row"><span>Oggetto</span><b>${item.objectName}</b></div>
    <div class="info-row"><span>Codice HS</span><b>${item.hsCode}</b></div>
    <div class="info-row"><span>Ritiro</span><b>${item.pickupPoint}</b></div>
    <div class="info-row"><span>Destinazione</span><b>${item.addressLabel}</b></div>`;
  wrap.appendChild(info);

  return wrap;
}

function DashboardScreen() {
  const wrap = el("div", "section");
  const back = el("div", "back", "← Torna alla home");
  back.addEventListener("click", () => {
    state.screen = "home";
    render();
  });
  wrap.appendChild(back);
  wrap.appendChild(el("div", "step-lbl", "La tua spesa"));

  const items = state.purchaseHistory;
  const totalValue = items.reduce((s, it) => s + (it.itemValue || 0), 0);
  const totalService = items.reduce((s, it) => s + (it.price || 0), 0);
  const pendingCount = items.filter((it) => it.status === "in sospeso").length;
  const doneCount = items.filter((it) => it.status === "ritirato").length;
  const fullPriceCount = items.filter((it) => it.pricingTier === "pieno").length;
  const subscriptionSavings = fullPriceCount * (FULL_FEE - SUBSCRIBED_FEE);

  const summary = el("div", "info-card");
  summary.innerHTML = `
    <div class="info-row"><span>Acquisti registrati</span><b>${items.length}</b></div>
    <div class="info-row"><span>In sospeso / ritirati</span><b>${pendingCount} / ${doneCount}</b></div>
    <div class="info-row"><span>Valore acquisti (stima AI)</span><b>€${totalValue.toFixed(2)}</b></div>
    <div class="info-row"><span>Speso in servizi Touch&amp;Go</span><b>€${totalService.toFixed(2)}</b></div>
    ${
      subscriptionSavings > 0
        ? `<div class="info-row"><span>${state.isSubscribed ? "Risparmiato abbonandoti" : "Risparmieresti abbonandoti"}</span><b>€${subscriptionSavings.toFixed(2)}</b></div>`
        : ""
    }
    <div class="info-row total"><span>Totale complessivo</span><b>€${(totalValue + totalService).toFixed(2)}</b></div>`;
  wrap.appendChild(summary);

  wrap.appendChild(el("div", "tg-lbl", "Dettaglio per acquisto"));
  const list = el("div", "history-list");
  if (!items.length) {
    list.appendChild(el("div", "identify-intro", "Non hai ancora registrato nessun acquisto."));
  } else {
    items
      .slice()
      .reverse()
      .forEach((it) => {
        const banner = pickupPointUpdateBanner(it);
        if (banner) list.appendChild(banner);
        const row = el("div", "history-item");
        row.innerHTML = `
          <div class="history-top"><span class="history-name">${it.objectName}</span><span class="history-status ${historyStatusClass(it.status)}">${it.status}</span></div>
          <div class="history-meta">Valore oggetto: €${(it.itemValue || 0).toFixed(2)} · Servizio Touch&amp;Go: €${it.price}</div>`;
        list.appendChild(row);
      });
  }
  wrap.appendChild(list);

  return wrap;
}

function resetEverything() {
  if (!confirm("Cancellare nome, indirizzi salvati, acquisti in sospeso, lo storico acquisti e ricominciare da capo?")) return;
  try {
    localStorage.removeItem("tg_profile");
    localStorage.removeItem("tg_pending");
    localStorage.removeItem("tg_history");
  } catch (e) {}
  state.touristName = null;
  state.touristEmail = null;
  state.biometricCredentialId = null;
  state.biometricVerified = false;
  state.isSubscribed = false;
  state.idDocument = null;
  state.signatureDetected = false;
  state.addresses = [];
  state.selectedAddressId = null;
  state.destinationFromProfile = true;
  state.guestDestinationCountry = null;
  state.identifyPrompt = null;
  state.identifyReturnTo = null;
  state.pendingInput = null;
  state.pendingItems = [];
  state.purchaseHistory = [];
  state.mode = "turista";
  state.screen = "cover";
  render();
}

function isBiometricSupported() {
  return !!(window.PublicKeyCredential && navigator.credentials);
}

function randomChallenge() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return arr;
}

function bufToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function base64ToBuf(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function registerBiometric(email, name) {
  const userId = new Uint8Array(16);
  crypto.getRandomValues(userId);
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: randomChallenge(),
      rp: { name: "Touch&Go" },
      user: { id: userId, name: email, displayName: name || email },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
      timeout: 60000,
    },
  });
  return bufToBase64(credential.rawId);
}

async function verifyBiometric(credentialIdBase64) {
  await navigator.credentials.get({
    publicKey: {
      challenge: randomChallenge(),
      allowCredentials: [{ id: base64ToBuf(credentialIdBase64), type: "public-key" }],
      userVerification: "required",
      timeout: 60000,
    },
  });
}

function BiometricLockScreen() {
  const wrap = el("div", "section biometric-lock");
  wrap.innerHTML = `
    <div class="biometric-icon">🔒</div>
    <div class="step-lbl" style="justify-content:center;text-align:center">Sblocca Touch&amp;Go</div>
    <div class="identify-intro" style="text-align:center">Ciao ${state.touristName || ""} — verifica la tua identità per continuare.</div>`;
  const unlockBtn = el("button", "btn-primary", "🔓 Sblocca con Face ID / Touch ID / impronta");
  const errBox = el("div", "alert hidden");
  unlockBtn.addEventListener("click", async () => {
    unlockBtn.disabled = true;
    unlockBtn.textContent = "Verifico…";
    errBox.classList.add("hidden");
    try {
      await verifyBiometric(state.biometricCredentialId);
      state.biometricVerified = true;
      state.screen = state.touristName ? "home" : "cover";
      render();
    } catch (e) {
      errBox.textContent = "⚠️ Verifica non riuscita o annullata. Riprova.";
      errBox.classList.remove("hidden");
      unlockBtn.disabled = false;
      unlockBtn.textContent = "🔓 Sblocca con Face ID / Touch ID / impronta";
    }
  });
  wrap.appendChild(unlockBtn);
  wrap.appendChild(errBox);
  const skipBtn = el("button", "reset-link", "Non riesco a sbloccare — resetta l'account");
  skipBtn.addEventListener("click", resetEverything);
  wrap.appendChild(skipBtn);
  return wrap;
}

function saveProfile() {
  try {
    localStorage.setItem(
      "tg_profile",
      JSON.stringify({
        name: state.touristName,
        email: state.touristEmail,
        addresses: state.addresses,
        selectedAddressId: state.selectedAddressId,
        idDocument: state.idDocument,
        signatureDetected: state.signatureDetected,
        biometricCredentialId: state.biometricCredentialId,
        isSubscribed: state.isSubscribed,
      })
    );
  } catch (e) {}
}

function loadProfile() {
  try {
    const raw = localStorage.getItem("tg_profile");
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p.name) state.touristName = p.name;
    if (p.email) state.touristEmail = p.email;
    if (p.addresses && p.addresses.length) {
      state.addresses = p.addresses;
      state.selectedAddressId = p.selectedAddressId || p.addresses[0].id;
      state.destinationFromProfile = true;
    }
    if (p.idDocument) state.idDocument = p.idDocument;
    if (typeof p.signatureDetected === "boolean") state.signatureDetected = p.signatureDetected;
    if (p.biometricCredentialId) state.biometricCredentialId = p.biometricCredentialId;
    if (typeof p.isSubscribed === "boolean") state.isSubscribed = p.isSubscribed;
  } catch (e) {}
}

function savePending() {
  try {
    localStorage.setItem("tg_pending", JSON.stringify(state.pendingItems));
  } catch (e) {}
}

function loadPending() {
  try {
    const raw = localStorage.getItem("tg_pending");
    if (!raw) return;
    const items = JSON.parse(raw);
    if (Array.isArray(items)) state.pendingItems = items;
  } catch (e) {}
}

function saveHistory() {
  try {
    localStorage.setItem("tg_history", JSON.stringify(state.purchaseHistory));
  } catch (e) {}
}

function loadHistory() {
  try {
    const raw = localStorage.getItem("tg_history");
    if (!raw) return;
    const items = JSON.parse(raw);
    if (Array.isArray(items)) state.purchaseHistory = items;
  } catch (e) {}
}

function PurchaseHistoryList(items, emptyText, editable) {
  const wrap = el("div", "history-list");
  if (!items.length) {
    wrap.appendChild(el("div", "identify-intro", emptyText));
    return wrap;
  }
  items
    .slice()
    .reverse()
    .forEach((it) => {
      const banner = pickupPointUpdateBanner(it);
      if (banner) wrap.appendChild(banner);
      const row = el("div", "history-item");
      const dt = new Date(it.date);
      const dateStr = isNaN(dt) ? "" : dt.toLocaleDateString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
      const sourceLbl = it.pickupSource === "gps" ? "GPS" : it.pickupSource === "ip" ? "rete" : "manuale";
      row.innerHTML = `
        <div class="history-top"><span class="history-name">${it.objectName}</span><span class="history-status ${historyStatusClass(it.status)}">${it.status}</span></div>
        <div class="history-meta">Ritiro rilevato (${sourceLbl}): <b>${it.pickupPoint}</b> · HS ${it.hsCode}</div>
        <div class="history-meta">→ ${it.addressLabel} · €${it.price}</div>
        <div class="history-meta">${it.touristName ? it.touristName + " · " : ""}${dateStr}</div>`;
      if (editable) {
        row.classList.add("clickable");
        row.addEventListener("click", () => {
          state.viewingItemId = it.id;
          state.viewItemReturnTo = "history";
          state.screen = "view-item-photo";
          render();
        });
        const docsBtn = el("button", "queue-item-change", "Lettera di vettura e fattura");
        docsBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          state.viewingDocsItemId = it.id;
          state.docsReturnTo = "history";
          state.screen = "documents";
          render();
        });
        row.appendChild(docsBtn);
      }
      if (editable && it.status === "in sospeso") {
        const changeBtn = el("button", "queue-item-change", "Cambia destinazione");
        changeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          state.editingItemId = it.id;
          state.editItemReturnTo = "history";
          state.screen = "edit-item-address";
          render();
        });
        row.appendChild(changeBtn);
      }
      if (editable && it.status === "in confezionamento") {
        const pickupBtn = el("button", "queue-item-change", "📦 Richiedi ritiro");
        pickupBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          it.status = "ritiro richiesto";
          it.pickupRequestedAt = new Date().toISOString();
          savePending();
          saveHistory();
          syncPurchaseToCRM(it);
          render();
        });
        row.appendChild(pickupBtn);
      }
      wrap.appendChild(row);
    });
  return wrap;
}

function HistoryScreen() {
  const wrap = el("div", "section");
  wrap.appendChild(AssistantAvatar("history"));
  const back = el("div", "back", "← Torna alla home");
  back.addEventListener("click", () => {
    state.screen = "home";
    render();
  });
  wrap.appendChild(back);
  wrap.appendChild(el("div", "step-lbl", "I tuoi acquisti"));
  wrap.appendChild(PurchaseHistoryList(state.purchaseHistory, "Non hai ancora registrato nessun acquisto.", true));
  return wrap;
}



function Footer() {
  const f = el("div", "footer");
  f.innerHTML = `<p>Prototipo Touch&amp;Go · Catania 2026 · Pre-seed · Smart&amp;Start Italia<br/>Classificazione AI reale · Quote e pagamenti simulati per il test</p>
    <div class="footer-links">
      <button class="reset-link" id="dashboard-link">La tua spesa</button>
      <button class="reset-link" id="history-link">I tuoi acquisti (${state.purchaseHistory.length})</button>
      <button class="reset-link" id="reset-link">Resetta tutto</button>
    </div>
    <div class="footer-links">
      <a class="reset-link" href="/site/termini.html">Termini di servizio</a>
      <a class="reset-link" href="/site/privacy.html">Privacy</a>
    </div>`;
  f.querySelector("#reset-link").addEventListener("click", resetEverything);
  f.querySelector("#history-link").addEventListener("click", () => {
    state.screen = "history";
    render();
    syncPurchaseUpdatesFromCRM();
  });
  f.querySelector("#dashboard-link").addEventListener("click", () => {
    state.screen = "dashboard";
    render();
    syncPurchaseUpdatesFromCRM();
  });
  return f;
}

// ---------------- Handlers ----------------

async function runClassification(promise) {
  state.screen = "analyzing";
  state.error = null;
  render();
  try {
    const result = await promise;
    state.result = result;
    state.price = priceFor(result.weight_kg, currentDestinationName(), result);
    state.priceConfirmedForThisResult = false;
    state.priceConfirmedAsBreakeven = false;
    state.showPartnerDiscountInput = false;
    state.partnerDiscountCodeInput = "";
    state.partnerDiscountChecking = false;
    state.partnerDiscountApplied = false;
    state.partnerDiscountCode = null;
    state.partnerDiscountAmount = 0;
    state.partnerDiscountError = null;
    state.screen = "result";
  } catch (err) {
    state.error = /401/.test(err.message) ? "Chiave API non valida. Riprova più tardi." : "Errore AI. Riprova.";
    state.screen = "destination";
  }
  render();
}

function handleFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    state.pendingInput = { type: "image", base64: dataUrl.split(",")[1], mediaType: file.type, dataUrl };
    state.screen = "destination";
    render();
  };
  reader.readAsDataURL(file);
}

function handleDescribe(label) {
  state.pendingInput = { type: "text", label };
  state.screen = "destination";
  render();
}

loadProfile();
loadPending();
if (state.biometricCredentialId && isBiometricSupported()) {
  state.screen = "biometric-lock";
}
function capturePartnerCode() {
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("partner");
    if (fromUrl) {
      state.activePartnerCode = fromUrl.trim().toUpperCase();
      localStorage.setItem("tg_active_partner", state.activePartnerCode);
    } else {
      const saved = localStorage.getItem("tg_active_partner");
      if (saved) state.activePartnerCode = saved;
    }
  } catch (e) {}
}

capturePartnerCode();

// Codice invito per l'offerta "prima spedizione a prezzo breakeven".
// A differenza del codice partner, non viene mai mostrato di default:
// compare solo se arriva da un link diretto (?invito=CODICE) o se il
// turista lo digita esplicitamente. Il codice è single-use e viene
// verificato/consumato lato server (netlify/functions/promo.js).
function capturePromoCode() {
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("invito");
    if (fromUrl) {
      state.promoCode = fromUrl.trim().toUpperCase();
    }
  } catch (e) {}
}

async function checkPromoCode(code) {
  const normalized = (code || "").trim().toUpperCase();
  if (!normalized) return;
  state.promoCode = normalized;
  state.promoChecked = false;
  state.promoValid = false;
  render();
  try {
    const res = await fetch("/.netlify/functions/promo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "check", code: normalized }),
    });
    const data = await res.json();
    state.promoChecked = true;
    state.promoValid = !!data.valid;
  } catch (e) {
    state.promoChecked = true;
    state.promoValid = false;
  }
  render();
}

function redeemPromoCode() {
  if (!state.promoCode || !state.promoValid || state.promoRedeemedThisOrder) return;
  state.promoRedeemedThisOrder = true;
  fetch("/.netlify/functions/promo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "redeem", code: state.promoCode }),
  }).catch(() => {
    // Se la conferma server-side fallisce, la spedizione resta comunque
    // valida per il turista: il codice andrà verificato manualmente lato
    // admin prima di essere riutilizzato per un nuovo invito.
  });
}

capturePromoCode();
if (state.promoCode) checkPromoCode(state.promoCode);
loadHistory();
render();
loadLocation();
syncPurchaseUpdatesFromCRM();

window.addEventListener("online", () => {
  state.isOffline = false;
  render();
});
window.addEventListener("offline", () => {
  state.isOffline = true;
  render();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
