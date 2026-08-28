# Manuale del progetto — Touch&Go

Documentazione funzionale di tutto quello che è stato costruito finora. Aggiornato leggendo lo stato reale del codice (non solo i messaggi di commit) — se qualcosa qui non corrisponde più a quello che vedi nell'app o nel CRM, il codice ha ragione e questo file va aggiornato (vedi CLAUDE.md).

**Questo file vive nel repository `touchandgo-demo` (pubblico) e documenta la parte pubblica del progetto** — app turista/partner e sito marketing. Il CRM interno, l'area investitori e il kit riservato sono stati spostati in un repository separato e privato, `touchandgo-internal`, che ha una propria copia di questo manuale. Vedi "Due repository" più sotto.

---

## Panoramica

**Touch&Go** è una piattaforma che permette a un turista in Italia di fotografare un acquisto in negozio, farlo classificare automaticamente (dogana, peso, dimensioni) da un'AI, lasciarlo in negozio con un QR, e riceverlo spedito a casa — con esenzione IVA export gestita in automatico. I negozi partner guadagnano una commissione su ogni vendita generata tramite il loro codice.

### Due repository

Il progetto è diviso in due repository GitHub, deployati come due siti Netlify separati e indipendenti:

| Repository | Visibilità | Contiene |
|---|---|---|
| **`touchandgo-demo`** (questo repo) | Pubblico | App turista/partner e sito marketing — tutto quello descritto nel resto di questo manuale. |
| **`touchandgo-internal`** | Privato | CRM interno (`dist/site/admin.html`), area investitori (`dist/site/investitori.html` + `netlify/functions/investor-content.js`), kit riservato (`netlify/functions/kit-riservato/`: NDA, cap table, SAFE, modello economico...), `netlify/functions/crm.js`, `netlify/functions/kit-vault.js`. |

I due deploy condividono lo stesso backend dati: stesse credenziali Netlify Blobs (`NETLIFY_BLOBS_SITE_ID`/`NETLIFY_BLOBS_TOKEN`) configurate su entrambi i siti Netlify, quindi acquisti/partner/blocklist restano un'unica fonte di verità vista da entrambi, anche se il codice che li legge e scrive vive ora in due repository diversi.

Per dare all'app/sito pubblico accesso alle poche operazioni sui dati condivisi che gli servono (sincronizzare lo storico acquisti, registrare un partner self-service, riscattare credito, generare un codice sconto, confermare la lettura di un banner) senza doverle far passare dal CRM interno, questo repository ha una propria function, `netlify/functions/sync.js` — vedi "Netlify Functions" più sotto. `crm.js`, rimasto nel repository privato, copre tutto il resto (elenco completo, gestione partner/documenti/legale/blocklist, contenuti riservati).

Ogni volta che una modifica tocca contemporaneamente comportamento pubblico e CRM, aggiorna entrambe le copie di `MANUALE.md` — possono divergere silenziosamente altrimenti.

Il progetto pubblico è composto da due parti, servite dallo stesso sito:

| Parte | Percorso | Cos'è |
|---|---|---|
| **App turista + partner** | `dist/index.html` + `dist/assets/app.js` | L'app vera e propria (una sola pagina, un solo file JS). Ha due modalità selezionabili in alto: "Turista" e "Partner". |
| **Sito marketing** | `dist/site/index.html`, `come-funziona.html`, `privacy.html`, `termini.html` | Sito pubblico: presentazione prodotto, demo animata "Come funziona", registrazione partner self-service, termini e privacy. |

**Stack tecnico**, in breve:

