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

const CLASSIFY_SCHEMA = `{"object_it":"...","object_en":"...","hs_code":"6 cifre","hs_description":"...","category":"Ceramica|Abbigliamento|Alimentari|Vino & Spirits|Accessori Moda|Arte & Antiquariato|Gioielleria|Artigianato|Altro","weight_kg":1.0,"dimensions_cm":"L x P x H stimate","value_eur":0,"fragile":false,"made_in_italy":true,"confidence":"alta|media|bassa","shipping_note":"..."}`;

const FLAT_FEE = 39;

const DESTINATIONS = [
  { name: "Italia / UE", zone: "eu" },
  { name: "Regno Unito", zone: "europe" },
  { name: "Svizzera", zone: "europe" },
  { name: "Stati Uniti", zone: "intercontinental" },
  { name: "Emirati Arabi Uniti", zone: "intercontinental" },
  { name: "Cina", zone: "intercontinental" },
  { name: "Giappone", zone: "intercontinental" },
  { name: "Altro / non specificata", zone: "intercontinental" },
];

const ZONE_RATES = {
  eu: { base: 5.5, perKg: 1.3, eta: "1–3 giorni lavorativi" },
  europe: { base: 9, perKg: 2.1, eta: "2–4 giorni lavorativi" },
  intercontinental: { base: 19, perKg: 8, eta: "3–7 giorni lavorativi" },
};

function priceFor(weightKg, destinationName) {
  const w = Math.max(0.3, parseFloat(weightKg) || 1);
  const dest = DESTINATIONS.find((d) => d.name === destinationName) || DESTINATIONS[3];
  const rate = ZONE_RATES[dest.zone];
  const shipping = rate.base + w * rate.perKg;
  return {
    grandTotal: parseFloat((shipping + FLAT_FEE).toFixed(2)),
    eta: rate.eta,
  };
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
  bookingCode: null,
  touristName: null,
};
const app = document.getElementById("app");

function render() {
  app.innerHTML = "";
  app.appendChild(Header());
  if (state.mode === "partner") app.appendChild(PartnerScreen());
  else if (state.screen === "cover") app.appendChild(CoverScreen());
  else if (state.screen === "identify") app.appendChild(IdentifyScreen());
  else if (state.screen === "home") app.appendChild(HomeScreen());
  else if (state.screen === "destination") app.appendChild(DestinationScreen());
  else if (state.screen === "add-address") app.appendChild(AddAddressScreen());
  else if (state.screen === "choose-address") app.appendChild(ChooseAddressScreen());
  else if (state.screen === "analyzing") app.appendChild(AnalyzingScreen());
  else if (state.screen === "result") app.appendChild(ResultScreen());
  else if (state.screen === "booked") app.appendChild(BookedScreen());
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
  header.innerHTML = `<div class="brand"><span class="brand-name">Touch<b>&amp;</b>Go</span></div>`;
  wrap.appendChild(header);

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
    <div class="info-line">Piani, canoni e dettagli sulla commissione sono su <b>touchandgo.it/partner</b>.</div>`;
  wrap.appendChild(intro);

  const cta = el("button", "btn-primary", "Scopri i piani partner →");
  wrap.appendChild(cta);

  return wrap;
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
    state.screen = state.touristName ? "home" : "identify";
    render();
  });
  return wrap;
}

function HomeScreen() {
  const wrap = el("div");
  wrap.appendChild(TrustRow());

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
  wrap.appendChild(section);

  return wrap;
}

function DestinationScreen() {
  const wrap = el("div", "section");
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
  const wrap = el("div", "dest-field");
  const label =
    state.pickupSource === "gps"
      ? "Punto di ritiro (GPS)"
      : state.pickupSource === "ip"
      ? "Punto di ritiro (rete)"
      : "Punto di ritiro";
  wrap.innerHTML = `
    <div class="dest-lbl">${label}</div>
    <input class="dest-input" id="pickup-input" value="${state.pickupPoint}" />`;
  wrap.querySelector("#pickup-input").addEventListener("input", (e) => {
    state.pickupPoint = e.target.value;
    state.pickupSource = null;
  });
  return wrap;
}

function InfoSection() {
  const wrap = el("div", "section info-section");

  wrap.appendChild(el("div", "tg-lbl", "Come funziona il prezzo"));
  const priceInfo = el("div", "info-card");
  priceInfo.innerHTML = `
    <div class="info-row"><span>Fee di servizio Touch&amp;Go</span><b>€39</b></div>
    <div class="info-row"><span>Costo corriere (varia per peso/destinazione)</span><b>calcolato all'istante</b></div>
    <div class="info-row"><span>Nessun costo nascosto: vedi il totale prima di confermare</span></div>`;
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
  wrap.innerHTML = `<div class="spinner"></div><p>Analisi in corso…</p>`;
  return wrap;
}

function ResultScreen() {
  const r = state.result;
  const p = state.price;
  const courierCost = (p.grandTotal - FLAT_FEE).toFixed(2);
  const wrap = el("div");

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
  grid.innerHTML = `
    <div><div class="result-lbl">Peso stimato</div><div class="result-val">${r.weight_kg ?? "—"} kg</div></div>
    <div><div class="result-lbl">Dimensioni stimate</div><div class="result-val">${r.dimensions_cm || "—"}</div></div>
    <div><div class="result-lbl">Fragilità</div><div class="result-val ${r.fragile ? "warn" : ""}">${r.fragile ? "⚠️ Fragile" : "Non fragile"}</div></div>
    <div><div class="result-lbl">Ritiro da</div><div class="result-val">${state.pickupPoint}</div></div>
    <div><div class="result-lbl">Destinazione</div><div class="result-val">${formatAddress(getSelectedAddress())}</div></div>`;
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

  const priceCard = el("div", "price-card");
  priceCard.innerHTML = `
    <div class="tg-lbl" style="margin-bottom:10px">Preventivo trasparente</div>
    <div class="info-row"><span>Fee di servizio Touch&amp;Go</span><b>€${FLAT_FEE}</b></div>
    <div class="info-row"><span>Corriere internazionale</span><b>€${courierCost}</b></div>
    <div class="info-row total"><span>Totale</span><b id="res-total">€0</b></div>
    <div class="info-line" style="margin-top:8px">Consegna in ${p.eta} · tracciamento incluso · copertura standard inclusa</div>`;
  wrap.appendChild(priceCard);

  const actions = el("div", "result-actions");
  const bookBtn = el("button", "btn-primary", "Richiedi il ritiro →");
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

function generateBookingCode() {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `TG-${rand}`;
}

function BookedScreen() {
  const wrap = el("div", "section booked-screen");
  const qrData = encodeURIComponent(
    `TouchAndGo|${state.bookingCode}|ritiro:${state.pickupPoint}|dest:${formatAddress(getSelectedAddress())}`
  );
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=8&color=15-15-15&bgcolor=250-248-244&data=${qrData}`;
  wrap.innerHTML = `
    <div class="booked-icon">✓</div>
    <div class="booked-title">Richiesta di ritiro inviata</div>
    <div class="booked-text">Il corriere passerà a ritirare l'oggetto da <b>${state.pickupPoint}</b> entro le prossime 24 ore. Mostra questo QR al ritiro.</div>
    <div class="qr-card">
      <img src="${qrUrl}" alt="QR di ritiro" class="qr-img" />
      <div class="qr-code">${state.bookingCode}</div>
      <div class="qr-note">Valido 48h · monouso</div>
    </div>
    <div class="booked-note">Prototipo — nessuna richiesta reale è stata inviata a un corriere.</div>`;
  const backBtn = el("button", "btn-primary", "Torna alla home");
  backBtn.addEventListener("click", () => {
    state.screen = "home";
    state.pendingInput = null;
    render();
  });
  wrap.appendChild(backBtn);
  return wrap;
}

