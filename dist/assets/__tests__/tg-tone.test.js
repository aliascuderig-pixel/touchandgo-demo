'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../tg-tone.js');

test('parseColor: hex corto, lungo, alpha e rgba', () => {
  assert.deepEqual(T.parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(T.parseColor('#C9F24D'), { r: 201, g: 242, b: 77, a: 1 });
  assert.equal(T.parseColor('rgba(201,242,77,.16)').a, 0.16);
  assert.equal(T.parseColor('2px'), null);
  assert.equal(T.parseColor("'Montserrat'"), null);
});

test('posizione 50 (e ±2) = originale, nessuna modifica', () => {
  for (const p of [48, 49, 50, 51, 52]) assert.equal(T.toneFromPosition(p), 0);
  const c = T.parseColor('#C9A96E');
  assert.strictEqual(T.transform(c, 0), c);
  assert.equal(T.labelFor(50), 'Originale');
});

test('estremi: 0 → -1, 100 → +1; progressione monotona', () => {
  assert.equal(T.toneFromPosition(0), -1);
  assert.equal(T.toneFromPosition(100), 1);
  let prev = -2;
  for (let p = 0; p <= 100; p += 5) { const t = T.toneFromPosition(p); assert.ok(t >= prev); prev = t; }
});

test('brillante aumenta il contrasto, riposante lo riduce', () => {
  const bg = T.parseColor('#0d1517'), tx = T.parseColor('#edf2ee');
  const lum = (c) => T.rgbToHsl(c).l;
  const gap = (t) => lum(T.transform(tx, t)) - lum(T.transform(bg, t));
  assert.ok(gap(1) > gap(0) - 1e-9 && gap(-1) < gap(0));
  assert.ok(gap(-1) < gap(-0.5) && gap(-0.5) < gap(0));
});

test('brillante satura, riposante desatura; alpha conservato', () => {
  const g = T.parseColor('#c9f24d');
  assert.ok(T.rgbToHsl(T.transform(g, -1)).s < T.rgbToHsl(g).s);
  const a = T.parseColor('rgba(100,140,60,.16)');
  assert.equal(T.transform(a, 0.7).a, 0.16);
  assert.equal(T.transform(a, -0.7).a, 0.16);
});

test('i grigi restano grigi; il risultato è sempre un colore valido', () => {
  for (const hex of ['#000000', '#ffffff', '#777777', '#c9a96e', '#ff6b6b']) {
    for (const t of [-1, -0.3, 0.3, 1]) {
      const out = T.format(T.transform(T.parseColor(hex), t));
      assert.match(out, /^#[0-9a-f]{6}$/);
    }
  }
  const g = T.transform(T.parseColor('#777777'), 1);
  assert.ok(g.r === g.g && g.g === g.b);
});

test('format: rgba quando c\'è trasparenza', () => {
  assert.equal(T.format({ r: 1, g: 2, b: 3, a: 0.5 }), 'rgba(1,2,3,0.5)');
});
