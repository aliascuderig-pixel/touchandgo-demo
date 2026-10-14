// I link della guida (mezzo di promozione dei servizi Touch&Go) devono sempre
// atterrare nel dispositivo giusto: host e percorsi ammessi sono elencati qui
// e vanno aggiornati INSIEME alla guida quando nasce un nuovo dispositivo.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const GUIDA = fs.readFileSync(path.join(__dirname, "..", "..", "site", "guida.html"), "utf8");

const ALLOWED = {
  "touchandgo-suite.netlify.app": ["/site/index.html", "/?mode=partner"],
  "touchandgo-router.netlify.app": ["/"],
  "touchandgo-crm.netlify.app": [
    "/site/admin.html",
    "/site/admin.html?tab=sistema",
    "/site/admin.html?tab=servizio-api",
    "/site/admin.html?tab=recensioni",
    "/site/admin.html?tab=pratiche",
  ],
  "touchandgo-gestionale.netlify.app": [""],
  "touchandgo-eshop.netlify.app": ["/site/index.html", "/site/fattura-proforma.html"],
  "touchandgo-api.netlify.app": [""],
  "touchandgo-pratiche.netlify.app": [""],
};

const links = [...GUIDA.matchAll(/href="(https:\/\/touchandgo[^"]+)"/g)].map((m) => m[1]);

test("la guida ha link ai dispositivi", () => {
  assert.ok(links.length >= 10);
});

test("ogni link della guida punta a un dispositivo e a un percorso noti", () => {
  for (const l of links) {
    const u = new URL(l);
    assert.ok(ALLOWED[u.host], `host sconosciuto: ${l}`);
    const rest = u.pathname.replace(/^\/$/, "/") + u.search;
    const normalized = u.host.match(/gestionale|api|pratiche/) && (rest === "/" || rest === "") ? "" : rest;
    assert.ok(ALLOWED[u.host].includes(normalized), `percorso non ammesso per ${u.host}: ${l}`);
  }
});

test("ogni link ?tab= del CRM esiste davvero nella pagina del CRM (se il repo gemello è presente)", (t) => {
  const crm = path.join(__dirname, "..", "..", "..", "..", "touchandgo-internal", "dist", "site", "admin.html");
  if (!fs.existsSync(crm)) return t.skip("repo CRM non presente");
  const html = fs.readFileSync(crm, "utf8");
  for (const l of links.filter((x) => x.includes("?tab="))) {
    const slug = new URL(l).searchParams.get("tab");
    assert.ok(html.includes(`data-tab="${slug}"`), `tab CRM inesistente: ${slug}`);
  }
});
