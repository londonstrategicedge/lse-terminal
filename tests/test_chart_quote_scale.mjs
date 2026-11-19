// One instrument, one number of places, on the chart AND on the page.
// Guarded against: beside a power of ten the chart's labels (axis, last
// price, crosshair) and the page's labels printing different places (XAU_USD
// at 9999.50/9999.80: chart "9,999.50", ticket "9999.500"), from a chart that
// chooses its places by its AXIS's largest label (which can be 10,000 when the
// quote is 9,999.80) while the page chooses by the quote's max(bid, ask).
// The rule: a declared instrument's chart is given the quote's max(bid, ask)
// as the size its places are chosen by, so both choose by one size; with no
// quote held (the page keeps the last quote, so this is only before the first
// tick), each label by the value. The shipped bundle's formatter rF and axis
// scale __lseAxisScale, and the page's fmtPx / quoteScale, are cut out and run.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const bundle = fs.readFileSync(new URL('../lse_terminal/ui/static/chart/chart.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../lse_terminal/ui/static/app.js', import.meta.url), 'utf8');
const prochart = fs.readFileSync(new URL('../frontend/src/components/chart/ProChart.tsx', import.meta.url), 'utf8');

const results = [];
async function test(name, f) {
  try { await f(); results.push(true); console.log('ok    ' + name); }
  catch (e) { results.push(false); console.log('FAIL  ' + name + '\n        ' + String(e.message || e).split('\n').slice(0, 10).join('\n        ')); }
}
const cutApp = (name) => { const s = app.indexOf('function ' + name + '('); assert.ok(s >= 0, 'no ' + name);
  return app.slice(s, app.indexOf('\n}\n', s) + 2); };
const fmtLine = app.match(/^const fmt = .*$/m)[0];
function page() {
  const p = { Number, Math, isFinite, String, state: { digitsBySym: {}, quotes: {}, catBySym: {}, pipDec: {} } };
  vm.createContext(p);
  vm.runInContext(fmtLine + '\n' + ['fmtPx', 'srcDigits', 'quoteScale', 'fmtQuote'].map(cutApp).join('\n'), p);
  return p;
}
function chart() {
  const from = bundle.indexOf('let __lsePxDigits=');
  const to = bundle.indexOf('const sF=', bundle.indexOf('function iF(', from));
  const c = { Object, Number, Map, Math, String, isFinite };
  vm.createContext(c);
  vm.runInContext(bundle.slice(from, to) + ';globalThis.rF=rF;globalThis.set=__lseSetPxDigits;globalThis.axis=__lseAxisScale;', c);
  return c;
}
const places = (s) => { const m = String(s).match(/\.(\d+)$/); return m ? m[1].length : 0; };