- **Nessun framework, nessun build step.** `app.js` è JavaScript scritto a mano (vanilla JS), caricato direttamente dal browser. I file dentro `dist/` sono quelli serviti in produzione — si editano direttamente, non c'è un passaggio di compilazione da un'altra cartella sorgente.
- **Backend**: [Netlify Functions](https://docs.netlify.com/functions/overview/) — piccoli file Node.js in `netlify/functions/*.js`, ognuno è un endpoint HTTP indipendente (es. `/.netlify/functions/sync`). Configurati in `netlify.toml`.
- **Database**: [Netlify Blobs](https://docs.netlify.com/blobs/overview/) — uno storage chiave/valore gestito da Netlify, niente database tradizionale da amministrare. Ogni "store" (`purchases`, `partners`, `legal`, `blocklist`, `promo`, `partner-discount-codes`, `rate-limits`, `customs-reference`) è una collezione separata di record JSON, condivisa con il repository privato (vedi "Due repository" sopra).
- **AI**: Claude (Anthropic) per la classificazione doganale delle foto, la stima delle dimensioni dell'imballo e il rilevamento firma sui documenti d'identità. La chiave `ANTHROPIC_API_KEY` resta solo sul server (funzione `classify.js`), mai esposta al browser.
- **QR code**: generati al volo tramite il servizio esterno `api.qrserver.com` (nessuna libreria QR interna).
- **PWA minima**: `dist/sw.js` mette in cache la shell dell'app (schermate, non i dati) così l'app resta consultabile offline; le chiamate AI/QR/geolocalizzazione richiedono sempre connessione. La app shell (`/`, `/index.html`, `/assets/app.js`, `/assets/style.css`) usa strategia **network-first**: prova sempre prima la rete e aggiorna la cache, usando la cache solo come fallback offline — così un turista vede subito l'ultima versione deployata al primo caricamento dopo un deploy, senza dover ricaricare due volte. Tutte le altre risorse restano invece **cache-first con aggiornamento in background** (risposta immediata dalla cache se presente, rete in parallelo per aggiornarla).

---

## Sito marketing (`dist/site/`)

### Pagina "Come funziona" (`dist/site/come-funziona.html`)

Pagina pubblica standalone, separata da `index.html`: una demo animata a slide del percorso d'acquisto (stesso copy/contenuto dell'onboarding in-app, vedi "Onboarding animato" più sotto), pensata per essere guardata anche da chi non ha ancora aperto l'app.

- **Collegata dal sito**: dentro la sezione `#come-funziona` di `dist/site/index.html`, il bottone "Guarda la demo animata →" apre `come-funziona.html` in una nuova scheda (`target="_blank"`).
- **CTA finale**: l'ultima slide ha un link "Apri l'app →" (`#app-link-cta`). Come il resto del sito, punta alla radice dell'app tramite lo stesso script `APP_URL` copiato in ogni pagina (`var APP_URL = "/"`, applicato a `#app-link-top`, `#app-link-hero`, `#app-link-cta`) — nessun dominio Netlify scritto a mano, così il link resta corretto qualunque sia il dominio effettivo del sito.
- **Wordmark del brand**: stessa identica soluzione visiva dell'onboarding in-app (vedi "Onboarding animato" più sotto) — "Touch&Go" (`#wordmark`) centrato in alto, persistente su tutte e 4 le slide, non tradotto.

### SEO e indicizzazione

- **`dist/robots.txt`**: permette tutto di default (`Allow: /`), esclude esplicitamente `/site/admin.html` e `/site/investitori.html` (percorsi che in realtà non vivono in questo deploy — vedi sotto — ma escluderli comunque qui è una protezione in più se mai finissero sulla stessa origine), e referenzia `dist/sitemap.xml`.
- **`dist/sitemap.xml`**: elenca solo le pagine pubbliche reali servite da questo repository — l'app (`/`), `dist/site/index.html`, `come-funziona.html`, `termini.html`, `privacy.html`. Aggiornalo se si aggiungono o rimuovono pagine pubbliche.
- **Open Graph**: `og:title`/`og:description`/`og:type`/`og:url`/`og:locale` presenti su `dist/index.html` (l'app), `dist/site/index.html` e `dist/site/come-funziona.html`. Nessun `og:image`: non esiste ancora un'immagine di anteprima dedicata — va aggiunto quando ce ne sarà una reale, mai un URL inventato.
- **Dati strutturati**: `dist/site/index.html` include un blocco `<script type="application/ld+json">` (schema.org `Service`, con `provider` `Organization`) — nome, descrizione e area servita ripresi dal copy già pubblicato sul sito stesso (nessun dato inventato: niente indirizzo completo o telefono, mai pubblicati).

### Contatti (`#contatti`)

Sezione del sito marketing (`dist/site/index.html`), tra "Chi siamo" e la CTA finale, collegata dal link "Contatti" nel footer (in precedenza puntava a `href="#"`, senza destinazione). Un solo bottone mailto verso `partnership@touchandgo.it` — la stessa casella già usata per Reseller/White Label (`#rivenditori`) e per l'agenzia (`#agenzie`): nessun nuovo indirizzo introdotto. Rimanda anche, in un paragrafo di nota sotto il bottone, alle sezioni `#partner` e `#rivenditori` più sopra per chi cerca specificamente una partnership commerciale.

### "Hai già un account partner? Accedi" (sezione `#partner`)

Il bottone hero "Sono un partner" scrolla a `#partner`, che mostra piani e il form di registrazione **nuovo** partner — non c'era però nessun percorso per un partner già registrato che voleva solo accedere: l'unica UI di login (`PartnerLoginAndHistory()`) esiste già nell'app (`dist/assets/app.js`), ma non era raggiungibile dal sito.

- Link "Hai già un account partner? Accedi →" sotto la nota commissioni in `#partner`, che apre l'app con `?mode=partner` in coda all'URL (stesso `APP_URL` usato per gli altri link del sito).
- In `app.js`, `captureModeFromUrl()` (chiamata all'avvio, stesso pattern di `capturePartnerCode()`/`capturePromoCode()`) legge il parametro `mode` e, se vale `"partner"`, imposta `state.mode = "partner"` prima del primo render — l'app si apre quindi già in modalità Partner, con `PartnerLoginAndHistory()` (login) visibile subito, senza duplicare quella UI sul sito.
- Stile dedicato `.btn-outline-light` (bordo/testo scuro) invece di riusare `.btn-outline` — quest'ultimo ha testo chiaro pensato solo per lo sfondo scuro dell'hero: su `#partner`, a sfondo chiaro, sarebbe stato quasi illeggibile.

**Nota importante sul CRM/investitori**: `dist/site/admin.html` e `dist/site/investitori.html` **non esistono in questo repository** — vivono nel repository/sito separato `touchandgo-internal` (vedi sotto e "Due repository" in Panoramica). Il `Disallow` in `robots.txt` qui sopra non ha quindi alcun effetto reale su quelle pagine (un `robots.txt` vale solo per l'origine che lo serve). **Fatto**: `touchandgo-internal` ha un proprio `robots.txt` che blocca l'intero dominio (`Disallow: /` — lì non c'è nulla di pubblico da elencare, quindi niente `sitemap.xml`) ed entrambi i file hanno già `<meta name="robots" content="noindex, nofollow">` nell'`<head>` — vedi la copia di `MANUALE.md` di quel repository, sezione "SEO e indicizzazione".

---

## Temi lime/corallo — anteprime funzionanti (TOU-21)

Le due varianti estetiche generate nel weekend con Claude Design (accento verde-lime `#C9F24D` e corallo/arancione `#FF6B4A`) sono applicate come **temi runtime veri** sull'app turista reale — stessa identica logica applicativa di produzione (fotocamera, classificazione AI, flusso di ritiro/spedizione, dati da Netlify Blobs), non uno snapshot statico. La PR che ha introdotto TOU-21 prevedeva inizialmente due pagine HTML statiche non interattive: quel materiale è stato sostituito da questa infrastruttura di temi dopo che Giuseppe ha chiarito lo scope corretto (versioni funzionanti, non mockup).

- **`dist/design-preview/lime/index.html`** e **`dist/design-preview/corallo/index.html`** — shell HTML quasi identiche a `dist/index.html`, che caricano lo **stesso** `dist/assets/app.js` e `dist/assets/style.css` di produzione, con in più: un attributo `data-theme` sull'`<html>` (nessun ruolo funzionale, solo documentativo/per debug) e un secondo foglio di stile caricato dopo `style.css` — `dist/assets/theme-lime.css` o `dist/assets/theme-corallo.css` — che sovrascrive un sottoinsieme di custom property CSS. Zero duplicazione di codice applicativo: un bug fix in `app.js` si riflette automaticamente in tutti e tre gli ambienti (produzione + 2 temi).
- **`dist/assets/style.css`** — tutti i colori sono custom property su `:root` (design token), col valore di default identico al colore letterale che sostituivano: il refactor da solo non ha cambiato un pixel della produzione (verificato confrontando ogni selettore/proprietà, dopo risoluzione delle variabili, contro la versione precedente del file — zero differenze a parte un caso di maiuscole/minuscole nello stesso hex).
- **`dist/assets/theme-lime.css` / `theme-corallo.css`** — sovrascrivono solo i token "invertibili": superficie principale (`--paper`/`--cream`/`--surface`/`--line`), testo principale (`--text` e varianti), e la famiglia accento (`--gold`/`--gold-soft`/`--gold-hot`/`--gold-deep`/`--clay`). Palette di superficie/testo presa dai due bundle Claude Design ricevuti (estratta dagli hex più ricorrenti nel bundle, non da un `:root` esplicito — i bundle sono export proprietari di Claude Design senza CSS leggibile direttamente); `--gold-deep` è invece calcolato (una tonalità più scura dell'accento primario), perché i bundle non contenevano una variante "deep" separata. **Font**: non modificati in questa fase — non è stato possibile estrarre in modo affidabile un font diverso dai bundle (contenuto reso via JS, non CSS leggibile), quindi entrambi i temi usano ancora Cormorant Garamond + Montserrat.
- **Cosa NON cambia tra i temi, di proposito**: la "chrome" scura esistente (header, capture-card, hs-block, pack-card, promo-card-inline, mode-toggle, cover-screen, onboarding) resta scura in tutti i temi — è già la superficie più scura della palette, coerente con lo sfondo quasi-nero dei bundle Claude Design; i banner di stato (successo/avviso/errore/tip/assistant-tip) restano chiari in tutti i temi, per leggibilità garantita indipendentemente dall'inversione chiaro/scuro della superficie principale; l'overlay della fotocamera (`.viewfinder-overlay`) resta nero in tutti i temi.
- **Come si raggiungono**: solo visitando esplicitamente `/design-preview/lime/` o `/design-preview/corallo/` — non collegate da nessun link/nav reale, non elencate in `dist/sitemap.xml` (`<meta name="robots" content="noindex, nofollow">` su entrambe le pagina). Stesso backend/dati di produzione (stesso dominio → stesse Netlify Functions, stesso Netlify Blobs — vedi "Netlify Functions" più sotto): un acquisto registrato in un tema è visibile anche negli altri.
- **Fase 2 (area partner, completata)**: nessuna nuova infrastruttura necessaria — l'area partner (login, dashboard, statistiche, upgrade piano, credito, QR negozio) usa le stesse classi CSS già tokenizzate in fase 1, quindi ha ereditato i due temi automaticamente. Verificata schermo per schermo (login con errore, dashboard con storico/andamento mensile, generazione QR) in entrambi i temi via rendering reale in browser. Due bug trovati e corretti in questo giro, entrambi bypassavano il sistema di token:
  - Un colore inline hardcoded (`#B3261E`, indicatore di andamento negativo in `PartnerTrendSection`) — ora `var(--danger)`, già tokenizzato e già usato altrove per testo di errore.
  - Il QR code (sia quello dell'area partner sia quello di deposito lato turista, `QueuedScreen`) è un'immagine raster generata da un servizio esterno (`api.qrserver.com`) con colori passati come parametri URL — "cotti" nel PNG, quindi non seguivano i temi. `qrCodeUrl()` (nuova funzione condivisa in `app.js`) li legge ora a runtime da `--ink`/`--paper` (via `getComputedStyle`), così il QR resta coerente col tema attivo invece di restare sempre chiaro dentro una card ormai scura.
- **Fasi successive** (non ancora fatte, vedi Linear TOU-21): CRM interno (repository `touchandgo-internal`), sito pubblico — stesso modello di design token, PR separate.

---

## CRM interno, area investitori e kit riservato

Vivono nel repository privato `touchandgo-internal`, non in questo repository — vedi "Due repository" in Panoramica. Il CRM (`dist/site/admin.html`) è il gestionale per lo staff (acquisti, partner, documenti, legale, blocklist...); l'area investitori (`dist/site/investitori.html`) e il kit riservato (NDA, cap table, SAFE, modello economico, pitch deck) sono contenuti confidenziali dietro password, e **sono esclusi dall'indicizzazione direttamente in quel repository** (meta `noindex` su entrambi i file + `robots.txt` del sito `touchandgo-internal` con `Disallow: /` sull'intero dominio — non presenti in questo repository pubblico, dove non servirebbero). La documentazione tab-per-tab del CRM vive nella copia di `MANUALE.md` di quel repository, non qui.

Quello che resta rilevante da questo lato (repository pubblico):

- Il CRM legge/scrive gli stessi store Netlify Blobs (`purchases`, `partners`, `blocklist`, ecc.) usati dall'app pubblica — stesso backend dati, vedi "Due repository".
- Le azioni che l'app/sito pubblico devono poter chiamare senza passare dal CRM (sincronizzare lo storico, registrare un partner, riscattare credito, generare un codice sconto, confermare un banner) vivono in `netlify/functions/sync.js`, in questo repository — vedi "Netlify Functions" più sotto.
- Quando lo staff aggiorna lo stato di un acquisto dal CRM (es. "Segna ritirato", cambio punto di ritiro), il turista lo vede nell'app tramite le sincronizzazioni descritte in "Stati di un acquisto" e "Sincronizzazione dello storico acquisti tra dispositivi" più sotto.

---

## App turista

Tutta l'esperienza vive in `dist/assets/app.js`, un'unica applicazione a schermate (`state.screen`) senza router — ogni funzione tipo `HomeScreen()`, `ResultScreen()` ecc. costruisce il DOM della schermata corrente e viene richiamata da `render()`.

### Onboarding animato

Prima della schermata Cover, il turista vede una sequenza animata a 4 slide che spiega come funziona il servizio (`OnboardingScreen()`), con lo stesso copy della sezione "Come funziona" del sito (`dist/site/index.html`):

1. Fotografa l'oggetto (chip **3s** — secondi per la stima AI)
2. Confermi ritiro e destinazione
3. Lasci l'oggetto con un QR
4. Concludi e consolidiamo (chip **1** — ordine unico di ritiro)

- **Quando si mostra automaticamente** (TOU-14): solo **al lancio dell'app, per chi non ha ancora effettuato l'accesso (registrazione) su questo dispositivo** — cioè finché non esiste né un profilo salvato (`state.touristEmail` non valorizzato dopo `loadProfile()`) né il flag persistente `tg_onboarded` in `localStorage`. Una volta completata la registrazione una prima volta (`IdentifyScreen()` → `saveProfile()`, che marca `tg_onboarded = "1"`), l'onboarding **non riparte più in automatico ad alcun avvio successivo — nemmeno dopo un "Resetta l'account"** (`resetEverything()` azzera profilo, acquisti e indirizzi ma non tocca mai `tg_onboarded`, apposta): si salta direttamente a `state.screen = "cover"` (o `"biometric-lock"` se applicabile). Alla fine della sequenza (ultima slide, sia per timeout automatico che per tap a destra) o al tap su **"Salta"**, si passa comunque a `state.screen = "cover"`. A differenza del mockup di riferimento (pensato come demo a loop infinito), la sequenza ha quindi una vera fine.
- **Rivedibile su richiesta**: in `DashboardScreen()` ("La tua spesa"), un link **"Rivedi come funziona"** richiama `restartOnboarding()` (resetta l'indice di slide e imposta `state.screen = "onboarding"`) — funziona sempre, indipendentemente da `tg_onboarded` o dallo stato di registrazione. Dashboard è raggiungibile da entrambi i profili di turista (link nel `Footer()`, sempre visibile in Home), quindi resta un punto d'accesso naturale per tutti.
- **Schermata a sé stante, senza il chrome normale dell'app**: `render()` intercetta `state.screen === "onboarding"` prima di appendere `Header()`, quindi niente barra Turista/Partner, niente banner offline — solo lo "stage" scuro immersivo dedicato.
- **Navigazione**: tap a sinistra/destra per tornare indietro o avanzare manualmente; barra di progresso a segmenti che si riempie da sola ogni ~4200ms (`ONBOARDING_SLIDE_MS`) per l'avanzamento automatico; dots in basso per la posizione corrente.
- **Pulsante "Salta"**: a differenza del mockup (dove era discreto in basso), qui è in un angolo fisso in alto, accanto al selettore lingua, visibile fin dal primo istante su ogni slide.
- **Wordmark del brand**: "Touch&Go" (`.ob-wordmark`) è sempre visibile, centrato in alto, su una riga propria tra la fila live-tag/selettore lingua e la barra di progresso — persistente su tutte e 4 le slide (fuori dal ciclo di `slides`, stesso principio della barra di progresso). Prima di questa modifica il nome del brand non compariva mai a schermo nella sequenza, solo nel `<title>` della pagina. Non tradotto: resta "Touch&Go" identico in italiano e in inglese.
- **Multilingua**: usa lo stesso meccanismo `I18N`/`t()`/`state.lang` di tutto il resto dell'app (non un dizionario isolato) — cambiare lingua durante l'onboarding richiama `setLang()` (che fa un `render()` completo) ma la sequenza riprende dalla slide corrente invece di ripartire da capo, grazie a un indice di slide mantenuto a livello di modulo (`onboardingSlide`).
- **Stile**: variabili CSS condivise con il resto dell'app (`--ink`, `--gold`, `--gold-soft`, `--gold-deep`, `--muted`, `--line`, `--display`, `--body`) più una nuova `--gold-hot` per l'accento dorato più acceso usato nel mockup.

### Assistente conversazionale "Chiedi a Touch&Go"

**Fase 1**: il pitch deck (`TOUCHandGO_Allin_One.html`) promette già un "assistente in 4 lingue" come parte del piano "Touch&Go Black" (€199/soggiorno, UHNWI) — ma quel piano non esiste ancora come piano reale nell'app (oggi esistono solo tariffa piena/abbonamento base, `FULL_FEE`/`SUBSCRIBED_FEE`). Questa Fase 1 costruisce l'assistente vero **disponibile a tutti i turisti**, senza vincolarlo a nessun piano o abbonamento — la segmentazione per piano, se mai arriverà, sarà una fase successiva.

- **Sempre raggiungibile**: pulsante "💬 Chiedi a Touch&Go" dentro `Header()`, quindi visibile su ogni schermata del percorso turista (Home, Destination, Result, Identify, Documents, Dashboard, PackageCheck, ecc.) — non in modalità Partner. Stesso meccanismo già usato per rendere sempre visibile il selettore lingua IT/EN.
- **Overlay, non una schermata**: al tap si apre `AssistantChatModal()` sopra la schermata corrente (bottom sheet su mobile, card centrata da tablet in su) — chiudendola si ritorna esattamente dove ci si trovava, senza perdere l'input in corso su altre schermate.
- **Due modalità** (`netlify/functions/assistant.js`, stesso pattern di `classify.js`: stessa `ANTHROPIC_API_KEY`, stesso rate limiting):
  - **"Fai una domanda"** (`mode: "domanda"`) — il system prompt è costruito lato server con i fatti reali del servizio (fee €39/€19, fasce di spedizione a 3 zone con relativi tempi di consegna, esenzione IVA export Art. 8 DPR 633/72, i 4 stati di un acquisto, l'offerta prima spedizione senza fee) **presi dal codice reale** (`FULL_FEE`, `SUBSCRIBED_FEE`, `SHIPPING_RATES` in `dist/assets/app.js`), non inventati — se quei valori cambiano, vanno aggiornati anche in `assistant.js`.
  - **"Comunica col negozio"** (`mode: "traduci_per_negoziante"`) — traduzione bidirezionale: un messaggio del turista in qualunque lingua diventa una frase chiara in italiano per il negoziante; un messaggio già in italiano viene tradotto verso la lingua del turista (`state.lang` come indicazione, ma il contenuto del messaggio ha sempre l'ultima parola).
  - Il system prompt **non arriva mai dal client** — è costruito interamente in `assistant.js`, per non essere manipolabile da chi chiama l'endpoint.
- **Interfaccia**: campo di testo con lo stesso `addVoiceButton()` già usato altrove per la dettatura vocale, selettore di modalità, risposta mostrata in una bolla di chat. Etichette tradotte nello stesso dizionario `I18N`/`t()` di tutta l'app — le risposte dell'AI restano nella lingua rilevata dal messaggio, non tradotte lato client (sono già multilingua per natura).

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

### Mirino fotocamera con rumore otturatore (TOU-20)

Le due schermate che scattano una foto — **Home** (foto dell'oggetto, punto 2 sopra) e **verifica imballo** (`PackageCheckScreen`, punto 7 sopra) — non delegano più interamente alla fotocamera nativa del telefono: `openCameraViewfinder()` in `app.js` apre un vero mirino in-app via `getUserMedia`.

- **UI a mirino**: overlay a schermo intero (`.viewfinder-overlay`) con anteprima video live, una cornice ad angoli in stile reflex (`.viewfinder-frame`, quattro `.vf-corner` dorati) invece di un semplice riquadro generico, pulsante di scatto circolare in basso (`.vf-shutter`) e chiusura in alto a destra (`.vf-close`). **Confermato funzionante su dispositivo reale da Giuseppe** — questa parte non è stata toccata dal secondo giro di fix qui sotto.
- **Icona placeholder pre-tap** (solo schermata **Home**, non `PackageCheckScreen`): un'icona a iride/diaframma fotografico (`apertureIconMarkup()`, SVG con 6 lamelle reali via `<path>`, non un'immagine raster — palette oro/nero esistente), mostrata aperta di default. Al tap sul riquadro "Fotografa l'oggetto" le lamelle si chiudono (classe CSS `.closing` su `.aperture-icon`, transizione ~230ms) in sincrono col rumore dello scatto, poi si apre il mirino vero e proprio — l'interpretazione di "il momento dello scatto" (Giuseppe) come questo tap, dichiarata esplicitamente: il pulsante di scatto reale vive dentro l'overlay a schermo intero del mirino, dove questo riquadro/icona non è più visibile, quindi non può essere il trigger dell'animazione. `PackageCheckScreen` mantiene per ora l'emoji 📷 originale (fuori dallo scope segnalato da Giuseppe).
- **Rumore di scatto**: `playShutterSound()` sintetizza via Web Audio API due brevi impulsi di rumore filtrato (apertura/chiusura otturatore) — non un file audio esterno: nessun asset da scaricare né da licenziare, funziona anche offline nella PWA. **Bug corretto**: creava un nuovo `AudioContext` ad ogni scatto senza mai controllarne lo stato — su Safari/Chrome mobile un `AudioContext` può nascere `"suspended"` anche dentro un gesto utente reale, e senza un `resume()` esplicito i suoni programmati non si sentono e non sollevano alcun errore (esattamente il sintomo riportato: "nessun suono, neanche l'ombra", nessun errore in console). Ora un solo `AudioContext` condiviso e riusato (creato al primo scatto), con `resume()` esplicito quando risulta sospeso prima di programmare il suono; eventuali errori finiscono in `console.warn`, non più inghiottiti in silenzio.
- **Cattura**: al tap, il fotogramma corrente del video viene disegnato su un `<canvas>` e convertito in JPEG (`canvas.toDataURL`) — stesso formato (data URL) che l'app riceveva già da `FileReader` sui file dell'input nativo, quindi tutto il codice a valle (classificazione AI, verifica imballo) resta invariato.
- **Fallback automatico**: se `getUserMedia` non è disponibile o il permesso fotocamera viene negato (webview datate, contesti senza fotocamera), si ricade sul precedente `<input type="file" capture="environment">` — l'input nativo resta comunque presente in pagina per questo — senza alcuna UI a mirino ma senza rompere il flusso di scatto. Il fallback non è più silenzioso: `console.warn` registra il motivo reale (`err` di `getUserMedia`, o l'assenza dell'API) per la diagnosi da remoto (es. `chrome://inspect`), e un avviso discreto a schermo — "Fotocamera del dispositivo in uso" (`.camera-fallback-toast`, stesso stile/comportamento del toast di dettatura vocale non riconosciuta, auto-nascosto dopo 4s) — conferma anche senza aprire la Console che il fallback è scattato davvero.

### Effetto "schizzo architettonico" sulla foto di copertina

La schermata Cover (`CoverScreen()`, `dist/assets/app.js`), quando è disponibile una foto reale del punto di ritiro (`state.locationPhoto`), non la mostra fotorealistica: la rende come uno schizzo a linee (bordi, non colori pieni — come un software di render d'interni), tinto nei colori del brand.

- **Filtro SVG `#sketchFilter`**: definito ed iniettato una sola volta in `document.body` da `injectSketchFilter()` (in cima ad `app.js`, chiamata subito dopo la definizione) — **non** dentro `#app`, perché `render()` svuota `#app` a ogni chiamata (`app.innerHTML = ""`) e distruggerebbe il filtro ad ogni cambio schermata. La catena di filtri: desatura l'immagine (`feColorMatrix` in scala di grigi) → rileva i bordi (`feConvolveMatrix`, kernel di sharpening/edge-detection) → inverte (bordi scuri su sfondo chiaro diventano bordi chiari su sfondo scuro) → aumenta il contrasto (`feComponentTransfer` con correzione gamma) → tinge (`feColorMatrix` finale, che interpola per canale tra il colore delle linee — oro brand, dove il bordo è marcato — e il colore di sfondo — bruno scuro caldo, nelle zone piatte — in base alla luminanza: non una tinta piatta, il colore dipende davvero da dov'è un bordo).
- **Su cosa si applica**: solo su `.cover-bg-photo`, un layer `<div>` separato dedicato allo sfondo (con `filter:url(#sketchFilter)` in `dist/assets/style.css`) — mai sulla didascalia della città sopra, che resta su un elemento diverso e quindi sempre leggibile senza distorsioni da rilevamento bordi.
- Se non c'è una foto disponibile (`state.locationPhoto` assente), la Cover mostra invece un semplice sfondo a gradiente (classe `.no-photo`) — il filtro non entra in gioco.

### Punto di ritiro: rilevamento automatico vs scelta manuale

Il punto di ritiro (`state.pickupPoint`) viene rilevato all'avvio da GPS o, in mancanza di permesso, da stima di rete (`loadLocation()`) — ma **solo se il turista non ne ha già scelto uno a mano** in una sessione precedente:

- **Persistenza della scelta manuale**: modificando il campo in `PickupField()` (usato in `DestinationScreen`), ogni valore digitato viene salvato subito in `localStorage` (`tg_manual_pickup`). All'avvio successivo, se questo valore esiste, diventa il `pickupPoint` iniziale e `loadLocation()` **non viene richiamata automaticamente** — altrimenti sovrascriverebbe sempre la scelta manuale, impedendo di continuare ad aggiungere acquisti da una città diversa da dove ci si trova in quel momento (es. il turista ha già lasciato la città ma vuole ancora registrare acquisti fatti lì).
- **Tornare al rilevamento automatico**: pulsante "📍 Usa la mia posizione attuale" accanto al campo — cancella `tg_manual_pickup` e richiama `loadLocation()` su richiesta esplicita. Necessario chiamare `render()` esplicitamente al termine (a differenza della chiamata di avvio, `loadLocation()` da sola non ri-renderizza quando ci si trova sulla schermata Destination — il suo render automatico interno è limitato a Cover/Home).
- **Città recenti**: le ultime 5 città distinte usate come punto di ritiro (manuali o rilevate, tramite `addRecentPickup()`) restano in `localStorage` (`tg_recent_pickups`) e compaiono come chip cliccabili sotto il campo, per non dover ridigitare una città già usata. Aggiunte all'elenco solo al blur del campo (non ad ogni tasto premuto, per non riempirlo di città a metà digitate) o al click su un chip/su "Usa la mia posizione attuale" una volta risolta.

### Dettatura vocale nei campi del form

Per i turisti di fretta o con difficoltà a digitare, alcuni campi testuali possono essere compilati parlando invece di scrivere, tramite la Web Speech API nativa del browser (`SpeechRecognition`/`webkitSpeechRecognition` — nessun servizio esterno, nessun costo per chiamata). La funzione riutilizzabile `addVoiceButton(inputElement)` in `dist/assets/app.js`:

- se supportata, aggiunge un'icona microfono (🎤) accanto al campo; al tap avvia il riconoscimento con `lang = navigator.language` (mai forzato a "it-IT", così il turista può dettare nella propria lingua) e mostra un feedback visivo (pulsazione dorata) mentre ascolta;
- il testo trascritto viene accodato al contenuto già presente nel campo (utile per dettare in più riprese), non lo sostituisce;
- se il permesso microfono viene negato, mostra un avviso breve e non bloccante sotto il campo — la digitazione manuale resta sempre disponibile.

**Browser senza `SpeechRecognition`/`webkitSpeechRecognition` (bug corretto)**: prima di questa correzione, in assenza dell'API il bottone semplicemente **non veniva aggiunto** (`return` silenzioso) — nessuna icona, nessun messaggio, e nessuna indicazione al turista che la dettatura non fosse disponibile su quel browser (tipicamente Firefox, che non implementa mai l'API, o versioni di Safari con supporto storicamente incompleto). Investigato con un vero test end-to-end in `AssistantChatModal` (non solo lettura del codice): con l'API presente, sia il rendering del pulsante sia la gestione errori (es. permesso negato → toast) funzionano correttamente in quel contesto specifico — la causa reale era quindi esclusivamente l'assenza di un fallback per l'API non supportata, non un problema di rendering/gestione permessi limitato alla modale assistente. Ora il pulsante compare comunque (attenuato, classe `.voice-btn-unsupported`), con titolo/`aria-label` espliciti e un tap mostra "🎤 Dettatura vocale non disponibile su questo browser — puoi comunque scrivere qui a mano." tramite lo stesso `.voice-toast` già usato per gli altri errori.

È applicata a: nome del turista (`name-input`), etichetta indirizzo (`newaddr-label`), codice partner in `PartnerLoginAndHistory()` (`partner-code-input`), i campi via/città/CAP generati da `AddressFormFields()` (quindi automaticamente su ogni indirizzo, non solo uno) e il campo messaggio di `AssistantChatModal()`. **Non** è applicata al campo email — dettare un indirizzo email a voce è troppo impreciso.

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

### Conferma di consegna del turista (`deliveryConfirmedAt`)

"ritirato" indica solo che il corriere ha ritirato l'oggetto dal negozio — non che sia mai arrivato davvero a casa del turista. Non esisteva nessuna conferma successiva a quel punto.

- Per ogni acquisto "ritirato" **non ancora confermato**, `PurchaseHistoryList()` mostra nello storico un riquadro "Hai ricevuto il tuo pacco?" con un bottone "Sì, l'ho ricevuto". **Nessuna soglia di giorni**: mostrato sempre finché non confermato, non solo dopo N giorni dal ritiro — un ritardo del corriere non deve nascondere proprio la domanda che servirebbe a scoprirlo, e mostrarla presto costa zero al turista (può semplicemente ignorarla se il pacco non è ancora arrivato).
- Un solo tap (`confirmDelivery(item)`) è prova sufficiente — nessun altro dato richiesto al turista. Imposta `item.deliveryConfirmedAt` (timestamp ISO), salva localmente (`saveHistory`/`savePending`) e sincronizza l'intero oggetto al backend con lo stesso `syncPurchaseToCRM()` già usato per gli altri passaggi di stato — **non** una function/azione dedicata.
- Una volta confermato, il riquadro è sostituito da una nota "✓ Consegna confermata il ...".
- **Lato server (`save-purchase.js`)**: nessuna modifica alla logica di accredito commissione partner (righe intorno alla 115, invariate) — `deliveryConfirmedAt` è solo un campo aggiuntivo sullo stesso record. Dato che il salvataggio è una riscrittura completa del record (non un merge), se un client risincronizza l'acquisto senza portare `deliveryConfirmedAt` (es. da un altro dispositivo che ancora non lo sa) il valore già presente nello store viene **preservato** invece di essere cancellato — stesso principio già usato per `creditIssued`/`creditIssuedAmount`/`creditIssuedAt`. `applyRemotePurchaseUpdate()` include ora anche `deliveryConfirmedAt` tra i campi sincronizzati da `syncPurchaseUpdatesFromCRM()`, così una conferma data su un dispositivo compare anche sugli altri.
- **CRM** (`touchandgo-internal`, `dist/site/admin.js`): la vista Dettagli di ogni acquisto "ritirato" mostra ora "✅ Consegna confermata dal turista il ..." oppure "❓ Consegna non ancora confermata dal turista" — nessuna modifica lato backend necessaria in quel repository: `crm.js` (azione `list`) restituisce già l'intero record da Blobs, campo incluso automaticamente non appena il turista conferma.

### Sincronizzazione dello storico acquisti tra dispositivi

Lo storico (`state.purchaseHistory`) vive innanzitutto in `localStorage` (`tg_history`) — per questo, all'avvio, servono **due** sincronizzazioni distinte con `netlify/functions/sync.js`, non una sola:

- **`syncPurchaseUpdatesFromCRM()`** — aggiorna lo *stato* degli acquisti **già noti** al dispositivo, cercandoli per id (azione `get-purchases`, richiede esplicitamente la lista di id: non espone mai l'intero elenco acquisti). È così che compare il banner "punto di ritiro aggiornato" quando lo stato cambia da un altro dispositivo o dal CRM (repository privato).
- **`discoverPurchasesByEmail()`** — risolve un bug distinto: uno storico sincronizzato solo per id **non scopre mai** un acquisto che esiste già nel database ma non è mai stato salvato su *quel* dispositivo specifico (cambio telefono, dati del browser puliti, o un acquisto creato/associato da un altro dispositivo con la stessa email). Chiamata all'avvio, dopo che `loadProfile()`/`loadHistory()` hanno popolato `state.touristEmail`/`state.purchaseHistory`: interroga `sync.js` con l'azione `get-purchases-by-email` (email normalizzata minuscolo/trim), e per ogni acquisto restituito il cui id **non** è già presente in `state.purchaseHistory` lo aggiunge (non si limita ad aggiornare quelli già noti). Il risultato unito viene salvato in `tg_history` con lo stesso `saveHistory()` di sempre.

Lato server, `get-purchases-by-email` scansiona l'intero store `purchases` (`purchases.list()`) filtrando per `touristEmail` — a differenza delle altre azioni di `sync.js`, che non hanno rate limiting perché operano su id già noti al chiamante, questa accetta un'email libera: **rate limit 20 richieste/60 minuti per IP** (stesso schema delle altre function pubbliche, vedi "Rate limiting" più sotto), altrimenti risponderebbe 429 solo dopo, per evitare che l'endpoint diventi un modo per enumerare gli acquisti di indirizzi email arbitrari.

Questa function (`get-purchases`, `get-purchases-by-email`) e le altre di `sync.js` sono l'unico punto di contatto tra l'app pubblica e i dati normalmente gestiti dal CRM — vedi "CRM interno, area investitori e kit riservato" e "Netlify Functions" per il quadro completo.

### Dashboard "La tua spesa" (`DashboardScreen`)

Riepilogo di tutti gli acquisti del turista: numero totale, quanti in sospeso/ritirati, valore stimato degli oggetti acquistati, quanto speso in servizi Touch&Go, e — se applicabile — una riga di **risparmio legato all'abbonamento**:

- Se il turista **è già abbonato**: "Risparmiato abbonandoti" — quanto ha risparmiato sugli acquisti passati a tariffa piena, prima di abbonarsi.
- Se **non è abbonato**: "Risparmieresti abbonandoti" — incentivo calcolato sugli acquisti già fatti a tariffa piena.
- Il calcolo è: numero di acquisti a `pricingTier === "pieno"` × (`FULL_FEE` − `SUBSCRIBED_FEE`) = × €20. La riga non compare se il risparmio è €0 (nessun acquisto a tariffa piena), per non essere fuorviante.

### Dual pricing e offerte

Ogni preventivo mostra sempre, esplicitamente, sia il prezzo pieno che quello con abbonamento — mai un prezzo unico nascosto. Le costanti sono `FULL_FEE = €39` e `SUBSCRIBED_FEE = €19` di fee di servizio, più il costo del servizio di spedizione (calcolato a fasce di peso/volume per zona — domestico/transfrontaliero/worldwide, vedi `SHIPPING_RATES` — con un margine Touch&Go del 25% applicato sopra il costo grezzo del corriere, `SHIPPING_MARGIN`, sempre incluso nel valore mostrato).

Oltre al dual pricing standard, tre offerte possono ridurre il totale (mostrate in ordine di priorità, una alla volta):

1. **Codice invito — offerta breakeven**: un codice monouso (gestito nello store Blobs `promo`, validato/consumato da `netlify/functions/promo.js`) azzera la fee di servizio per quella spedizione — il turista paga solo il servizio di spedizione (margine 25% incluso, non più a costo vivo: solo la fee è azzerata). Il codice non è mai mostrato spontaneamente in app: si attiva solo con un link diretto (`?invito=CODICE`) o digitandolo manualmente.
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

Dal sito marketing (`dist/site/index.html`, sezione `#partner`): nome, email, scelta del piano. Chiama l'azione `register-partner` in `netlify/functions/sync.js`, che genera un codice partner univoco (iniziali del nome + numero casuale, es. `BR482`), salva il record e genera subito la prima fattura del canone.

Accanto al codice mostrato dopo la registrazione, un bottone **"Copia"** (`#ps-copy-code`) lo copia negli appunti con un tap — va poi reinserito nell'area partner dell'app per accedere, quindi evita errori di trascrizione a mano. Tre livelli di fallback in cascata se `navigator.clipboard.writeText()` non è disponibile o fallisce (contesti non sicuri, permesso negato): prova `document.execCommand("copy")` su una textarea temporanea; se anche questo fallisce, seleziona visivamente il testo del codice così l'utente può copiarlo da tastiera. In ogni caso il bottone conferma con un feedback temporaneo (2 secondi) — "Copiato ✓" se la copia è riuscita per davvero, "Selezionalo e copia" nel caso limite in cui nemmeno il fallback abbia funzionato.

**Piani disponibili** (`PARTNER_PLANS` in `sync.js`, canone mensile):

| Piano | Canone/mese |
|---|---|
| Boutique | €49 |
| Enoteche & Cantine | €59 |
| Sport & Attrezzatura | €69 |
| Hotel | €99 |
| Agenzie di Viaggio | €149 |
| Tour Operator | €199 |
| Gratuito (solo commissione) | €0 |

Su ogni vendita generata tramite il codice partner **che sia su un piano a pagamento**, il partner matura una **commissione del 10%** sul prezzo del servizio, accreditata al passaggio dell'ordine a "ritirato". **Il piano Gratuito non matura mai commissione** (`creditIssuedAmount` resta a 0) — è il compromesso del piano: nessun canone mensile, ma nemmeno guadagno sulle vendite (vedi `save-purchase.js`).

### Login e statistiche (`partner-stats.js`)

Il partner accede inserendo solo il proprio codice (nessuna password separata — stesso principio dei codici invito: non si può indovinare quali codici esistono, ma chi lo possiede può usarlo). Vede, aggregati in tempo reale dallo store centrale `purchases` (non dati locali del dispositivo):

- Vendite registrate tramite il suo codice.
- Valore generato (somma dei prezzi di servizio delle vendite).
- Commissione maturata (10% del valore generato).
- **Credito disponibile** (vedi sotto).

**Andamento nel tempo** (TOU-17): sotto i totali cumulativi, il confronto tra il mese corrente e quello precedente (ordini e commissione, con la differenza evidenziata), l'andamento degli ultimi 12 mesi, e gli ultimi 20 ordini con la commissione generata da ciascuno. A differenza del totale cumulativo sopra (stima al 10% su tutte le vendite indipendentemente dallo stato), qui la commissione è sempre `creditIssuedAmount` — quella realmente accreditata da `save-purchase.js` al passaggio a "ritirato": un ordine "in sospeso" del mese corrente compare con commissione €0 finché non viene ritirato.

### Scadenza piano e accesso alla dashboard (TOU-19)

Ogni partner ha un campo `planStartedAt` (data di inizio del piano corrente), impostato alla registrazione (`register-partner`) e aggiornato ad ogni cambio piano (`upgrade-partner-plan`, vedi sotto). Partner registrati prima dell'introduzione di questo campo non ne hanno uno salvato: la prima volta che le loro statistiche vengono lette, `partner-stats.js` lo imposta a quel momento (non conoscendo la vera data di registrazione, gli viene concessa una finestra piena a partire da ora, invece di considerarli scaduti da subito).

**Regole di accesso** (`computeAccessStatus` in `partner-stats.js`), verificate ad ogni login/refresh dell'area partner:

- **Piano Gratuito**: valido per **12 mesi** da `planStartedAt`. Superato il termine, l'accesso all'area partner viene **negato completamente** (non solo il maturare commissione) — il partner vede una schermata di blocco con un messaggio che invita ad abbonarsi, invece della dashboard.
- **Piano a pagamento**: stessa logica alla scadenza — se il canone non risulta confermato dallo staff nel CRM (`paid !== true`) per più di **30 giorni** da `planStartedAt`, l'accesso viene negato allo stesso modo. I 30 giorni sono un periodo di grazia (non specificato dal prodotto) per dare tempo allo staff di confermare il pagamento dopo un cambio piano, senza bloccare istantaneamente un abbonamento appena attivato.
- **Commissioni già maturate**: il blocco riguarda solo l'accesso futuro alla dashboard — non tocca in alcun modo gli accrediti già avvenuti (`creditIssuedAmount`/`creditBalance` restano quelli maturati durante il periodo attivo, mai annullati retroattivamente).

**Incentivo prima del blocco**: finché il piano Gratuito è ancora attivo, la dashboard mostra i giorni rimanenti e una stima di "quanto avresti guadagnato con un piano a pagamento" (volume venduto sul piano gratuito × 10% di commissione) — per invogliare il partner ad abbonarsi prima che scatti il blocco.

**Passaggio a un piano a pagamento**: azione `upgrade-partner-plan` in `sync.js` — il partner sceglie uno dei piani a pagamento dalla propria area (anche da bloccato, se il piano gratuito è scaduto), il sistema aggiorna `plan`/`monthlyFee`/`planStartedAt` e genera la prima fattura del canone (riusa `issuePartnerInvoice`). Come alla registrazione, `paid` torna a `false`: il pagamento reale resta fuori da questo prototipo, quindi resta allo staff del CRM confermarlo prima che l'accesso si sblocchi davvero (periodo di grazia di 30 giorni sopra).

> **Nota di scope**: il blocco riguarda solo l'accesso del partner alla propria dashboard. Il codice partner di un piano gratuito scaduto è **ancora accettato** da `save-purchase.js` sui nuovi acquisti dei turisti (che comunque non maturano mai commissione, essendo piano gratuito) — non è stato implementato un blocco lato checkout turista. Da valutare se serve anche quello.

### QR promozionale

Un bottone genera un QR che incorpora l'URL dell'app con `?partner=CODICE` già impostato — chi lo scansiona apre l'app con il codice partner già collegato in automatico a qualunque acquisto farà.

### Fatturazione canone

`issuePartnerInvoice()` crea una fattura (id, data, importo = canone del piano, periodo) e la aggiunge allo storico fatture del partner. Esiste in due copie indipendenti, una per repository: in `sync.js` (qui) è usata dalla registrazione self-service e dal riscatto credito; in `crm.js` (repository privato) dall'azione `generate-partner-invoice`, generata manualmente dallo staff.

### Sistema crediti partner

Oltre alla commissione (un numero puramente informativo), ogni partner ha un **saldo credito reale e spendibile** (`creditBalance`, persistito sul record partner):

- **Accredito**: scatta **solo quando un acquisto con quel `partnerCode` raggiunge lo stato "ritirato"** (mai prima), e **solo se il partner è su un piano a pagamento** — il piano gratuito non genera mai commissione (coerente col copy del sito, "Gratuito — nessuna commissione"): il 10% del prezzo del servizio viene aggiunto al saldo solo per `partner.plan !== "free"`. Un partner storico senza campo `plan` (creato prima che i piani distinguessero gratuito/a pagamento) è trattato come a pagamento, per non cambiare retroattivamente il comportamento per quei record. Un `partnerCode` che non corrisponde a nessun partner reale non genera commissione. In tutti i casi in cui la commissione non matura, l'acquisto passa comunque correttamente a "ritirato" e `creditIssuedAmount` viene scritto esplicitamente a **0** (mai lasciato non impostato). Un flag `creditIssued` sull'acquisto impedisce un doppio accredito se lo stato viene risincronizzato più volte, indipendentemente da quale dei due percorsi lo porta a "ritirato" (conferma del turista o azione manuale dello staff da CRM).
- **Riscatto sul canone**: bottone "Usa credito per il canone" nell'area partner — genera la prossima fattura e applica il credito disponibile fino a coprirla per intero (mai un importo negativo); l'eventuale resto rimane sul saldo per la fattura successiva (azione `redeem-credit-for-invoice` in `sync.js`).
- **Codici sconto per i clienti**: bottone "Genera codice sconto per un cliente" — crea un codice monouso (store Blobs `partner-discount-codes`, azione `generate-partner-discount-code` in `sync.js`) che il partner comunica direttamente al cliente. Generare il codice non consuma ancora credito: il costo si scala solo quando il codice viene realmente usato.
  - Il turista lo inserisce al checkout (campo "Hai un codice sconto partner?" nella schermata di conferma prezzo) — validato e consumato da `netlify/functions/partner-discount.js`.
  - Se valido: sconto del 10% sulla sola fee di servizio, il codice viene marcato come usato (con email del turista), e **esattamente quell'importo** viene scalato dal credito del partner.
  - Se il partner non ha credito sufficiente in quel momento, il codice **non viene consumato** e il turista vede un errore chiaro — nessuno sconto "a debito".

Nel CRM, la tab Partner & Commissioni mostra credito disponibile e conteggio codici sconto generati/usati per ogni partner.

---

## Sicurezza e backend

### Netlify Functions (`netlify/functions/*.js`)

Solo le function di questo repository — quelle del CRM/kit riservato/area investitori (`crm.js`, `kit-vault.js`, `investor-content.js`) vivono nel repository privato `touchandgo-internal`, vedi "Due repository" in Panoramica.

| Function | Cosa fa |
|---|---|
| `assistant.js` | Assistente conversazionale "Chiedi a Touch&Go" (vedi sezione dedicata sotto in "App turista") — stessa `ANTHROPIC_API_KEY` di `classify.js`, system prompt con i fatti reali del servizio costruito lato server. |
| `classify.js` | Proxy verso l'API Claude (Anthropic) per la classificazione doganale delle foto/descrizioni — nasconde `ANTHROPIC_API_KEY` dal browser. Arricchisce il prompt con un digest dell'archivio di riferimento doganale (vedi sotto). |
| `guest-status.js` | Espone al client se questo deploy gira in modalità ospite (`GUEST_MODE=true`) — vedi "Spazio ospite (continuità operativa)" più sotto. |
| `partner-discount.js` | Valida e consuma i codici sconto partner al checkout del turista; scala il credito del partner esattamente dell'importo scontato. |
| `partner-stats.js` | Verifica un codice partner e restituisce statistiche reali (vendite, valore, commissione, credito) aggregate dallo store centrale. |
| `promo.js` | Valida e consuma i codici invito per l'offerta breakeven. |
| `save-purchase.js` | Salva/aggiorna un acquisto nello store centrale `purchases`; applica il blocco automatico anti-abuso; accredita il partner quando lo stato diventa "ritirato" tramite questo percorso (conferma del turista); registra l'archivio di riferimento doganale (vedi sotto). |
| `sync.js` | Le azioni sui dati condivisi che l'app/sito pubblico usano senza passare dal CRM interno: `get-purchases`, `get-purchases-by-email`, `ack-pickup-point`, `redeem-credit-for-invoice`, `generate-partner-discount-code`, `register-partner` — stessa identica logica che vivrebbe in `crm.js`, estratta qui perché questo repository non ha accesso a quello privato. Vedi "CRM interno, area investitori e kit riservato" in Panoramica. |

### Archivio di riferimento doganale (store Blobs `customs-reference`)

`classify.js` era finora un proxy puro verso Claude, senza alcun dato locale di riferimento — ogni classificazione partiva da zero, senza sapere nulla delle classificazioni reali già fatte in passato per oggetti simili.

- **Scrittura (`save-purchase.js`)**: al **primo** salvataggio di ogni acquisto (non alle risincronizzazioni di stato successive, altrimenti lo stesso oggetto gonfierebbe i conteggi ad ogni cambio di stato) con `category`, `hsCode` e `material` tutti presenti e validi, `recordCustomsReference()` aggiorna una voce dell'archivio. **Chiave**: `categoria::materiale` normalizzati (minuscolo/trim) — non il codice HS da solo (è l'output che si vuole aiutare a prevedere, non un input disponibile prima) né l'oggetto singolo (troppo specifico per essere un riferimento utile ad altri oggetti). Categoria+materiale è il compromesso: abbastanza ampio da accumulare più esempi nello stesso bucket, abbastanza specifico perché quegli esempi siano davvero pertinenti tra loro (es. "borsa in pelle" e "portafoglio in pelle" finiscono nello stesso bucket "Accessori Moda / pelle", con codici HS tipicamente vicini). Ogni voce tiene un conteggio per codice HS, il codice più frequente (`mostCommonHsCode`) e fino a 5 esempi recenti. Best-effort: un errore qui non blocca mai il salvataggio vero e proprio dell'acquisto.
- **`material`**: campo nuovo, aggiunto a `CLASSIFY_SCHEMA` (in `app.js`, dove il prompt di classificazione viene effettivamente costruito lato client — `classify.js` è solo un pass-through verso l'API) — prima non esisteva affatto. `category` esisteva già nello schema ma, scoperto durante questo lavoro, non veniva mai copiato sull'`item` salvato: ora entrambi i campi lo sono. Nessun valore stimato o indovinato lato codice: se l'AI non restituisce uno dei tre campi, la voce semplicemente non viene scritta.
- **Lettura/arricchimento (`classify.js`)**: prima di chiamare l'API, `buildCustomsReferenceContext()` legge fino a 8 voci dell'archivio e costruisce un digest testuale ("categoria / materiale: codice HS più usato in passato X, su N classificazioni reali precedenti"), passato come parametro `system` della richiesta a Claude (prima assente) — mai l'intero database, solo poche righe di contesto. Se l'archivio è vuoto o la lettura fallisce, `system` non viene impostato affatto: la classificazione procede comunque, mai bloccata da questo. Rate limiting e controllo `ANTHROPIC_API_KEY` esistenti, non toccati.
- **Perché non un matching mirato sull'oggetto specifico, per ora**: quando `classify.js` riceve la richiesta, categoria e materiale dell'oggetto in foto/descrizione **non sono ancora noti** — sono l'output della classificazione, non un input disponibile prima di chiamarla. Un vero matching richiederebbe o un secondo giro di classificazione (costo/latenza raddoppiati) o un'euristica sul testo/nome file per indovinare la categoria in anticipo (fragile, esplicitamente evitata). Quello implementato ora è un arricchimento di contesto generale, reale e mai inventato, non una ricerca per l'oggetto specifico.
- **Cosa servirebbe per un matching più mirato in futuro**: una classificazione preliminare leggera (es. parole chiave nella descrizione testuale, quando l'input è testo) per scegliere quale bucket interrogare prima della chiamata principale, oppure un vero secondo passaggio AI a due stadi (1: categoria approssimativa, 2: classificazione arricchita con gli esempi di quella categoria) — entrambi comportano una chiamata AI aggiuntiva, quindi un costo/latenza da valutare con Giuseppe prima di implementarli.

### Test automatici (TOU-12)

`netlify/functions/__tests__/` — test diretti delle Netlify Functions, con uno store Blobs finto in memoria al posto delle credenziali reali (nessuna rete necessaria). Usano il test runner integrato di Node (`node:test`/`node:assert`), senza dipendenze aggiuntive: `npm test` (= `node --test`) li esegue tutti.

- `save-purchase.commission.test.js` — copre esplicitamente il comportamento condizionato al piano introdotto da TOU-12: piano gratuito → nessuna commissione accreditata (`creditBalance` invariato, `creditIssuedAmount: 0` esplicito); piano a pagamento → commissione del 10% come sempre; doppio resync dello stesso ordine → nessun doppio accredito; partner storico senza campo `plan` → trattato come a pagamento (nessun cambio retroattivo di comportamento).

### Rate limiting

Le funzioni esposte al pubblico (`classify.js`, `partner-stats.js`, `partner-discount.js`, `save-purchase.js`, `assistant.js`) applicano tutte lo stesso schema: **massimo 20 richieste ogni 60 minuti per indirizzo IP**, tracciato nello store Blobs `rate-limits`. Oltre il limite, l'endpoint risponde `429`.

`sync.js` non ha un rate limit generale (le sue azioni richiedono id/codici già noti al chiamante), tranne l'azione `get-purchases-by-email` (vedi "Sincronizzazione dello storico acquisti tra dispositivi" più sopra), che accetta un'email libera e applica lo stesso schema 20/60 minuti per IP.

### Variabili d'ambiente (impostate su Netlify, mai in questo repository)

| Variabile | A cosa serve |
|---|---|
| `ANTHROPIC_API_KEY` | Chiave per le chiamate a Claude (classificazione, packaging check, rilevamento firma). |
| `NETLIFY_BLOBS_SITE_ID` / `NETLIFY_BLOBS_TOKEN` | Credenziali di accesso a Netlify Blobs, usate da tutte le funzioni che leggono/scrivono dati — le stesse configurate anche sul deploy del repository privato, così i due siti condividono gli stessi dati (vedi "Due repository" in Panoramica). |
| `GUEST_MODE` | `true` **solo** sul deploy ospite (continuità operativa) — mai su produzione. Vedi "Spazio ospite (continuità operativa)" più sotto. |

> **Importante — non rimuovere l'auth Blobs esplicita da `getStore()`.** In questo ambiente di deploy il provisioning automatico di Netlify Blobs (che in teoria non richiederebbe alcuna configurazione) **non funziona** — un tentativo di farne a meno (TOU-13) ha causato in produzione l'errore `The environment has not been configured to use Netlify Blobs`, bloccando la registrazione partner. Ogni `getStore()` in questo repository (`sync.js`, `save-purchase.js`, `classify.js`, `promo.js`, `partner-discount.js`, `partner-stats.js`, `assistant.js`, `guest-status.js` — quest'ultima non ne fa uso diretto) deve continuare a passare esplicitamente `siteID`/`token` da `NETLIFY_BLOBS_SITE_ID`/`NETLIFY_BLOBS_TOKEN` (pattern `blobsAuth` ripetuto identico in ogni file) — non è codice ridondante da "pulire". Allo stesso modo, il **nome** dello store passato a `getStore()` deve sempre passare da `guestScopedStoreName()` (`netlify/lib/guest-mode.js`), mai una stringa letterale scritta a mano — vedi "Spazio ospite (continuità operativa)" più sotto.

`KIT_VAULT_PASSWORD` e `INVESTOR_PASSWORD` non servono più in questo repository — sono configurate solo sul deploy Netlify di `touchandgo-internal`, che ospita le function che le verificano.

Nessun valore reale di queste variabili è mai scritto in questo file o nel codice del repository — sono configurate solo nel pannello Netlify del sito.

### Blocklist

Un solo store (`blocklist`), condiviso tra due punti di scrittura: il blocco automatico in `save-purchase.js`, in questo repository (secondo acquisto senza mai essere stato abbonato), e il blocco manuale dello staff dalla tab Bloccati del CRM (`block-customer`/`unblock-customer` in `crm.js`, repository privato). Ogni voce registra email, motivo, se è automatico o manuale, e la data.

---

## Spazio ospite (continuità operativa)

**Perché esiste**: una seconda istanza dell'app turista, deployata come sito Netlify separato (stesso repository GitHub, stesso branch/codice — la creazione del sito Netlify vero e proprio è manuale, fuori da questo repository), pronta a subentrare se il sito principale va in crash. **Questa fase copre solo l'isolamento dei dati**: nessun meccanismo di passaggio automatico o manuale tra i due siti esiste ancora — arriverà in una fase successiva.

**Principio guida** (non solo per questo): ogni componente del sistema deve restare riparabile, aggiornabile o sostituibile in isolamento, senza che un problema in una parte blocchi le altre. Lo spazio ospite ne è la prima applicazione esplicita; man mano che il progetto cresce, vale la pena tenerlo a mente anche altrove.

### Come funziona

Una sola variabile d'ambiente Netlify, **`GUEST_MODE`**, impostata a `"true"` **solo** sul deploy ospite (mai su produzione — se assente o `false`, tutto si comporta esattamente come oggi):

- **`netlify/lib/guest-mode.js`** — helper condiviso da tutte le Netlify Functions di questo repository (non dentro `netlify/functions/` apposta, per evitare che il discovery automatico delle function di Netlify lo scambi per un endpoint). Espone due funzioni pure:
  - `isGuestMode()` — legge `GUEST_MODE`, confronto case-insensitive.
  - `guestScopedStoreName(baseName)` — restituisce `baseName` invariato in produzione, `${baseName}-guest` nello spazio ospite.
- **Ogni `getStore({ name: ..., ...blobsAuth })`** in questo repository passa il nome attraverso `guestScopedStoreName()` invece di scrivere la stringa a mano — un solo punto che decide la separazione, quindi un solo punto da aggiornare se la convenzione cambiasse in futuro. Così i dati generati nello spazio ospite finiscono in store Blobs **completamente separati**, non si mescolano mai con quelli di produzione — nemmeno per errore, anche se i due siti finissero per condividere per sbaglio le stesse credenziali `NETLIFY_BLOBS_SITE_ID`/`NETLIFY_BLOBS_TOKEN`.

**Store "gemellati" (produzione + ospite)** — ognuno di questi 7 store esiste oggi in due copie indipendenti, `nome` e `nome-guest`:

| Store | Scritto/letto da |
|---|---|
| `purchases` | `save-purchase.js`, `sync.js`, `partner-stats.js` |
| `partners` | `save-purchase.js`, `partner-discount.js`, `partner-stats.js`, `sync.js` |
| `blocklist` | `save-purchase.js` |
| `promo` | `promo.js` |
| `partner-discount-codes` | `partner-discount.js`, `sync.js` |
| `customs-reference` | `save-purchase.js` (scrive), `classify.js` (legge) |
| `rate-limits` | tutte le function pubbliche (`assistant.js`, `classify.js`, `partner-discount.js`, `partner-stats.js`, `save-purchase.js`, `sync.js`) — isolato anch'esso: il conteggio anti-abuso dello spazio ospite non condivide mai la finestra con quello di produzione |

`assistant.js` non ha alcuno store business (solo `rate-limits`): il chatbot non persiste nulla, quindi non ha bisogno di alcuna logica aggiuntiva oltre al rate limiting già isolato sopra.

### Il banner "spazio ospite"

`GUEST_MODE` è una variabile letta solo lato server (Netlify Functions) — il client statico servito da `dist/` (nessun build step in questo repository) non ha alcun modo di leggerla direttamente. Per questo esiste **`netlify/functions/guest-status.js`**: un endpoint minimo, senza dati sensibili, che restituisce `{ guestMode: true|false }`.

- All'avvio, `app.js` chiama questo endpoint (`checkGuestMode()`) e, se risponde `true`, imposta `state.guestMode` e mostra un banner ben visibile in cima alla pagina (prima ancora dell'header, così compare anche durante l'onboarding di un turista nuovo): *"Stai usando la versione di continuità di Touch&Go. I tuoi acquisti sono al sicuro e verranno sincronizzati automaticamente."* (localizzato IT/EN, chiave `guest_mode_banner`).
- Se la chiamata fallisce (offline, funzione irraggiungibile) il banner resta semplicemente nascosto — mai un falso positivo che lo mostri su un deploy che non è davvero lo spazio ospite.
- Nascosto di default: su produzione (`GUEST_MODE` assente) non compare mai.

### Cosa NON copre ancora questa fase

- **Nessun failover automatico o manuale** tra i due siti — un problema al sito principale non reindirizza ancora nessuno allo spazio ospite; per ora è solo una seconda istanza pronta, isolata, che va raggiunta manualmente se serve.
- **Lo spazio ospite parte vuoto**: nessun acquisto, partner, codice promo/sconto o voce dell'archivio doganale di produzione è visibile lì, per design — è la conseguenza diretta dell'isolamento completo, non un bug. Un partner registrato o un codice invito creato su produzione non esistono nello store `-guest` corrispondente finché non verrà costruito un meccanismo di sincronizzazione (fuori scope qui).
- **5 dei 7 store gemellati sono scritti/letti anche da `touchandgo-internal`** (repository privato del CRM, `crm.js`): `purchases`, `partners`, `blocklist`, `promo`, `partner-discount-codes` (verificato leggendo `crm.js`). Quel codice non conosce `GUEST_MODE` e usa sempre i nomi store "di base" (senza suffisso) — un'azione fatta dallo staff nel CRM (registrare un partner, sbloccare un cliente, creare un codice invito, cambiare lo stato di un acquisto) raggiunge solo la copia di produzione, mai quella `-guest`. Solo `customs-reference` e `rate-limits` sono esclusivi di questo repository. Coerente con l'isolamento di questa fase, ma da tenere presente quando si progetterà la sincronizzazione — un'eventuale azione CRM sullo spazio ospite richiederebbe di portare la stessa consapevolezza di `GUEST_MODE` anche in `touchandgo-internal`.
