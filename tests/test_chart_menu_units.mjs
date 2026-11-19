// The chart menu's order form carries its own size. The shipped bundle calls
// the shell's bridge as quickOrder(side, otype, price, units) from the form's
// Place (and with three arguments from the rows at market); the page's bridge
// must hand the size on, and the ticket's box is the size only when the form
// gave none. The bridge is cut out of app.js as written and run in node:vm
// with the shipped ticket functions (tests/ticket_page.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { page, test, done, src } from './ticket_page.mjs';

const bundle = fs.readFileSync(new URL('../lse_terminal/ui/static/chart/chart.js', import.meta.url), 'utf8');
const mount = fs.readFileSync(new URL('../frontend/src/mount.tsx', import.meta.url), 'utf8');

// the bridge's quickOrder entry, exactly as app.js writes it
function bridge(c) {
  const m = src.match(/\n\s*quickOrder: (\([^)]*\) => [^\n]*?),\n/);
  assert.ok(m, 'app.js has no quickOrder bridge');
  return vm.runInContext('(' + m[1] + ')', c);
}

await test('the form\'s 500 units are sent as 500, whatever the ticket\'s box holds', async () => {
  const c = page();
  c.$('tpx-qty').value = '2000';
  const quickOrder = bridge(c);
  c.answers.push({ status: 200, body: { order_id: 'o1', status: 'resting' } });
  await quickOrder('buy', 'limit', 1.2495, 500);        // the form's Place: side, type, price, units
  const sent = c.sent.at(-1);
  assert.equal(sent.url, '/api/broker/order/pending');
  assert.deepEqual([sent.body.side, sent.body.type, sent.body.price, sent.body.qty], ['buy', 'limit', 1.2495, 500]);
});
await test('with no size from the caller the ticket\'s box is the size', async () => {
  const c = page();
  c.$('tpx-qty').value = '2000';
  const quickOrder = bridge(c);
  c.answers.push({ status: 200, body: { order_id: 'o1', status: 'resting' } });
  await quickOrder('sell', 'stop', 1.2601);
  assert.equal(c.sent.at(-1).body.qty, 2000);
  c.answers.push({ status: 200, body: { status: 'filled', fill: { price: 1.27 } } });
  await quickOrder('buy', 'market', 1.27);              // the rows at market: the ticket's size
  assert.deepEqual([c.sent.at(-1).url, c.sent.at(-1).body.qty], ['/api/broker/order', 2000]);
});
// ── the form's price, as it is filled in ────────────────────────────────────
// At the instrument's declared places (the digits the chart already holds for
// its source and symbol), as a plain decimal with no thousands separator; an
// instrument with no declared places keeps the rule by size. The case:
// AUD_USD (five places) clicked at 0.694281 must not fill "0.694281", which
// the broker's adapter refuses (more decimals than the instrument's 5).
const utils = fs.readFileSync(new URL('../frontend/src/lib/utils.ts', import.meta.url), 'utf8');
function shippedFill() {
  const from = bundle.indexOf('let __lsePxDigits=');
  const to = bundle.indexOf('function rF(', from);
  assert.ok(from >= 0 && to > from, 'the bundle keeps the declared digits beside its formatter');
  const c = { Object, Number, Map, Math, String, isFinite };
  vm.createContext(c);
  vm.runInContext(bundle.slice(from, to) + ';globalThis.set=__lseSetPxDigits;'
    + 'globalThis.fill=typeof __lseOrderPrice==="function"?__lseOrderPrice:null;', c);
  return c;
}
function sourceFill() {
  const begin = utils.indexOf('const declaredDigits = ');
  const fnAt = utils.indexOf('export function orderFormPrice(');
  assert.ok(begin > 0, 'utils.ts keeps the declared digits');
  const set = utils.slice(utils.indexOf('export function setPriceDigits('), utils.indexOf('\n}\n',
    utils.indexOf('export function setPriceDigits(')) + 2);
  let code = 'const declaredDigits = new Map();\nlet declaredVersion = 0;\n' + set;
  if (fnAt > 0) code += '\n' + utils.slice(fnAt, utils.indexOf('\n}\n', fnAt) + 2);
  // its type annotations taken out (there is no TypeScript compiler here)
  code = code.replace(/^export /gm, '').replace(/ as string\b/g, '');
  for (let i = 0; i < 5; i++) code = code.replace(/<[^<>()]*>/g, '');           // generics
  code = code.replace(/\(([^()]*)\)\s*(?::\s*[A-Za-z]+)?\s*\{/g, (m, params) =>
    '(' + params.split(',').map((x) => x.replace(/\??\s*:[\s\S]*$/, '').trim()).join(', ') + ') {');
  const c = { Object, Number, Map, Math, String, isFinite };
  vm.createContext(c);
  vm.runInContext(code + ';globalThis.set=setPriceDigits;'
    + 'globalThis.fill=typeof orderFormPrice==="function"?orderFormPrice:null;', c);
  return c;
}
for (const [where, make] of [['the shipped bundle', shippedFill], ['its source (utils.ts)', sourceFill]]) {
  await test(`${where}: the form's price is filled at the instrument's declared places`, () => {
    const c = make();
    assert.equal(typeof c.fill, 'function', 'no form price function');
    const SRC = 'broker:my-oanda';
    c.set({ AUD_USD: 5, EUR_USD: 5, USD_JPY: 3, XAU_USD: 3, 'BTC/USD': 9, US500: 1, JP225: 0 }, SRC);
    // five places, 0.694281 clicked
    assert.equal(c.fill(0.694281, 'AUD_USD', SRC), '0.69428');
    assert.equal(c.fill(1.277051, 'EUR_USD', SRC), '1.27705');
    assert.equal(c.fill(184.5771, 'USD_JPY', SRC), '184.577');
    // a plain decimal: no thousands separator, never the exponent form
    assert.equal(c.fill(10000.1234, 'XAU_USD', SRC), '10000.123');
    assert.equal(c.fill(73154.66238472, 'BTC/USD', SRC), '73154.662384720');
    assert.equal(c.fill(0.0000001234, 'BTC/USD', SRC), '0.000000123');
    assert.equal(c.fill(5012.26, 'US500', SRC), '5012.3');
    assert.equal(c.fill(38500.6, 'JP225', SRC), '38501');
    // none declared, or another source's: today's rule, by size
    for (const [p, sym, src, want] of [
      [0.694281, 'AUD_USD', 'lse', '0.694281'], [0.694281, 'NZD_USD', SRC, '0.694281'],
      [1.277051, 'EUR/USD', 'lse', '1.2771'], [184.5771, 'USD/JPY', 'lse', '184.577'],
      [10000.1234, 'XAU', 'lse', '10000.12'], [0.694281, 'AUD_USD', null, '0.694281'],
      [0.694281, undefined, SRC, '0.694281'],
    ]) assert.equal(c.fill(p, sym, src), want, `${p} ${sym} ${src}`);
  });
}
await test('the bundle and its source fall back to the chart\'s own source for the form price', () => {
  // The form is filled at the INSTRUMENT the order goes to (its places, its
  // tick: test_chart_trade). Where that instrument declares no places, the
  // clicked level is filled at the places the chart's source declares
  // (__lseOrderPrice / orderFormPrice, from the chart's symbol and source), as
  // before. The old magnitude-only prefill is gone.
  assert.match(bundle, /:__lseOrderPrice\(ns,e,n\):""\)/, 'the bundle\'s fallback is the chart source');
  assert.ok(!bundle.includes('String(+ns.toFixed(ns>=1e3?2:ns>=100?3:ns>=1?4:6))'), 'the old prefill is gone');
  // in the bundle, the chart component's provider is `n` and its symbol `e`
  assert.match(bundle, /function mwt\(\{provider:n,symbol:e,timeframe:t,/);
  assert.match(mount, /: orderFormPrice\(p, symbol, provider\)\)\s*: ''\);/);
  assert.match(mount, /import \{ setPriceDigits, orderFormPrice \} from '@\/lib\/utils';/);
});

await test('the bundle and its source call the bridge with the form\'s size', () => {
  assert.match(bundle, /\.quickOrder\)==null\|\|\w+\.call\(\w+,\w+\.side,\w+\.otype,\w+,\w+\)/,
               'the shipped bundle\'s form Place passes four arguments');
  assert.match(mount, /__lseShell\?\.quickOrder\?\.\(ordForm\.side, ordForm\.otype, pv, qv\)/);
});

done('test_chart_menu_units.mjs');
