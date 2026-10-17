/* Touch&Go — Regolatore di tono (TG-TONE v1)
   Cursore dinamico che cambia SOLO l'aspetto cromatico della pagina:
   a sinistra "Riposante" (meno contrasto, colori più morbidi e leggermente
   caldi), al centro "Originale" (tavolozza del dispositivo, invariata),
   a destra "Brillante" (più contrasto e colori più vivi).
   Funziona su qualsiasi pagina che definisca i colori come variabili CSS
   in :root (--bg, --gold, --text...): legge i valori reali, li trasforma
   in base al cursore e li riscrive come override inline su <html>.
   Non tocca layout, testi, font né funzioni. Il file è IDENTICO in tutti i
   dispositivi Touch&Go (vedi MANUALE.md, sezione "Regolatore di tono"). */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.TGTone = api;
    var start = function () { api.init(root.document); };
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var STORE_KEY = 'tg-tone';
  var NEUTRAL = 50;          // posizione "Originale"
  var SNAP = 2;              // entro ±2 il cursore si aggancia all'originale
  var C_RANGE = 0.22;        // variazione massima del contrasto (±22%)
  var S_RANGE = 0.30;        // variazione massima della saturazione (±30%)
  var WARM_HUE = 40;         // tinta verso cui scalda "Riposante"
  var WARM_MAX = 0.12;       // quota massima di avvicinamento a WARM_HUE

  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

  /* ---------- colore ---------- */
  function parseColor(v) {
    if (typeof v !== 'string') return null;
    v = v.trim().toLowerCase();
    var m = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
    if (m) {
      var h = m[1];
      if (h.length <= 4) h = h.split('').map(function (c) { return c + c; }).join('');
      return {
        r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
      };
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(v);
    if (m) {
      var a = m[4] === undefined ? 1 : parseFloat(m[4]) / (m[5] ? 100 : 1);
      return { r: +m[1], g: +m[2], b: +m[3], a: clamp(a, 0, 1) };
    }
    return null;
  }

  function rgbToHsl(c) {
    var r = c.r / 255, g = c.g / 255, b = c.b / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, h = 0, s = 0, d = max - min;
    if (d > 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: h, s: s, l: l };
  }

  function hslToRgb(o) {
    var h = ((o.h % 360) + 360) % 360 / 360, s = o.s, l = o.l;
    function f(p, q, t) {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    if (s === 0) { var v = Math.round(l * 255); return { r: v, g: v, b: v }; }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    return { r: Math.round(f(p, q, h + 1 / 3) * 255), g: Math.round(f(p, q, h) * 255), b: Math.round(f(p, q, h - 1 / 3) * 255) };
  }

  function format(c) {
    function hx(n) { var s = clamp(Math.round(n), 0, 255).toString(16); return s.length < 2 ? '0' + s : s; }
    if (c.a >= 0.999) return '#' + hx(c.r) + hx(c.g) + hx(c.b);
    return 'rgba(' + clamp(Math.round(c.r), 0, 255) + ',' + clamp(Math.round(c.g), 0, 255) + ',' + clamp(Math.round(c.b), 0, 255) + ',' + (Math.round(c.a * 1000) / 1000) + ')';
  }

  /* Cursore 0..100 → intensità t in [-1, 1] (0 = originale). */
  function toneFromPosition(pos) {
    pos = clamp(Number(pos), 0, 100);
    if (isNaN(pos) || Math.abs(pos - NEUTRAL) <= SNAP) return 0;
    return (pos - NEUTRAL) / NEUTRAL;
  }

  /* Trasforma un colore. t<0 riposante, t>0 brillante, t=0 identico. */
  function transform(c, t) {
    if (!c || !t) return c;
    var o = rgbToHsl(c);
    var k = 1 + C_RANGE * t;                       // contrasto attorno al grigio medio
    var l = clamp(0.5 + (o.l - 0.5) * k, 0, 1);
    var s = clamp(o.s * (1 + S_RANGE * t), 0, 1);  // saturazione
    var h = o.h;
    if (t < 0 && o.s > 0.08) {                     // riposante: leggermente più caldo
      var d = ((WARM_HUE - h + 540) % 360) - 180;
      h = h + d * WARM_MAX * -t;
    }
    var rgb = hslToRgb({ h: h, s: s, l: l });
    return { r: rgb.r, g: rgb.g, b: rgb.b, a: c.a };
  }

  function labelFor(pos) {
    var t = toneFromPosition(pos);
    if (t === 0) return 'Originale';
    if (t < -0.66) return 'Molto riposante';
    if (t < 0) return 'Riposante';
    if (t > 0.66) return 'Molto brillante';
    return 'Brillante';
  }

  /* ---------- pagina ---------- */
  var state = { base: null, pos: NEUTRAL, doc: null, raf: 0 };

  function collectBase(doc) {
    var names = {}, sheets = doc.styleSheets || [];
    for (var i = 0; i < sheets.length; i++) {
      var rules;
      try { rules = sheets[i].cssRules; } catch (e) { continue; }   // fogli di altri domini
      collect(rules, names);
    }
    var cs = doc.defaultView.getComputedStyle(doc.documentElement), base = {};
    Object.keys(names).forEach(function (n) {
      var col = parseColor(cs.getPropertyValue(n));
      if (col) base[n] = col;
    });
    return base;
  }
  function collect(rules, names) {
    for (var j = 0; j < (rules ? rules.length : 0); j++) {
      var r = rules[j];
      if (r.cssRules && !r.selectorText) { collect(r.cssRules, names); continue; }
      if (!r.selectorText || !/(^|,)\s*(:root|html)\s*(,|$)/.test(r.selectorText)) continue;
      for (var k = 0; k < r.style.length; k++) if (r.style[k].indexOf('--') === 0) names[r.style[k]] = 1;
    }
  }

  function clearOverrides(doc) {
    Object.keys(state.base || {}).forEach(function (n) { doc.documentElement.style.removeProperty(n); });
  }
  function apply(doc, pos) {
    state.pos = pos;
    var t = toneFromPosition(pos);
    clearOverrides(doc);
    if (!t) return;
    Object.keys(state.base).forEach(function (n) {
      doc.documentElement.style.setProperty(n, format(transform(state.base[n], t)));
    });
  }

  function save(win, pos) { try { win.localStorage.setItem(STORE_KEY, String(pos)); } catch (e) {} }
  function load(win) {
    try { var v = win.localStorage.getItem(STORE_KEY); if (v !== null) return clamp(Number(v) || NEUTRAL, 0, 100); } catch (e) {}
    return NEUTRAL;
  }

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}',
    '.fab{position:fixed;left:16px;bottom:var(--tg-fab-bottom,16px);z-index:2147483000;width:44px;height:44px;border-radius:50%;border:1px solid rgba(255,255,255,.35);background:rgba(18,18,18,.92);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,.35);padding:0}',
    '.fab:focus-visible,.btn:focus-visible,input:focus-visible{outline:2px solid #fff;outline-offset:2px}',
    '.panel{position:fixed;left:16px;bottom:calc(var(--tg-fab-bottom,16px) + 52px);z-index:2147483000;width:min(300px,calc(100vw - 32px));background:rgba(18,18,18,.96);color:#f2f2f2;border:1px solid rgba(255,255,255,.2);border-radius:12px;padding:14px 14px 12px;box-shadow:0 8px 28px rgba(0,0,0,.45)}',
    '.panel[hidden]{display:none}',
    '.ttl{font-size:13px;font-weight:600;margin:0 0 2px}',
    '.val{font-size:12px;opacity:.8;margin:0 0 10px;min-height:16px}',
    'input[type=range]{width:100%;height:44px;margin:0;background:transparent;-webkit-appearance:none;appearance:none;cursor:pointer}',
    'input[type=range]::-webkit-slider-runnable-track{height:8px;border-radius:4px;background:linear-gradient(90deg,#8fa3ad,#d9d2c3 50%,#ffd24a)}',
    'input[type=range]::-moz-range-track{height:8px;border-radius:4px;background:linear-gradient(90deg,#8fa3ad,#d9d2c3 50%,#ffd24a)}',
    'input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:26px;height:26px;margin-top:-9px;border-radius:50%;background:#fff;border:2px solid #111;box-shadow:0 1px 4px rgba(0,0,0,.5)}',
    'input[type=range]::-moz-range-thumb{width:22px;height:22px;border-radius:50%;background:#fff;border:2px solid #111}',
    '.ends{display:flex;justify-content:space-between;font-size:11px;opacity:.7;margin-top:-4px}',
    '.row{display:flex;gap:8px;margin-top:10px}',
    '.btn{flex:1;min-height:44px;border-radius:8px;border:1px solid rgba(255,255,255,.3);background:transparent;color:#fff;font-size:12px;cursor:pointer;padding:0 8px;touch-action:none;user-select:none;-webkit-user-select:none}',
    '.btn:active{background:rgba(255,255,255,.15)}',
    '@media print{.fab,.panel{display:none}}'
  ].join('');

  function buildUi(doc, win) {
    var host = doc.createElement('div');
    host.setAttribute('data-tg-tone-ui', '');
    var sh = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    sh.innerHTML =
      '<style>' + CSS + '</style>' +
      '<button class="fab" type="button" aria-label="Regola il tono dei colori" aria-expanded="false" aria-controls="p">' +
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/></svg></button>' +
      '<div class="panel" id="p" role="group" aria-label="Tono dei colori" hidden>' +
      '<p class="ttl">Tono dei colori</p><p class="val" aria-live="polite"></p>' +
      '<input type="range" min="0" max="100" step="1" aria-label="Tono dei colori: da riposante a brillante">' +
      '<div class="ends"><span>Riposante</span><span>Brillante</span></div>' +
      '<div class="row"><button class="btn cmp" type="button">Confronta con l’originale (tieni premuto)</button>' +
      '<button class="btn rst" type="button">Ripristina</button></div></div>';
    doc.body.appendChild(host);

    var q = function (s) { return sh.querySelector(s); };
    var fab = q('.fab'), panel = q('.panel'), rng = q('input'), val = q('.val');
    function show(pos) { rng.value = pos; var t = toneFromPosition(pos); val.textContent = labelFor(pos) + (t ? ' (' + Math.round(t * 100) + '%)' : ''); rng.setAttribute('aria-valuetext', labelFor(pos)); }
    function commit(pos) {
      pos = clamp(Number(pos), 0, 100);
      if (Math.abs(pos - NEUTRAL) <= SNAP) pos = NEUTRAL;
      show(pos);
      if (state.raf) win.cancelAnimationFrame(state.raf);
      state.raf = win.requestAnimationFrame(function () { state.raf = 0; apply(doc, pos); });
      save(win, pos);
    }
    fab.addEventListener('click', function () {
      var open = panel.hidden; panel.hidden = !open; fab.setAttribute('aria-expanded', String(open));
    });
    rng.addEventListener('input', function () { commit(rng.value); });
    q('.rst').addEventListener('click', function () { commit(NEUTRAL); });

    var cmp = q('.cmp'), held = false;
    function hold() { if (held) return; held = true; clearOverrides(doc); }
    function release() { if (!held) return; held = false; apply(doc, state.pos); }
    cmp.addEventListener('pointerdown', hold);
    ['pointerup', 'pointercancel', 'pointerleave', 'blur'].forEach(function (e) { cmp.addEventListener(e, release); });
    cmp.addEventListener('keydown', function (e) { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); hold(); } });
    cmp.addEventListener('keyup', function (e) { if (e.key === ' ' || e.key === 'Enter') release(); });

    show(state.pos);
  }

  function init(doc) {
    if (!doc || !doc.body || doc.querySelector('[data-tg-tone-ui]')) return;
    var win = doc.defaultView;
    state.doc = doc;
    state.base = collectBase(doc);
    state.pos = load(win);
    apply(doc, state.pos);
    buildUi(doc, win);
  }

  return {
    parseColor: parseColor, rgbToHsl: rgbToHsl, hslToRgb: hslToRgb, format: format,
    transform: transform, toneFromPosition: toneFromPosition, labelFor: labelFor,
    init: init, NEUTRAL: NEUTRAL
  };
});
