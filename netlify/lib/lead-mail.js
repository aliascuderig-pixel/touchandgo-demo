// Email di benvenuto agli iscritti dalla pagina «Iscriviti» e link di
// disiscrizione firmato. Nessuna dipendenza npm: l'invio usa fetch verso
// l'API di Resend (https://resend.com), scelta cambiabile modificando
// solo sendMail().
//
// Variabili d'ambiente (Netlify) — se manca una delle tre l'invio è
// SPENTO e l'iscrizione funziona comunque (si salva e basta):
//   RESEND_API_KEY      chiave API del servizio di invio
//   LEAD_MAIL_FROM      mittente verificato, es. "Touch&Go <ciao@tuodominio.it>"
//   LEAD_UNSUB_SECRET   stringa casuale lunga, per firmare i link di disiscrizione
// Facoltativa: LEAD_SITE_URL (default: URL che Netlify imposta da solo).

const crypto = require("node:crypto");

function mailEnabled() {
  return !!(process.env.RESEND_API_KEY && process.env.LEAD_MAIL_FROM && process.env.LEAD_UNSUB_SECRET);
}

function siteUrl() {
  return (process.env.LEAD_SITE_URL || process.env.URL || "").replace(/\/+$/, "");
}

// Firma HMAC dell'id iscritto: chi non conosce il segreto non può
// disiscrivere (né verificare) altre persone.
function unsubToken(id) {
  return crypto.createHmac("sha256", process.env.LEAD_UNSUB_SECRET || "").update(String(id)).digest("hex").slice(0, 32);
}

function verifyUnsubToken(id, token) {
  if (!process.env.LEAD_UNSUB_SECRET || typeof token !== "string" || typeof id !== "string") return false;
  const a = Buffer.from(unsubToken(id));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function unsubUrl(id) {
  return `${siteUrl()}/.netlify/functions/lead-unsubscribe?id=${encodeURIComponent(id)}&t=${unsubToken(id)}`;
}

function welcomeMail(id) {
  const link = unsubUrl(id);
  const text = [
    "Ciao,",
    "",
    "grazie per esserti iscritto a Touch&Go.",
    "",
    "Touch&Go nasce a Catania come app per i turisti: compri in negozio, lasci l'acquisto, e lo facciamo arrivare a casa tua con un'unica spedizione, anche se hai comprato in più negozi. Ma è anche una suite pensata per negozianti, agenzie di viaggio e tour operator.",
    "",
    "Siamo in fase di prova: ti scriveremo quando apriamo e quando c'è qualcosa di utile da raccontarti. Non ti riempiremo di messaggi e non cediamo il tuo indirizzo a nessuno.",
    "",
    "A presto,",
    "Giuseppe — Touch&Go, Catania",
    "",
    "—",
    "Ricevi questa email perché ti sei iscritto sul nostro sito. Per non riceverne più: " + link,
  ].join("\n");
  return { subject: "Benvenuto in Touch&Go", text, unsubscribeUrl: link };
}

// Restituisce true se il servizio ha accettato il messaggio.
async function sendMail({ to, subject, text, unsubscribeUrl }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.LEAD_MAIL_FROM,
      to: [to],
      subject,
      text,
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });
  return res.ok;
}

module.exports = { mailEnabled, unsubToken, verifyUnsubToken, unsubUrl, welcomeMail, sendMail };
