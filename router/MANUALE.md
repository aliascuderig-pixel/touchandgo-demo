# Manuale — Touchandgo Router (dispositivo «router di continuità»)

Sito Netlify indipendente (nome `touchandgo-router`), che vive nella cartella `router/` del repository `touchandgo-demo` con un proprio file di configurazione. È il link stabile da condividere al posto del link diretto al sito principale: reindirizza al sito principale (`touchandgo-suite.netlify.app`) o, se questo non funziona, allo spazio ospite (`touchandgo-guest.netlify.app`). La descrizione estesa del ragionamento di progetto sta in `MANUALE.md` alla radice del repository, sezione «Router di continuità»; questo file è la specifica sintetica del dispositivo.

## Cosa fa

- La radice del sito è riscritta internamente (stato 200, senza reindirizzamento visibile) verso la funzione `go`.
- `go` risponde con un reindirizzamento 302 (senza cache) al sito principale o allo spazio ospite.
- Una pagina di amministrazione (`admin.html`) mostra lo stato e permette il ripristino; `index.html` è solo una pagina di ripiego.

## Funzioni

- **go**: se la variabile `ACTIVE_TARGET` è impostata, reindirizza a «main» o «guest» come indicato (un valore non riconosciuto porta al sito principale). Altrimenti legge lo stato: se il failover è attivo va allo spazio ospite senza altri controlli; se l'ultimo controllo ha meno di 45 secondi ed era positivo va al principale; altrimenti chiama la funzione di salute del sito principale con timeout di 4 secondi. Esito 200: salva lo stato sano e va al principale. Qualsiasi altro esito (stato diverso, timeout, errore di rete): attiva il failover registrando data e motivo e va allo spazio ospite. Un errore interno (per esempio lo store irraggiungibile) porta sempre al sito principale.
- **status**: riporta modalità (override o automatica), destinazione corrente e stato; non fallisce mai con un errore HTTP (in caso di problema risponde con esito negativo e il motivo).
- **reset** (POST): azzera lo stato del failover. Richiede la password in `ROUTER_ADMIN_PASSWORD` (503 se la variabile non è configurata, 401 se la password è errata, 400 se il corpo non è valido, 405 per metodo diverso da POST).

## Stato

Un solo record nello store Netlify Blobs `router-state` (chiave `state`): failover attivo (sì/no), da quando, motivo, data dell'ultimo controllo e suo esito. Valore predefinito: tutto spento/nullo.

## Regole importanti

- Il failover, una volta attivato, resta tale finché qualcuno non lo azzera con il ripristino: il ritorno al sito principale non è automatico (evita oscillazioni).
- Il debounce di 45 secondi limita le chiamate alla funzione di salute (e quindi all'API AI).
- `ACTIVE_TARGET` ha sempre la precedenza e si cambia dal pannello Netlify senza nuovo deploy.
- Variabili d'ambiente: `NETLIFY_BLOBS_SITE_ID`, `NETLIFY_BLOBS_TOKEN`, `ACTIVE_TARGET`, `ROUTER_ADMIN_PASSWORD` (solo nomi; i valori stanno su Netlify).
- Dipendenza: `@netlify/blobs`.
- Il controllo giornaliero del sistema (funzione pianificata nel sito principale) verifica anche questo router.

## Aspetto estetico (17 ottobre 2026)

Il router ha un aspetto proprio, minimale e chiaro, diverso dal tema scuro degli altri dispositivi.

- **Palette**: inchiostro #0F0F0F, carta #FAF8F4, oro #C9A96E, grigio #777; esito positivo #2E7D32, errore #B3261E.
- **Carattere**: del sistema operativo (senza font esterni), testo 13–15 px.
- **Pagina di passaggio** (`index.html`): una colonna larga al massimo 360 px, centrata sia in orizzontale sia in verticale, sul fondo carta. Il marchio è un testo grassetto di 22 px («Touch» in inchiostro, «&Go» in oro, senza corsivo); sotto un messaggio grigio di 14 px, un indicatore circolare di 22 px (bordo grigio chiaro, parte in alto in oro, giro di 0,8 s) e, per chi resta bloccato, un collegamento sottolineato in oro.
- **Pagina di amministrazione** (`admin.html`): stessa colonna da 360 px con marchio e sottotitolo grigio di 13 px; messaggio informativo a sinistra; un campo password (bordo #DDD5C4, fondo bianco, angoli 8 px, 15 px) e un pulsante a tutta larghezza con fondo inchiostro e testo carta (opaco al 60 % quando disabilitato); sotto l'esito, verde o rosso, in 13 px.
