import fs from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../regional-pricing.js', import.meta.url), 'utf8');
const xof = ['BJ', 'BF', 'CI', 'GW', 'ML', 'NE', 'SN', 'TG'];
const xaf = ['CM', 'CF', 'TD', 'CG', 'GA', 'GQ'];
const compact = value => value.replace(/[\s\u00a0\u202f]/g, '');
function boot(query = '') {
  const dom = new JSDOM(html, { url: 'https://ndiayeelage0508-cloud.github.io/mon-premier-site/' + query, runScripts: 'outside-only' });
  const w = dom.window;
  w.localStorage.setItem('existing-library', 'untouched');
  const noSideEffects = () => { throw new Error('Pricing must not call network, geolocation or storage'); };
  w.fetch = noSideEffects;
  w.XMLHttpRequest = noSideEffects;
  w.navigator.geolocation = { getCurrentPosition: noSideEffects, watchPosition: noSideEffects };
  for (const method of ['setItem', 'removeItem', 'clear']) w.Storage.prototype[method] = noSideEffects;
  w.eval(script);
  return { dom, w, root: w.document.querySelector('#plansDialog'), select: w.document.querySelector('#region') };
}
function check(h, code, expectedCurrency) {
  h.select.value = code;
  h.select.dispatchEvent(new h.w.Event('change', { bubbles: true }));
  const [monthly, annual, saving, symbol] = {
    XOF: ['1500', '15000', '17', 'XOF'], XAF: ['1500', '15000', '17', 'XAF'],
    USD: ['2,99', '25,99', '28', '$ US'], EUR: ['2,99', '22,99', '36', '€'],
  }[expectedCurrency];
  assert.equal(compact(h.root.querySelector('#monthly-amount').textContent), monthly, code);
  assert.equal(compact(h.root.querySelector('#annual-amount').textContent), annual, code);
  assert.deepEqual([...h.root.querySelectorAll('.currency-code')].map(x => x.textContent), [symbol, symbol], code);
  assert.equal(h.root.querySelector('.save').textContent, `Économisez ≈ ${saving} %`, code);
  assert.match(h.root.querySelector('.saving-line').textContent, new RegExp(`environ ${saving} %`));
  assert.ok(h.root.querySelector('#region-summary').textContent.endsWith(`en ${expectedCurrency}.`));
  assert.equal(h.root.querySelector('.cta').disabled, true);
  assert.equal(h.w.localStorage.getItem('existing-library'), 'untouched');
}
test('all countries and fallback obey the approved fixed prices, with exactly 8 XOF and 6 XAF countries', () => {
  const h = boot();
  assert.equal(h.select.value, 'SN');
  assert.equal(h.select.options.length, 250);
  const counts = { XOF: 0, XAF: 0, USD: 0, EUR: 0 };
  for (const option of h.select.options) {
    const code = option.value;
    const currency = xof.includes(code) ? 'XOF' : xaf.includes(code) ? 'XAF' : code === 'US' ? 'USD' : 'EUR';
    counts[currency]++;
    check(h, code, currency);
  }
  assert.deepEqual(counts, { XOF: 8, XAF: 6, USD: 1, EUR: 235 });
  h.dom.window.close();
});
test('manual comparison works for both periods without enabling subscription or mutating state', () => {
  const h = boot();
  check(h, 'US', 'USD');
  const monthly = h.root.querySelector('#monthly');
  const annual = h.root.querySelector('#annual');
  assert.equal(monthly.checked, true);
  annual.click();
  assert.equal(annual.checked, true);
  assert.equal(monthly.checked, false);
  const cta = h.root.querySelector('.cta');
  let clicks = 0;
  cta.addEventListener('click', () => clicks++);
  cta.click();
  assert.equal(clicks, 0);
  assert.equal(cta.type, 'button');
  assert.equal(cta.disabled, true);
  for (const label of ['.monthly-label', '.annual-label']) assert.match(cta.querySelector(label).textContent, /bientôt disponible/);
  for (const benefit of ['Favoris de prompts', 'Collections', 'Synchronisation entre appareils', 'Aucune publicité', 'Quotas IA actuels conservés']) assert.ok(h.root.textContent.includes(benefit));
  assert.equal(h.root.querySelectorAll('a, iframe, input:not([type="radio"])').length, 0);
  assert.equal(h.root.querySelectorAll('form:not([method="dialog"])').length, 0);
  h.dom.window.close();
});
test('country share parameter is explicit and invalid or absent parameter never infers visitor location', () => {
  for (const [query, code, currency] of [['', 'SN', 'XOF'], ['?pays=US', 'US', 'USD'], ['?pays=FR', 'FR', 'EUR'], ['?pays=CM', 'CM', 'XAF'], ['?pays=INVALID', 'SN', 'XOF'], ['?pays=%3Cscript%3E', 'SN', 'XOF']]) {
    const h = boot(query);
    assert.equal(h.select.value, code);
    check(h, code, currency);
    h.dom.window.close();
  }
});
test('no external services, telemetry, storage, locale detection or payment hooks in regional script', () => {
  assert.doesNotMatch(script, /\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|geolocation|sendBeacon)\b|navigator\.|https?:\/\//);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(x => x[1]);
  assert.equal(new Set(ids).size, ids.length, 'IDs stay unique across account and offer dialogs');
});
