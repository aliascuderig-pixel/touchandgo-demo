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
  destination: "Stati Uniti",
  destinationFromProfile: true,
  pendingInput: null,
  location: null,
  locationPhoto: null,
  pickupPoint: "Catania",
  pickupFromIP: false,
};
const app = document.getElementById("app");

function render() {
  app.innerHTML = "";
  app.appendChild(Header());
  if (state.mode === "partner") app.appendChild(PartnerScreen());
  else if (state.screen === "cover") app.appendChild(CoverScreen());
  else if (state.screen === "home") app.appendChild(HomeScreen());
  else if (state.screen === "destination") app.appendChild(DestinationScreen());
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
  const place = await locateTourist();
  if (!place) return;
  const photo = await cityPhoto(place.city);
  state.location = place;
  state.locationPhoto = photo;
  state.pickupPoint = place.city;
  state.pickupFromIP = true;
  if (state.screen === "home" && state.mode === "turista") render();
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
    state.screen = "home";
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
  const label = state.pickupFromIP ? "Punto di ritiro rilevato" : "Punto di ritiro";
  wrap.innerHTML = `
    <div class="dest-lbl">${label}</div>
    <input class="dest-input" id="pickup-input" value="${state.pickupPoint}" />`;
  wrap.querySelector("#pickup-input").addEventListener("input", (e) => {
    state.pickupPoint = e.target.value;
    state.pickupFromIP = false;
  });
  return wrap;
}

function DestinationField() {
  const wrap = el("div", "dest-field");
  const label = state.destinationFromProfile ? "Dal tuo profilo" : "Destinazione selezionata";
  wrap.innerHTML = `
    <div class="dest-lbl">${label}</div>
    <select class="dest-select" id="dest-select">
      ${DESTINATIONS.map((d) => `<option value="${d.name}" ${d.name === state.destination ? "selected" : ""}>${d.name}</option>`).join("")}
    </select>`;
  wrap.querySelector("#dest-select").addEventListener("change", (e) => {
    state.destination = e.target.value;
    state.destinationFromProfile = false;
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
    <div><div class="result-lbl">Destinazione</div><div class="result-val">${state.destination}</div></div>`;
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
    bookBtn.disabled = true;
    bookBtn.textContent = "Invio richiesta…";
    setTimeout(() => {
      state.screen = "booked";
      render();
    }, 700);
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

function BookedScreen() {
  const wrap = el("div", "section booked-screen");
  wrap.innerHTML = `
    <div class="booked-icon">✓</div>
    <div class="booked-title">Richiesta di ritiro inviata</div>
    <div class="booked-text">Il corriere passerà a ritirare l'oggetto da <b>${state.pickupPoint}</b> entro le prossime 24 ore. Riceverai aggiornamenti e il QR di conferma via WhatsApp.</div>
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

function Footer() {
  const f = el("div", "footer");
  f.innerHTML = `<p>Prototipo Touch&amp;Go · Catania 2026 · Pre-seed · Smart&amp;Start Italia<br/>Classificazione AI reale · Quote e pagamenti simulati per il test</p>`;
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
    state.price = priceFor(result.weight_kg, state.destination);
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

render();
loadLocation();