function IdentifyScreen() {
  const wrap = el("div", "section identify-screen");
  wrap.innerHTML = `
    <div class="step-lbl">Prima di iniziare · Chi sei</div>
    <div class="identify-intro">Ci serve sapere chi sei e dove deve arrivare l'acquisto — così calcoliamo il prezzo giusto e prepariamo i documenti doganali a tuo nome.</div>`;

  const nameField = el("div", "dest-field");
  nameField.innerHTML = `<div class="dest-lbl">Il tuo nome</div><input class="dest-input" id="name-input" placeholder="Es. Maria Rossi" />`;
  wrap.appendChild(nameField);

  wrap.appendChild(el("div", "tg-lbl", "Indirizzo di destinazione"));
  wrap.appendChild(AddressFormFields("identify"));

  const goBtn = el("button", "btn-primary", "Salva e continua →");
  goBtn.addEventListener("click", () => {
    const name = document.getElementById("name-input").value.trim();
    const addr = readAddressForm("identify");
    if (!addr.city || !addr.country) return;
    state.touristName = name || "Ospite";
    addr.label = "Casa";
    addr.id = "addr-" + Date.now();
    state.addresses = [addr];
    state.selectedAddressId = addr.id;
    saveProfile();
    state.screen = "home";
    render();
  });
  wrap.appendChild(goBtn);

  return wrap;
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

function DestinationField() {
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

  const confirmBtn = el("button", "btn-primary", "Conferma e genera QR →");
  confirmBtn.addEventListener("click", () => {
    if (!state.selectedAddressId) return;
    const addr = getSelectedAddress();
    if (state.result) {
      state.price = priceFor(state.result.weight_kg, addr ? addr.country : null);
    }
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Invio richiesta…";
    setTimeout(() => {
      state.bookingCode = generateBookingCode();
      state.screen = "booked";
      render();
    }, 700);
  });
  wrap.appendChild(confirmBtn);

  return wrap;
}

function resetEverything() {
  if (!confirm("Cancellare nome, indirizzi salvati e ricominciare da capo?")) return;
  try {
    localStorage.removeItem("tg_profile");
  } catch (e) {}
  state.touristName = null;
  state.addresses = [];
  state.selectedAddressId = null;
  state.destinationFromProfile = true;
  state.pendingInput = null;
  state.mode = "turista";
  state.screen = "cover";
  render();
}

function saveProfile() {
  try {
    localStorage.setItem(
      "tg_profile",
      JSON.stringify({
        name: state.touristName,
        addresses: state.addresses,
        selectedAddressId: state.selectedAddressId,
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
    if (p.addresses && p.addresses.length) {
      state.addresses = p.addresses;
      state.selectedAddressId = p.selectedAddressId || p.addresses[0].id;
      state.destinationFromProfile = true;
    }
  } catch (e) {}
}

function Footer() {
  const f = el("div", "footer");
  f.innerHTML = `<p>Prototipo Touch&amp;Go · Catania 2026 · Pre-seed · Smart&amp;Start Italia<br/>Classificazione AI reale · Quote e pagamenti simulati per il test</p>
    <button class="reset-link" id="reset-link">Resetta tutto</button>`;
  f.querySelector("#reset-link").addEventListener("click", resetEverything);
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
    const addr = getSelectedAddress();
    state.price = priceFor(result.weight_kg, addr ? addr.country : null);
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
render();
loadLocation();
