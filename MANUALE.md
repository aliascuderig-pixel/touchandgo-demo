# Manuale del progetto — Touch&Go

Documentazione funzionale di tutto quello che è stato costruito finora. Aggiornato leggendo lo stato reale del codice (non solo i messaggi di commit) — se qualcosa qui non corrisponde più a quello che vedi nell'app o nel CRM, il codice ha ragione e questo file va aggiornato (vedi CLAUDE.md).

---

## Panoramica

**Touch&Go** è una piattaforma che permette a un turista in Italia di fotografare un acquisto in negozio, farlo classificare automaticamente (dogana, peso, dimensioni) da un'AI, lasciarlo in negozio con un QR, e riceverlo spedito a casa — con esenzione IVA export gestita in automatico. I negozi partner guadagnano una commissione su ogni vendita generata tramite il loro codice.

Il progetto è composto da tre parti, tutte servite dallo stesso sito:

| Parte | Percorso | Cos'è |
|---|---|---|
| **App turista + partner** | `dist/index.html` + `dist/assets/app.js` | L'app vera e propria (una sola pagina, un solo file JS). Ha due modalità selezionabili in alto: "Turista" e "Partner". |
| **Sito marketing** | `dist/site/index.html`, `investitori.html`, `privacy.html`, `termini.html` | Sito pubblico: presentazione prodotto, registrazione partner self-service, pagina investitori protetta da password, termini e privacy. |
| **CRM interno** | `dist/site/admin.html` | Gestionale per lo staff: acquisti, partner, documenti, legale, ecc. Non indicizzato dai motori di ricerca (`noindex`), ma raggiungibile da chiunque conosca l'URL — le sezioni davvero sensibili restano dietro password (vedi sotto). |

**Stack tecnico**, in breve:

