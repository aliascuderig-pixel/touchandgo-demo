// Disiscrizione dalle email di Touch&Go — link firmato presente in ogni
// email (vedi netlify/lib/lead-mail.js).
//  - GET  ?id&t : mostra una pagina con il pulsante di conferma (non
//                 disiscrive: i programmi di posta che "aprono" i link in
//                 anteprima non devono disiscrivere nessuno per errore).
//  - POST ?id&t : disiscrive (status "unsubscribed"). Serve anche al
//                 "one-click" richiesto da Gmail/Apple (List-Unsubscribe-Post).
// Il record NON viene cancellato: resta come prova che non va ricontattato.

const { getStore } = require("@netlify/blobs");
const { guestScopedStoreName } = require("../lib/guest-mode");
const { verifyUnsubToken } = require("../lib/lead-mail");

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function page(title, bodyHtml, statusCode) {
  return {
    statusCode: statusCode || 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    body: `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{margin:0;background:#0F0F0F;color:#F4EFE6;font-family:system-ui,sans-serif;line-height:1.6;display:grid;place-items:center;min-height:100vh;padding:20px}main{max-width:420px}h1{font-family:Georgia,serif;font-weight:600}button{font:inherit;font-weight:700;padding:12px 22px;border:0;border-radius:6px;background:#C9A96E;color:#0F0F0F;cursor:pointer}a{color:#C9A96E}</style></head><body><main>${bodyHtml}</main></body></html>`,
  };
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const id = typeof q.id === "string" ? q.id : "";
  const token = typeof q.t === "string" ? q.t : "";

  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }
  if (!verifyUnsubToken(id, token)) {
    return page("Link non valido", "<h1>Link non valido</h1><p>Il link di disiscrizione non è corretto o è scaduto. Scrivi a privacy@touchandgo.it e ti togliamo noi.</p>", 400);
  }

  if (event.httpMethod === "GET") {
    return page(
      "Disiscrizione",
      `<h1>Non vuoi più ricevere email?</h1><p>Conferma e non ti scriveremo più.</p><form method="POST" action="?id=${encodeURIComponent(id)}&amp;t=${encodeURIComponent(token)}"><button type="submit">Conferma disiscrizione</button></form>`
    );
  }

  try {
    const leads = getStore({
      name: guestScopedStoreName("leads"),
      siteID: process.env.NETLIFY_BLOBS_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });
    const lead = await leads.get(id, { type: "json" });
    // Firma valida ma record assente (già cancellato): stessa risposta,
    // l'obiettivo — non ricevere più email — è comunque raggiunto.
    if (lead && lead.status !== "unsubscribed") {
      lead.status = "unsubscribed";
      lead.unsubscribedAt = new Date().toISOString();
      await leads.setJSON(id, lead);
    }
    return page("Disiscritto", '<h1>Fatto.</h1><p>Non riceverai più email da Touch&amp;Go. <a href="/site/index.html">Torna al sito</a></p>');
  } catch (err) {
    return page("Errore", "<h1>Errore temporaneo</h1><p>Riprova tra poco, oppure scrivi a privacy@touchandgo.it.</p>", 500);
  }
};