// ── 1. the wiring: the chart's label scale is the quote's max(bid, ask) ──────
await test('1. the bundle chooses the chart\'s places from the quote, not the axis', () => {
  // the draw sets __lseAx.current (the size rF reads for every label) from the
  // chart's quote props (brokerBid:D, brokerAsk:H), max of the finite sides
  assert.ok(!bundle.includes('__lseAx.current=__lseAxisScale('), 'the axis is no longer the chart\'s label size');
  assert.match(bundle, /__lseAx\.current=\(\(\)=>\{const \w+=\[D,H\]\.map\(Number\)\.filter\(\w+=>isFinite\(\w+\)&&\w+!==0\)\.map\(Math\.abs\);return \w+\.length\?Math\.max\(\.\.\.\w+\):void 0\}\)\(\)/,
               'the bundle sizes by the quote\'s max(bid, ask)');
  // rF still reads that size (unchanged), and __lseAxisScale still exists for
  // the other charts (the grid, the backtest)
  assert.match(bundle, /=>rF\(\w+,t,__lsePs,__lseAx\.current\)/, 'rF reads the size');
  assert.match(bundle, /function __lseAxisScale\(/, '__lseAxisScale stays for the other charts');
});
await test('2. ProChart.tsx says the same', () => {
  assert.ok(!prochart.includes('priceLabelScaleRef.current = priceAxisScale('), 'the axis is no longer ProChart\'s label size');
  assert.match(prochart, /priceLabelScaleRef\.current = \(\(\) => \{\s*const sides = \[brokerBid, brokerAsk\]\.map\(Number\)\.filter\(\(v\) => isFinite\(v\) && v !== 0\)\.map\(Math\.abs\);\s*return sides\.length \? Math\.max\(\.\.\.sides\) : undefined;\s*\}\)\(\);/,
               'ProChart sizes by the quote\'s max(bid, ask)');
  assert.match(prochart, /return formatPriceForSymbol\(price, symbol, priceSource, priceLabelScaleRef\.current\);/,
               'formatPrice still reads the size');
});

// ── 3. the cases: the chart and the page print the same places ────────────────
// [label, symbol, digits, bid, ask, axis low, axis high, axis step]
const cases = [
  ['XAU_USD below 10,000, axis to 10,001', 'XAU_USD', 3, 9999.50, 9999.80, 9997, 10001, 0.5],
  ['XAU_USD across 10,000, axis below it', 'XAU_USD', 3, 9999.70, 10000.00, 9996, 9999.9, 0.5],
  ['ETH/USD below 1,000, axis to 1,001', 'ETH/USD', 9, 999.40, 999.70, 997, 1001, 0.5],
  ['SOL/USD below 100, axis to 100.4', 'SOL/USD', 9, 99.91, 99.95, 99.4, 100.4, 0.1],
  ['DOGE/USD below 0.1, axis to 0.1003', 'DOGE/USD', 9, 0.09991, 0.09994, 0.0995, 0.1003, 0.0001],
  ['USDC/USD below 1, axis to 1.0003', 'USDC/USD', 9, 0.99985, 0.99995, 0.9996, 1.0003, 0.0001],
  ['control: EUR_USD', 'EUR_USD', 5, 1.28022, 1.28040, 1.2795, 1.2810, 0.0002],
];
await test('3. beside a power of ten the chart\'s places equal the ticket\'s (quote-sized)', () => {
  const p = page(), c = chart();
  let axisWouldDisagree = 0;
  for (const [label, s, d, bid, ask, lo, hi, step] of cases) {
    p.state.digitsBySym = { [s]: d }; p.state.quotes = { [s]: { bid, ask } };
    c.set({ [s]: d }, 'broker:x');
    const qScale = p.quoteScale({ bid, ask });                          // the page's size
    assert.ok(qScale === Math.max(Math.abs(bid), Math.abs(ask)), 'the size is max(bid, ask)');
    // the chart's labels, now sized by the quote (as the draw now does)
    const chartLast = c.rF(bid, s, 'broker:x', qScale);
    const chartCross = c.rF((bid + ask) / 2, s, 'broker:x', qScale);
    // the ticket's bid, and the sidebar, sized by the same quote
    const ticketBid = p.fmtPx(bid, d, qScale);
    const sidebar = p.fmtQuote(s, bid);
    assert.equal(places(chartLast), places(ticketBid), `${label}: chart ${chartLast} vs ticket ${ticketBid}`);
    assert.equal(places(chartCross), places(ticketBid), `${label}: crosshair ${chartCross}`);
    assert.equal(places(sidebar), places(ticketBid), `${label}: sidebar ${sidebar}`);
    // and the old wiring (the axis's largest label) WOULD have disagreed here
    const toY = (v) => 600 - ((v - lo) / (hi - lo)) * 600;
    const aScale = c.axis(Math.ceil(lo / step) * step, hi, step, toY, 600, 25);
    if (places(c.rF(bid, s, 'broker:x', aScale)) !== places(ticketBid)) axisWouldDisagree += 1;
  }
  assert.ok(axisWouldDisagree >= 3, `the axis-sized chart disagreed in ${axisWouldDisagree} cases (what sizing by the quote prevents)`);
});

const bad = results.filter((r) => !r).length;
if (bad) { console.log(`test_chart_quote_scale.mjs: ${bad} of ${results.length} blocks FAILED`); process.exitCode = 1; }
else console.log(`test_chart_quote_scale.mjs: ok (${results.length} blocks)`);