- **Nessun framework, nessun build step.** `app.js` e `admin.html` sono JavaScript scritto a mano (vanilla JS), caricato direttamente dal browser. I file dentro `dist/` sono quelli serviti in produzione — si editano direttamente, non c'è un passaggio di compilazione da un'altra cartella sorgente.
- **Backend**: [Netlify Functions](https://docs.netlify.com/functions/overview/) — piccoli file Node.js in `netlify/functions/*.js`, ognuno è un endpoint HTTP indipendente (es. `/.netlify/functions/crm`). Configurati in `netlify.toml`.
- **Database**: [Netlify Blobs](https://docs.netlify.com/blobs/overview/) — uno storage chiave/valore gestito da Netlify, niente database tradizionale da amministrare. Ogni "store" (`purchases`, `partners`, `legal`, `blocklist`, `promo`, `partner-discount-codes`, `rate-limits`) è una collezione separata di record JSON.
- **AI**: Claude (Anthropic) per la classificazione doganale delle foto, la stima delle dimensioni dell'imballo e il rilevamento firma sui documenti d'identità. La chiave `ANTHROPIC_API_KEY` resta solo sul server (funzione `classify.js`), mai esposta al browser.
- **QR code**: generati al volo tramite il servizio esterno `api.qrserver.com` (nessuna libreria QR interna).
- **PWA minima**: `dist/sw.js` mette in cache la shell dell'app (schermate, non i dati) così l'app resta consultabile offline; le chiamate AI/QR/geolocalizzazione richiedono sempre connessione.

---

## CRM (`dist/site/admin.html`)

Il CRM è un'unica pagina con tab in alto. Carica tutti i dati con un'unica chiamata (`action: "list"`) alla funzione `netlify/functions/crm.js`, che fa da backend per quasi tutto — le uniche eccezioni sono spiegate tab per tab.

**Password**: dal CRM è stato rimosso il vecchio gate generale (`ADMIN_PASSWORD` non esiste più). Oggi **la pagina si apre senza password**; solo alcune tab restano protette da password separate, verificate lato server contro variabili d'ambiente su Netlify (mai scritte qui in chiaro).

| Tab | Protetta? | A cosa serve |
|---|---|---|
| **Panoramica** | No | Prima tab che si vede aprendo il CRM: metriche di business aggregate in un colpo d'occhio (volume/ricavi, funnel, MRR/ARR reale, rete partner) — pensata per un investitore o per lo staff, non un elenco riga-per-riga. |
| **Acquisti** | No | Vedi ogni acquisto registrato da qualunque turista/dispositivo, con stato e azioni per farlo avanzare. |
| **Partner & Commissioni** | No | Anagrafica partner, vendite generate, commissioni, credito, codici sconto. |
| **Documenti** | Sì — `KIT_VAULT_PASSWORD` | Sintesi esecutiva del progetto per uso interno (problema, soluzione, modello di ricavo, competitor...) + il **Manuale del progetto** (vedi sezione dedicata più sotto). |
| **Pitch Deck** | No | Apre in una nuova scheda il documento HTML standalone per investitori (`TOUCHandGO_Allin_One.html`). |
| **Legale** | Sì — `KIT_VAULT_PASSWORD` | Guida su cosa condividere con chi (investitori/partner/tecnici) e un tracker NDA/contratti (chi ha firmato cosa e quando). |
| **Inviti** | No | Gestione codici invito per l'offerta "prima spedizione a prezzo breakeven" — **vedi nota sotto, questa tab non è oggi collegata al backend**. |
| **Bloccati** | No | Elenco clienti bloccati (automaticamente o manualmente) e sblocco. |
| **Riservato** | Sì — `KIT_VAULT_PASSWORD` | Elenco e download di tutti i file del kit digitale (contratti, cap table, modello economico, LOI...). |
| **Impostazioni** | No | Riepilogo di sola lettura delle tariffe/fee attuali (per modificarle serve cambiare il codice). |

Sbloccare una qualsiasi tra Documenti / Pitch Deck / Legale / Riservato con la password sblocca automaticamente anche le altre tre — condividono la stessa password e la stessa variabile in memoria del browser (si richiede di nuovo solo dopo un refresh della pagina).

### Tab Panoramica

Tutta calcolata **lato client** dagli stessi dati già caricati dalla chiamata `action: "list"` (acquisti e anagrafica partner) — nessuna chiamata aggiuntiva al backend, nessun nuovo store.

In cima alla tab, **sempre visibile** (non un tooltip, non un elemento nascosto/collassato), un banner di trasparenza: *"I dati mostrati riflettono lo stato attuale del database — se il progetto è in fase di test, i numeri includono acquisti/partner di prova."* — promemoria che queste metriche non distinguono dati reali da dati di prova finché non c'è una pulizia/segregazione esplicita dei record.

Quattro sezioni, ciascuna con le proprie card:

- **Volume e ricavi**: GMV processato (somma `itemValue`, il valore dichiarato della merce), ricavi servizio Touch&Go (somma `price` — include sia la fee di servizio sia il margine del 20% sul servizio di spedizione, `SHIPPING_MARGIN`: il corriere non è più puro pass-through, vedi "Dual pricing e offerte"), spedizioni totali, quante completate (stato "ritirato") con percentuale.
- **Funnel di conversione**: quanti acquisti in ciascuno dei 4 stati (numero e percentuale sul totale), più il **tasso di conversione ad abbonato** — tra le email che hanno almeno un acquisto a tariffa "pieno" o "breakeven" (quindi non ancora abbonate a quel punto), quale percentuale ha *anche* almeno un acquisto "abbonato" (quindi lo è diventata in seguito).
- **Ricavi ricorrenti partner (MRR/ARR reale)**: MRR calcolato solo sui partner con canone **effettivamente pagato** (`paid === true`, non su tutti i registrati), ARR = MRR × 12, e i canoni ancora in sospeso mostrati separatamente (non sommati nell'MRR, per non gonfiarlo).
- **Rete partner**: partner totali registrati, quanti hanno almeno una vendita associata ("attivi"), quanti sono registrati ma non hanno mai generato una vendita, e il credito totale in circolo (somma `creditBalance` di tutti i partner — utile per capire l'esposizione del sistema di crediti, vedi "Sistema crediti partner").

### Tab Acquisti

In cima, lo stesso banner di trasparenza della tab Panoramica (sempre visibile, non un tooltip): i dati riflettono lo stato attuale del database e possono includere record di prova.

Una riga per acquisto, con: data, turista, email, oggetto, punto di ritiro, destinazione, partner di riferimento (o "diretto"), importo del servizio, stato.

Lo stato di un acquisto ha **4 valori possibili** (vedi anche "App turista" più sotto): `in sospeso` → `in confezionamento` → `ritiro richiesto` → `ritirato`. Il pallino colorato in tabella riflette lo stato corrente.

Azioni disponibili per riga (cambiano in base allo stato):

- **📦 Invia a confezionamento** (solo su "in sospeso"): chiede il contatto di chi imballerà l'oggetto, condivide QR + dettagli via Web Share API (o link copiabile se non supportata), porta lo stato a "in confezionamento" e registra l'invio (azione `log-packaging-dispatch`).
- **📍 Cambia punto di ritiro** (solo su "in confezionamento"): utile se il confezionamento avviene altrove rispetto al negozio originale (azione `update-pickup-point`). Il turista vede un banner "punto di ritiro aggiornato" nell'app finché non lo conferma.
- **Segna ritirato**: disponibile su qualunque stato diverso da "ritirato", pensato come passaggio finale ma anche come correzione manuale per lo staff in caso di necessità (azione `update-status`). **Questo è anche il punto in cui, se l'acquisto ha un partner di riferimento, viene accreditato il credito partner** (vedi "Sistema crediti partner").
- **Blocca cliente**: blocca manualmente l'email del turista (vedi tab Bloccati).
- **Elimina**: rimuove il record dell'acquisto.
- **Dettagli**: espande una riga con chi/quando per ogni transizione registrata (invio confezionamento con destinatario, cambio punto di ritiro con vecchio/nuovo valore, richiesta ritiro).

### Tab Partner & Commissioni

Stesso banner di trasparenza in cima (dati/database attuale, possibili record di prova).

Una riga per ogni partner (codice), con: vendite generate, ricavo generato, commissione (10%), **credito disponibile**, codici sconto generati/usati, stato pagamento canone, note.

Form in alto per creare/aggiornare un partner manualmente (codice, nome, note) e bottone per segnare il canone come pagato/da pagare.

### Tab Documenti

Due contenuti, entrambi protetti da `KIT_VAULT_PASSWORD`:

1. **Sintesi esecutiva** (azione `get-documents` in `crm.js`) — problema/soluzione, architettura tecnica, partnership in corso, analisi competitiva, unit economics, proiezioni, struttura societaria, criteri selezione software house, Smart&Start, UNICT.
2. **Manuale del progetto** — questo stesso file (`MANUALE.md`), reso disponibile in-app tramite l'azione `get-manual` in `crm.js`, che legge il file bundlato con la function e lo mostra formattato. Vedi la sezione dedicata più sotto.

### Tab Pitch Deck

Non richiede password (a differenza degli altri contenuti del kit riservato). Un bottone apre in una scheda separata il documento HTML standalone per investitori, letto da `netlify/functions/kit-riservato/TOUCHandGO_Allin_One.html` (azione `get-pitch-deck`).

### Tab Legale

Guida su come e quando condividere ciascun documento (investitori, partner, tecnici), più un tracker manuale di NDA/contratti: controparte, tipo, data, stato (in attesa/firmato). I file firmati non vengono mai caricati o mostrati qui — solo registrati come evento.

### Tab Inviti — nota importante

Questa tab permette in teoria di creare/eliminare codici invito per l'offerta "prima spedizione a prezzo breakeven" (fee di servizio azzerata). **Allo stato attuale del codice, però, non è collegata correttamente al backend**: l'interfaccia chiama le azioni `save-promo` e `delete-promo` su `crm.js`, ma `crm.js` non le implementa (esistono solo `check`/`redeem` in `netlify/functions/promo.js`, usate dall'app turista per *consumare* un codice già esistente, non per crearlo). Il risultato pratico è che oggi **non è possibile creare un nuovo codice invito dalla tab Inviti** — va fatto scrivendo direttamente un record nello store Netlify Blobs `promo` (fuori dal CRM) finché questo gap non viene colmato con un'azione dedicata in `crm.js`.

### Tab Bloccati

Stesso banner di trasparenza in cima — inclusa qui perché le voci di questa tab nascono dagli stessi acquisti/tentativi reali (o di prova) registrati in `purchases`, non sono contenuto statico.

Elenco dei clienti bloccati, con motivo, data, tipo (Automatico/Manuale) e bottone di sblocco. Vedi "Blocco automatico anti-abuso" più sotto per come scattano i blocchi automatici.

### Tab Riservato

Password `KIT_VAULT_PASSWORD`, separata concettualmente dalle altre anche se nell'interfaccia è unificata. Elenca (ricorsivamente, incluse sottocartelle come `NDA/`) tutti i file dentro `netlify/functions/kit-riservato/` e permette di scaricarli uno per uno: strutture societarie, SAFE, modello economico, LOI, contratti software house, brief tecnici, ecc. La lettura dei file è protetta contro path traversal (non si può uscire dalla cartella `kit-riservato/`).

### Tab Impostazioni

Sola lettura: fee di servizio, commissione partner, tariffe di spedizione per zona (margine 20% già incluso). Una nota ricorda che questi valori sono presi dalla logica dell'app — per cambiarli davvero va modificato il codice (`FULL_FEE`, `SUBSCRIBED_FEE`, `SHIPPING_RATES`, `SHIPPING_MARGIN` in `app.js`), non questa pagina.

---

## App turista

Tutta l'esperienza vive in `dist/assets/app.js`, un'unica applicazione a schermate (`state.screen`) senza router — ogni funzione tipo `HomeScreen()`, `ResultScreen()` ecc. costruisce il DOM della schermata corrente e viene richiamata da `render()`.

### Flusso di acquisto end-to-end

1. **Cover** — schermata di apertura, mostra il punto di ritiro rilevato (GPS o stima da rete).
2. **Home** (`HomeScreen`) — foto dell'oggetto (fotocamera o galleria) oppure descrizione testuale libera. Qui compare anche il campo facoltativo "Hai un codice invito?" (offerta breakeven, vedi sotto).
3. **Destination** (`DestinationScreen`) — conferma/modifica il punto di ritiro e la destinazione della spedizione.
4. **Analyzing → Result** — la foto (o descrizione) viene inviata a Claude (funzione `classify.js`) che restituisce: nome oggetto, codice doganale HS, peso, dimensioni, valore stimato, fragilità, confidenza. Da qui si calcola anche il **dimensionamento dell'imballo consigliato** (margine di materiale protettivo, maggiore se l'oggetto è fragile).
5. **Scelta del prezzo** (in `ResultScreen`) — vedi "Dual pricing e offerte" più sotto: pieno vs abbonamento, eventuale offerta prima spedizione gratuita, codice invito breakeven, codice sconto partner.
6. **Registrazione** (`IdentifyScreen`, se non già fatta) — nome, email, indirizzo di destinazione, documento di riconoscimento (con rilevamento automatico della firma via AI, usata poi per firmare digitalmente le fatture proforma), e proposta di attivare lo sblocco biometrico (Face ID/Touch ID/impronta, via WebAuthn) per gli accessi successivi.
7. **QR generato** (`QueuedScreen`) — l'acquisto entra in stato **"in sospeso"**, viene mostrato un QR "di deposito" da mostrare in negozio, più le dimensioni consigliate dell'imballo. Da qui si può condividere il QR con chi imballa (`shareQR()`, Web Share API con fallback su link copiabile) e, se disponibili dimensioni consigliate, fotografare l'imballo pronto per farlo validare dall'AI (`PackageCheckScreen` — segnala se il pacco è più grande del necessario).
8. **Documenti** (`DocumentsScreen`) — lettera di vettura e fattura proforma generate automaticamente per ogni acquisto, consultabili in ogni momento.
9. **Conclusione soggiorno** (`ConcludeScreen`) — quando il turista ha finito di fare acquisti, consolida tutti gli acquisti "in sospeso" per destinazione in un unico ordine di ritiro (`ShippedScreen`) — qui gli acquisti passano storicamente a "ritirato" in un colpo solo (percorso legacy, oggi affiancato dal flusso più granulare a 4 stati descritto sotto).

### Dettatura vocale nei campi del form

Per i turisti di fretta o con difficoltà a digitare, alcuni campi testuali possono essere compilati parlando invece di scrivere, tramite la Web Speech API nativa del browser (`SpeechRecognition`/`webkitSpeechRecognition` — nessun servizio esterno, nessun costo per chiamata). La funzione riutilizzabile `addVoiceButton(inputElement)` in `dist/assets/app.js`:

- se il browser non supporta l'API, non aggiunge nulla — il campo resta scrivibile a tastiera senza errori;
- se supportata, aggiunge un'icona microfono (🎤) accanto al campo; al tap avvia il riconoscimento con `lang = navigator.language` (mai forzato a "it-IT", così il turista può dettare nella propria lingua) e mostra un feedback visivo (pulsazione dorata) mentre ascolta;
- il testo trascritto viene accodato al contenuto già presente nel campo (utile per dettare in più riprese), non lo sostituisce;
- se il permesso microfono viene negato, mostra un avviso breve e non bloccante sotto il campo — la digitazione manuale resta sempre disponibile.

È applicata a: nome del turista (`name-input`), etichetta indirizzo (`newaddr-label`) e ai campi via/città/CAP generati da `AddressFormFields()` (quindi automaticamente su ogni indirizzo, non solo uno). **Non** è applicata al campo email — dettare un indirizzo email a voce è troppo impreciso.

### Multilingua italiano/inglese (in corso — FASE 1 + FASE 2 contenuti dinamici)

L'app supporta italiano e inglese con rilevamento automatico, in `dist/assets/app.js`:

- **Dizionario** `I18N = { it: {...}, en: {...} }` — stesse chiavi in entrambe le lingue, organizzato per schermata con commenti di sezione.
- **Helper** `t(key, params)` — restituisce la stringa nella lingua corrente (`state.lang`), con fallback all'italiano e infine alla chiave stessa (mai una stringa vuota a schermo). Supporta un secondo argomento opzionale `params` per sostituire placeholder `{nome}` nel testo (es. `t("home_promo_active", { code: state.promoCode })`), usato ovunque il testo contenga un valore dinamico (prezzi, codici, conteggi).
- **Rilevamento iniziale** (`detectInitialLang()`): preferenza salvata in `localStorage` (`tg_lang`) se presente, altrimenti inglese se `navigator.language` inizia con "en", italiano in ogni altro caso.
- **Selettore manuale** — pulsanti "IT / EN" sempre visibili nell'header (`Header()`, che viene renderizzato su ogni schermata senza eccezioni), cliccabili in qualsiasi momento del percorso. Il click chiama `setLang(lang)`, che aggiorna `state.lang`, salva la preferenza in `localStorage` e ri-renderizza.
- **ETA di spedizione**: i tre valori fissi di `SHIPPING_RATES` (es. "24–48 ore") vengono tradotti a display tramite una piccola mappa dedicata (`ETA_TRANSLATIONS` + `localizeEta()`), senza toccare la struttura dati originale usata anche da codice non ancora tradotto.

**Cosa copre la FASE 1** (architettura + percorso principale d'acquisto): CoverScreen, HomeScreen, DestinationScreen, AnalyzingScreen, ResultScreen, PackageCheckScreen, IdentifyScreen, DocumentsScreen, più i componenti condivisi che vi compaiono (Header, Footer, TrustRow, AssistantAvatar, PickupField/DestinationField/GuestDestinationField, PartnerDiscountField, AddressFormFields).

**Cosa copre la FASE 2** (contenuti dinamici del percorso di classificazione/risultato, che in FASE 1 restavano in italiano fisso perché generati dall'AI o da tabelle dati anziché dal dizionario statico):

- **Nome oggetto** — l'AI di classificazione restituisce sempre la coppia bilingue `object_it`/`object_en` (schema `CLASSIFY_SCHEMA`); l'helper `localizeObjectName(r)` sceglie il campo giusto in base a `state.lang`, con fallback incrociato se una delle due lingue manca e infine sul testo generico `t("result_obj_fallback")` ("Oggetto"/"Item"). Usato in `animateResult()` (titolo risultato), `ChooseAddressScreen()` e nel salvataggio dell'`item` (`objectName`).
- **Descrizione doganale e consiglio di spedizione** — `CLASSIFY_SCHEMA` chiede all'AI le coppie bilingue `hs_description_it`/`hs_description_en` e `shipping_note_it`/`shipping_note_en` (sostituiscono i vecchi campi singoli `hs_description`/`shipping_note`); gli helper `localizeHsDescription(r)` e `localizeShippingNote(r)` scelgono il campo in base a `state.lang`, con lo stesso fallback incrociato.
- **Categoria**: i 9 valori fissi restituiti dall'AI (`category`) vengono tradotti a display tramite `CATEGORY_TRANSLATIONS` + `localizeCategory()`, stesso pattern di `ETA_TRANSLATIONS`/`localizeEta()`.
- **Nomi delle destinazioni**: ogni voce di `DESTINATIONS` ha ora anche `name_en` accanto a `name`. Il campo `name` resta invariato ed è quello usato per tutta la logica interna (valore delle `<option>`, corrispondenza con le zone di spedizione in `priceFor`/`priceQuotes`, `currentDestinationName()`, salvataggio indirizzi); **non va tradotto**. L'helper `destinationDisplayName(name)` cerca la voce corrispondente in `DESTINATIONS` e restituisce `name_en` solo per la visualizzazione quando `state.lang === "en"`. Usato nei menu a tendina (`AddressFormFields`, `GuestDestinationField`), in `formatAddress()` e ovunque il nome destinazione compare a schermo nel percorso principale (ResultScreen, ChooseAddressScreen).

**Cosa NON è ancora tradotto** (restano in italiano fisso finché non migrate in una fase successiva, riusando la stessa architettura I18N/t()): PartnerScreen e tutta l'area partner, Dashboard, History, AddAddress, EditItemAddress, ViewItemPhoto, Queued, Conclude, Shipped, BiometricLock (a eccezione dei contenuti dinamici coperti dalla FASE 2 sopra, che si applicano automaticamente ovunque queste schermate riusino `formatAddress()`, `localizeObjectName()` o gli altri helper condivisi).

### Stati di un acquisto

Un acquisto (`item`) attraversa fino a 4 stati:

```
in sospeso → in confezionamento → ritiro richiesto → ritirato
```

- **in sospeso**: appena creato, lasciato in negozio, in attesa che qualcuno lo confezioni.
- **in confezionamento**: lo staff (dal CRM) lo ha inviato a chi imballa, registrando contatto e orario (`packagingDispatch: { to, sentAt }`). Da qui il turista può anche vedere un **bottone "📦 Richiedi ritiro"** nel proprio storico acquisti.
- **ritiro richiesto**: il turista ha chiesto il ritiro (`pickupRequestedAt` registrato); in attesa che il corriere passi davvero.
- **ritirato**: passaggio finale, confermato dal turista stesso (concludendo il soggiorno) o dallo staff dal CRM. **È il momento in cui, se l'acquisto ha un partner di riferimento, scatta l'accredito del credito partner** (vedi più sotto).

Se lo staff cambia il punto di ritiro mentre l'acquisto è "in confezionamento" (perché il confezionamento avviene altrove), il turista vede un banner ben visibile nel proprio storico ("📍 Punto di ritiro aggiornato: ...") finché non lo conferma con un tap — a quel punto sparisce (flag `pickupPointChanged` azzerato lato server tramite l'azione `ack-pickup-point`).

### Dashboard "La tua spesa" (`DashboardScreen`)

Riepilogo di tutti gli acquisti del turista: numero totale, quanti in sospeso/ritirati, valore stimato degli oggetti acquistati, quanto speso in servizi Touch&Go, e — se applicabile — una riga di **risparmio legato all'abbonamento**:

- Se il turista **è già abbonato**: "Risparmiato abbonandoti" — quanto ha risparmiato sugli acquisti passati a tariffa piena, prima di abbonarsi.
- Se **non è abbonato**: "Risparmieresti abbonandoti" — incentivo calcolato sugli acquisti già fatti a tariffa piena.
- Il calcolo è: numero di acquisti a `pricingTier === "pieno"` × (`FULL_FEE` − `SUBSCRIBED_FEE`) = × €20. La riga non compare se il risparmio è €0 (nessun acquisto a tariffa piena), per non essere fuorviante.

### Dual pricing e offerte

Ogni preventivo mostra sempre, esplicitamente, sia il prezzo pieno che quello con abbonamento — mai un prezzo unico nascosto. Le costanti sono `FULL_FEE = €39` e `SUBSCRIBED_FEE = €19` di fee di servizio, più il costo del servizio di spedizione (calcolato a fasce di peso/volume per zona — domestico/transfrontaliero/worldwide, vedi `SHIPPING_RATES` — con un margine Touch&Go del 20% applicato sopra il costo grezzo del corriere, `SHIPPING_MARGIN`, sempre incluso nel valore mostrato).

Oltre al dual pricing standard, tre offerte possono ridurre il totale (mostrate in ordine di priorità, una alla volta):

1. **Codice invito — offerta breakeven**: un codice monouso (gestito nello store Blobs `promo`, validato/consumato da `netlify/functions/promo.js`) azzera la fee di servizio per quella spedizione — il turista paga solo il servizio di spedizione (margine 20% incluso, non più a costo vivo: solo la fee è azzerata). Il codice non è mai mostrato spontaneamente in app: si attiva solo con un link diretto (`?invito=CODICE`) o digitandolo manualmente.
2. **Prima spedizione gratuita**: se il turista non ha mai fatto un acquisto (`purchaseHistory` vuoto) e non è già abbonato, la prima spedizione ha la stessa condizione della breakeven (fee azzerata) — per fargli provare il servizio prima di scegliere se abbonarsi.
3. **Codice sconto partner**: un codice monouso generato da un partner (vedi "Area partner"), applica il 10% di sconto sulla sola fee di servizio (non sul corriere) — vedi "Sistema crediti partner".

### Blocco automatico anti-abuso

Gestito in `netlify/functions/save-purchase.js`, ogni volta che un acquisto viene salvato/aggiornato:

- Se l'email del turista è già nello store `blocklist`, il salvataggio viene rifiutato (403) — nessun dettaglio sul motivo esposto al client.
- **Regola automatica**: un cliente che ha già almeno un acquisto registrato e non è **mai** stato abbonato (nessun acquisto storico con `pricingTier === "abbonato"`), se tenta un acquisto aggiuntivo non-abbonato, viene bloccato automaticamente da quel momento in poi (pensato per scoraggiare l'uso ripetuto delle offerte "prima spedizione gratuita"/breakeven senza mai convertire in abbonamento).
- Il conteggio esclude correttamente le *risincronizzazioni* dello stesso acquisto (stesso `id`, es. quando cambia solo lo stato) — solo acquisti realmente distinti contano come "secondo acquisto".
- Lo staff può bloccare/sbloccare manualmente qualunque email dalla tab Bloccati del CRM.

---

## Area partner

Vive nella stessa app (`app.js`), selezionando "Partner" nel toggle in alto (`PartnerScreen` → `PartnerLoginAndHistory`).

### Registrazione self-service

Dal sito marketing (`dist/site/index.html`, sezione `#partner`): nome, email, scelta del piano. Chiama l'azione `register-partner` in `crm.js`, che genera un codice partner univoco (iniziali del nome + numero casuale, es. `BR482`), salva il record e genera subito la prima fattura del canone.

**Piani disponibili** (`PARTNER_PLANS` in `crm.js`, canone mensile):

| Piano | Canone/mese |
|---|---|
| Boutique | €49 |
| Enoteche & Cantine | €59 |
| Sport & Attrezzatura | €69 |
| Hotel | €99 |
| Tour Operator | €199 |
| Gratuito (solo commissione) | €0 |

Su ogni vendita generata tramite il codice partner, indipendentemente dal piano, il partner matura una **commissione del 10%** sul prezzo del servizio.

### Login e statistiche (`partner-stats.js`)

Il partner accede inserendo solo il proprio codice (nessuna password separata — stesso principio dei codici invito: non si può indovinare quali codici esistono, ma chi lo possiede può usarlo). Vede, aggregati in tempo reale dallo store centrale `purchases` (non dati locali del dispositivo):

- Vendite registrate tramite il suo codice.
- Valore generato (somma dei prezzi di servizio delle vendite).
- Commissione maturata (10% del valore generato).
- **Credito disponibile** (vedi sotto).

### QR promozionale

Un bottone genera un QR che incorpora l'URL dell'app con `?partner=CODICE` già impostato — chi lo scansiona apre l'app con il codice partner già collegato in automatico a qualunque acquisto farà.

### Fatturazione canone

`issuePartnerInvoice()` in `crm.js` crea una fattura (id, data, importo = canone del piano, periodo) e la aggiunge allo storico fatture del partner — usata sia alla registrazione self-service sia dall'azione `generate-partner-invoice`.

### Sistema crediti partner

Oltre alla commissione (un numero puramente informativo), ogni partner ha un **saldo credito reale e spendibile** (`creditBalance`, persistito sul record partner):

- **Accredito**: scatta **solo quando un acquisto con quel `partnerCode` raggiunge lo stato "ritirato"** (mai prima) — il 10% del prezzo del servizio viene aggiunto al saldo. Un flag `creditIssued` sull'acquisto impedisce un doppio accredito se lo stato viene risincronizzato più volte, indipendentemente da quale dei due percorsi lo porta a "ritirato" (conferma del turista o azione manuale dello staff da CRM).
- **Riscatto sul canone**: bottone "Usa credito per il canone" nell'area partner — genera la prossima fattura e applica il credito disponibile fino a coprirla per intero (mai un importo negativo); l'eventuale resto rimane sul saldo per la fattura successiva (azione `redeem-credit-for-invoice`).
- **Codici sconto per i clienti**: bottone "Genera codice sconto per un cliente" — crea un codice monouso (store Blobs `partner-discount-codes`) che il partner comunica direttamente al cliente. Generare il codice non consuma ancora credito: il costo si scala solo quando il codice viene realmente usato.
  - Il turista lo inserisce al checkout (campo "Hai un codice sconto partner?" nella schermata di conferma prezzo) — validato e consumato da `netlify/functions/partner-discount.js`.
  - Se valido: sconto del 10% sulla sola fee di servizio, il codice viene marcato come usato (con email del turista), e **esattamente quell'importo** viene scalato dal credito del partner.
  - Se il partner non ha credito sufficiente in quel momento, il codice **non viene consumato** e il turista vede un errore chiaro — nessuno sconto "a debito".

Nel CRM, la tab Partner & Commissioni mostra credito disponibile e conteggio codici sconto generati/usati per ogni partner.

---

## Sicurezza e backend

### Netlify Functions (`netlify/functions/*.js`)

| Function | Cosa fa |
|---|---|
| `classify.js` | Proxy verso l'API Claude (Anthropic) per la classificazione doganale delle foto/descrizioni — nasconde `ANTHROPIC_API_KEY` dal browser. |
| `crm.js` | Backend centrale del CRM: elenco/aggiornamento acquisti, anagrafica partner, crediti, codici sconto partner, documenti legali, blocklist, contenuti Documenti/Pitch Deck/Manuale. Nessuna password propria (solo alcuni contenuti restituiti richiedono che il client li mostri dietro `KIT_VAULT_PASSWORD` verificata altrove). |
| `investor-content.js` | Contenuto riservato per investitori, mostrato su `investitori.html` (sito pubblico, non CRM) dietro `INVESTOR_PASSWORD`. |
| `kit-vault.js` | Elenco e download dei file del kit riservato (`netlify/functions/kit-riservato/`), dietro `KIT_VAULT_PASSWORD`; protetto da path traversal. |
| `partner-discount.js` | Valida e consuma i codici sconto partner al checkout del turista; scala il credito del partner esattamente dell'importo scontato. |
| `partner-stats.js` | Verifica un codice partner e restituisce statistiche reali (vendite, valore, commissione, credito) aggregate dallo store centrale. |
| `promo.js` | Valida e consuma i codici invito per l'offerta breakeven. |
| `save-purchase.js` | Salva/aggiorna un acquisto nello store centrale `purchases`; applica il blocco automatico anti-abuso; accredita il partner quando lo stato diventa "ritirato" tramite questo percorso (conferma del turista). |

### Rate limiting

Le funzioni esposte al pubblico (`classify.js`, `kit-vault.js`, `partner-stats.js`, `partner-discount.js`, `save-purchase.js`) applicano tutte lo stesso schema: **massimo 20 richieste ogni 60 minuti per indirizzo IP**, tracciato nello store Blobs `rate-limits`. Oltre il limite, l'endpoint risponde `429`.

### Variabili d'ambiente (impostate su Netlify, mai in questo repository)

| Variabile | A cosa serve |
|---|---|
| `ANTHROPIC_API_KEY` | Chiave per le chiamate a Claude (classificazione, packaging check, rilevamento firma). |
| `KIT_VAULT_PASSWORD` | Password per le tab Documenti / Pitch Deck (contenuto non protetto in realtà, vedi sopra) / Legale / Riservato nel CRM. |
| `INVESTOR_PASSWORD` | Password per la pagina investitori pubblica (`investitori.html`). |
| `NETLIFY_BLOBS_SITE_ID` / `NETLIFY_BLOBS_TOKEN` | Credenziali di accesso a Netlify Blobs, usate da tutte le funzioni che leggono/scrivono dati. |

Nessun valore reale di queste variabili è mai scritto in questo file o nel codice del repository — sono configurate solo nel pannello Netlify del sito.

### Blocklist

Un solo store (`blocklist`), condiviso tra due punti di scrittura: il blocco automatico in `save-purchase.js` (secondo acquisto senza mai essere stato abbonato) e il blocco manuale dello staff dalla tab Bloccati del CRM (`block-customer`/`unblock-customer` in `crm.js`). Ogni voce registra email, motivo, se è automatico o manuale, e la data.
