// A source's instruments on the chart, at their own precision. The chart's one
// price formatter (formatPriceForSymbol in frontend/src/lib/utils.ts, built
// into the shipped lse_terminal/ui/static/chart/chart.js) prints the axis, the
// OHLC line, the price tag and the position labels. It guessed the decimals
// from how a symbol is spelt, and read a pair spelt EUR_USD (one broker's
// spelling) as a share: 1.27705 printed "1.28". The page hands it the decimals
// its source declares for each instrument (a broker's catalog), and it prints
// those, as a maximum.
//
// What is pinned, on the SHIPPED bundle (its own code cut out and run) and on
// the page:
//   1. a declared precision is a maximum. Where a price of its size can use
//      it (about seven significant figures) it is printed in full, so every
//      label of an instrument carries it alike (a pair's 1.27100); a venue
//      whose increment is finer than that (nine places for every coin) is
//      cut to what the price can use, never below two (74,193.08, not
//      74,193.080000000), and no zero is trimmed from what is printed;
//   1b. one axis, one number of places: the places are chosen once, from the
//      largest label the axis draws, and used for every label, the
//      crosshair and the last-price label, so a precision does not change
//      across a power of ten (9,999.50 beside 10,000.00, not 9,999.500);
//   1c. the page prints a price of an instrument whose source declares its
//      digits by the same rule (fmtPx), so the ticket, the sidebar and the
//      fills show the chart's places (1.28080, not 1.2808);
//   2. the declarations are kept by source and symbol: a chart reads only its
//      own source's, so one source's digits never reach another source's
//      chart; a source's are replaced whole when it sends them again, and a
//      value that is not a precision is ignored;
//   3. with none declared, a pair spelt AAA_BBB is read as a pair (JPY to 3),
//      not as a share, and every other rule is as before;
//   4. the bundle's mount and update hand `priceDigits` and its source to the
//      formatter and keep both out of the chart's props; the shell's chart,
//      its grid's panels and the panes chart the shell's source and say so;
//      the formatter's memos (the labels and the axis width) are redone when
//      the declarations or the source change; the backtest's chart, which
//      replays a source that declares none, reads none;
//   5. the source the bundle is built from says the same;
//   6. the page sends the active source's declarations, named by the source
//      they came from, when they change, and only then.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const bundle = fs.readFileSync(new URL('../lse_terminal/ui/static/chart/chart.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../lse_terminal/ui/static/app.js', import.meta.url), 'utf8');
const utils = fs.readFileSync(new URL('../frontend/src/lib/utils.ts', import.meta.url), 'utf8');
const mount = fs.readFileSync(new URL('../frontend/src/mount.tsx', import.meta.url), 'utf8');
const prochart = fs.readFileSync(new URL('../frontend/src/components/chart/ProChart.tsx', import.meta.url), 'utf8');
const btchart = fs.readFileSync(new URL('../frontend/src/components/chart/BTChart.tsx', import.meta.url), 'utf8');
const grid = fs.readFileSync(new URL('../frontend/src/components/chart/TerminalMultiGrid.tsx', import.meta.url), 'utf8');

// ── 1-3. the shipped formatter, and the source it is built from ────────────
// The same cases run on both: the bundle's own code, and utils.ts with its
// type annotations taken out (there is no TypeScript compiler here, and the
// bundle cannot be rebuilt), so the two are pinned alike by what they print.
const from = bundle.indexOf('let __lsePxDigits=');
assert.ok(from >= 0, 'the bundle keeps the declared digits beside its formatter');
const to = bundle.indexOf('const sF=', bundle.indexOf('function iF(', from));
function shipped() {
  const c = { Object, Number, Map, Math, String, isFinite };
  vm.createContext(c);
  vm.runInContext(bundle.slice(from, to) + ';globalThis.fmt=rF;globalThis.width=iF;'
    + 'globalThis.set=__lseSetPxDigits;globalThis.ver=__lsePxDigitsVersion;'
    + 'globalThis.axis=typeof __lseAxisScale==="function"?__lseAxisScale:null;', c);
  return c;
}
// utils.ts's registry and formatter, its annotations removed
function source() {
  const begin = utils.indexOf('const declaredDigits = ');
  const end = utils.indexOf('/**', utils.indexOf('export function formatPriceForSymbol('));
  assert.ok(begin > 0 && end > begin, 'utils.ts has the registry and the formatter');
  let code = utils.slice(begin, end).replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^export /gm, '');
  for (let i = 0; i < 5; i++) code = code.replace(/<[^<>()]*>/g, '');         // generics
  code = code.replace(/\(([^()]*)\)\s*(?::\s*[A-Za-z]+)?\s*(=>|\{)/g, (m, params, tail) =>
    '(' + params.split(',').map((x) => x.replace(/\??\s*:[\s\S]*$/, '').trim()).join(', ') + ') ' + tail);
  code = code.replace(/ as string\b/g, '');
  const c = { Object, Number, Map, Math, String, isFinite };
  vm.createContext(c);
  // the axis's scale (priceAxisScale): its signature's types removed by
  // reading the parameter list to its matching bracket (one parameter is a
  // function type); its body has none
  const a0 = utils.indexOf('export function priceAxisScale(');
  let axis = '';
  if (a0 > 0) {
    const fn = utils.slice(a0, utils.indexOf('\n}\n', a0) + 2).replace(/^export /, '');
    const open = fn.indexOf('(');
    let depth = 0, i = open, cuts = [open + 1];
    for (; i < fn.length; i++) {
      if (fn[i] === '(') depth++;
      else if (fn[i] === ')') { depth--; if (depth === 0) break; }
      else if (fn[i] === ',' && depth === 1) cuts.push(i + 1);
    }
    cuts.push(i + 1);
    const names = cuts.slice(0, -1).map((c0, k) => fn.slice(c0, cuts[k + 1] - 1).split(':')[0].replace('?', '').trim());
    axis = 'function priceAxisScale(' + names.join(', ') + ') ' + fn.slice(fn.indexOf('{', i));
  }
  vm.runInContext(code + axis + ';globalThis.fmt=formatPriceForSymbol;globalThis.set=setPriceDigits;'
    + 'globalThis.ver=priceDigitsVersion;globalThis.axis=typeof priceAxisScale==="function"?priceAxisScale:null;', c);
  return c;
}
const SRC = 'broker:my-broker';
function formatterCases(c) {
  const fmt = (p, s, src, scale) => c.fmt(p, s, src, scale);
  // 3. none declared: a pair spelt with an underscore is a pair
  assert.equal(fmt(1.27705, 'EUR_USD'), '1.27705');
  assert.equal(fmt(0.86931, 'EUR_GBP'), '0.86931');
  assert.equal(fmt(154.123, 'USD_JPY'), '154.123');
  // every other rule as before
  assert.equal(fmt(1.27705, 'EUR/USD'), '1.27705');
  assert.equal(fmt(247.1, 'AAPL'), '247.10');
  assert.equal(fmt(2650.123, 'XAU_USD'), '2,650.12');          // a metal: 2
  assert.equal(fmt(121063.64, 'BTC_USD'), '121,063.64');       // not a currency pair
  assert.equal(fmt(1.27705, 'EURUSD'), '1.28');                // spelt as a share, nothing declared
  const undeclared = ['X25', 'XNEG', 'XHALF', 'XTEXT'].map((s) => fmt(1.27705, s, SRC));

  // 1. declared, where the price can use it: printed in full, every label alike
  const v0 = c.ver();
  c.set({ EURUSD: 5, EUR_USD: 5, USD_JPY: 3, XAU_USD: 3, XAG_USD: 5, US500: 1, BTCUSD: 2,
          'BTC/USD': 9, 'ETH/USD': 9, 'DOGE/USD': 9, 'SHIB/USD': 9, AAPL: 9,
          X25: 25, XNEG: -1, XHALF: 2.5, XTEXT: '5' }, SRC);
  assert.ok(c.ver() > v0, 'a new declaration is a new version');
  assert.equal(fmt(1.27705, 'EURUSD', SRC), '1.27705');
  assert.equal(fmt(1.271, 'EUR_USD', SRC), '1.27100', 'a pair keeps its five places on every label');
  assert.equal(fmt(1.2, 'EUR_USD', SRC), '1.20000');
  assert.equal(fmt(154.1, 'USD_JPY', SRC), '154.100');
  assert.equal(fmt(2650.47, 'XAU_USD', SRC), '2,650.470');
  assert.equal(fmt(30.12345, 'XAG_USD', SRC), '30.12345');
  assert.equal(fmt(5001.24, 'US500', SRC), '5,001.2');
  assert.equal(fmt(121063.64, 'BTCUSD', SRC), '121,063.64');
  // ...and where it is finer than the price can use: cut to that, and every
  // price of that size at those places, none trimmed
  assert.equal(fmt(74193.08, 'BTC/USD', SRC), '74,193.08');
  assert.equal(fmt(73000, 'BTC/USD', SRC), '73,000.00');
  assert.equal(fmt(73100.5, 'BTC/USD', SRC), '73,100.50');
  assert.equal(fmt(67390.015047799, 'BTC/USD', SRC), '67,390.02', 'an average of prices, not nine places');
  assert.equal(fmt(3500.12, 'ETH/USD', SRC), '3,500.120', 'beside 3,500.125, at its places');
  assert.equal(fmt(3500.125, 'ETH/USD', SRC), '3,500.125');
  assert.equal(fmt(0.152345, 'DOGE/USD', SRC), '0.1523450');
  assert.equal(fmt(0.15, 'DOGE/USD', SRC), '0.1500000');
  assert.equal(fmt(247.1, 'AAPL', SRC), '247.1000', 'nine declared, four at its size, none trimmed');
  // a coin priced in millionths uses all nine
  assert.equal(fmt(0.0000189, 'SHIB/USD', SRC), '0.000018900');
  assert.equal(fmt(0.000018912, 'SHIB/USD', SRC), '0.000018912');
  // never the exponent form, never more than declared
  for (const [p, s] of [[74193.08, 'BTC/USD'], [1.27705, 'EUR_USD'], [0.0000189, 'SHIB/USD']]) {
    const out = fmt(p, s, SRC);
    assert.ok(!/e/i.test(out), out);
    assert.ok((out.split('.')[1] || '').length <= (s === 'EUR_USD' ? 5 : 9), out);
  }
  // a figure with no size to go by (0, an oscillator below it) keeps the declared places
  assert.equal(fmt(0, 'EUR_USD', SRC), '0.00000');
  assert.equal(fmt(-1.5, 'EUR_USD', SRC), '-1.50000');
  // not a precision: the rules as before
  assert.deepEqual(['X25', 'XNEG', 'XHALF', 'XTEXT'].map((s) => fmt(1.27705, s, SRC)), undeclared);

  // 1b. one axis, one number of places, chosen from its largest label
  assert.equal(typeof c.axis, 'function', 'the axis chooses its places from its largest label');
  const labels = (lo, hi, step) => { const out = []; for (let p = lo; p <= hi + step / 1e6; p += step) out.push(p); return out; };
  const onAxis = (sym, ps, extra = []) => {
    // the axis's own loop: labels every `step`, 30 px apart on a 600 px pane
    const lo = ps[0], hi = ps.at(-1), step = ps[1] - ps[0], range = (hi - lo) + 2 * step, min = lo - step;
    const toY = (p) => 600 - ((p - min) / range) * 600;
    const scale = c.axis(lo, min + range, step, toY, 600, 25);
    return [...ps, ...extra].map((p) => fmt(p, sym, SRC, scale));
  };
  const places = (out) => new Set(out.map((t) => (t.split('.')[1] || '').length));
  // XAU_USD (3 declared) across 10,000: two places on every label
  assert.deepEqual(onAxis('XAU_USD', labels(9999.5, 10000.25, 0.25)),
                   ['9,999.50', '9,999.75', '10,000.00', '10,000.25']);
  // a 5-place instrument across 100: four on every label, the crosshair's
  // and the last price's too
  c.set({ XAU_USD: 3, X5: 5, X6: 6, EUR_USD: 5 }, SRC);
  const across100 = onAxis('X5', labels(99.5, 100.5, 0.25), [99.53127, 100.01234]);
  assert.deepEqual(across100, ['99.5000', '99.7500', '100.0000', '100.2500', '100.5000', '99.5313', '100.0123']);
  assert.deepEqual([...places(onAxis('X6', labels(9.5, 10.5, 0.25), [9.987654]))], [5]);
  // the sum of the steps lands a hair under 100 (99.99999999999997): that
  // label prints as 100, and is one
  {
    const sums = labels(99.5, 100.0, 0.1);
    assert.ok(sums.at(-1) < 100 && sums.at(-1) > 99.9999, String(sums.at(-1)));
    const out = onAxis('X5', sums);
    assert.deepEqual([...places(out)], [4], out.join(' '));
    assert.equal(out.at(-1), '100.0000');
  }
  // within one power of ten an instrument keeps all its declared places
  assert.deepEqual(onAxis('EUR_USD', labels(1.2700, 1.2800, 0.0025), [1.2808]),
                   ['1.27000', '1.27250', '1.27500', '1.27750', '1.28000', '1.28080']);
  // a label the axis does not draw (within 10 px of its top) does not choose
  {
    const toY = (p) => 600 - ((p - 9998.75) / 1.5) * 600;  // 10,000.25 sits 0 px from the top
    const scale = c.axis(9999.0, 10000.25, 0.25, toY, 600, 25);
    assert.ok(scale > 9999.9 && scale < 10000.01, String(scale));
  }
  // nothing to go by (no step, nothing drawn): each label by its own size, as before
  assert.equal(c.axis(1, 2, 0, (p) => p, 600, 25), undefined);
  assert.equal(fmt(99.5, 'X5', SRC, undefined), '99.50000');
  // no declared digits: the scale changes nothing
  assert.equal(fmt(1.27705, 'EURUSD', 'lse', 100000), '1.28');
  c.set({ EURUSD: 5, EUR_USD: 5, USD_JPY: 3, XAU_USD: 3, XAG_USD: 5, US500: 1, BTCUSD: 2,
          'BTC/USD': 9, 'ETH/USD': 9, 'DOGE/USD': 9, 'SHIB/USD': 9, AAPL: 9,
          X25: 25, XNEG: -1, XHALF: 2.5, XTEXT: '5' }, SRC);

  // 2. by source: another source's chart, or a chart that names none, reads none
  assert.equal(fmt(1.27705, 'EURUSD', 'lse'), '1.28');
  assert.equal(fmt(1.27705, 'EURUSD'), '1.28');
  assert.equal(fmt(74193.08, 'BTC/USD', 'lse'), '74,193.08');   // the crypto rule, not nine places
  assert.equal(fmt(0.0000189, 'SHIB/USD'), '0.000019', 'the rules, as before, for a chart of no source');
  c.set({ EURUSD: 3 }, 'broker:other');
  assert.equal(fmt(1.27705, 'EURUSD', 'broker:other'), '1.277');
  assert.equal(fmt(1.27705, 'EURUSD', SRC), '1.27705', 'one source\'s declarations leave another\'s alone');
  // replaced whole when its source sends them again; none without a source
  c.set({}, SRC);
  assert.equal(fmt(1.27705, 'EURUSD', SRC), '1.28');
  c.set(null, SRC);
  assert.equal(fmt(2650.123, 'XAU_USD', SRC), '2,650.12');
  c.set({ EURUSD: 5 }, '');
  assert.equal(fmt(1.27705, 'EURUSD', ''), '1.28');
  assert.equal(fmt(1.27705, 'EURUSD'), '1.28');
}
formatterCases(source());
{
  const c = shipped();
  formatterCases(c);
  // the axis is measured with the same formatter, for the same source
  c.set({ 'BTC/USD': 9 }, SRC);
  assert.equal(c.width(false, 'BTC/USD', 74193.08, 6, SRC), c.width(false, 'BTC/USD', 74193.08, 6, 'lse'),
               'nine declared places do not widen the axis past the price\'s own');
  c.set({ XAU_USD: 3 }, SRC);
  assert.ok(c.width(false, 'XAU_USD', 2650.47, 6, SRC) > c.width(false, 'XAU_USD', 2650.47, 6, 'lse'),
            'a third place declared widens it');
}

// ── 4. the bundle's mount and update, the charts that read them, the memos ──
{
  const yj = bundle.slice(bundle.indexOf('function Yj(n){'), bundle.indexOf('const qj={'));
  assert.match(yj, /"priceDigits"in n&&\(__lseSetPxDigits\(n\.priceDigits,"priceSource"in n\?n\.priceSource:n\.provider\),delete e\.priceDigits\),delete e\.priceSource,e\}/);
  assert.match(bundle, /const qj=\{async mount\(n,e=\{\}\)\{wA=\{\.\.\.wA,\.\.\.Yj\(e\)\}/);
  assert.match(bundle, /update\(n\)\{wA=\{\.\.\.wA,\.\.\.Yj\(n\)\},AK\(\)\}/);
  // the formatter reads a source's own; the axis width passes it on
  assert.match(bundle, /function __lseSetPxDigits\(n,s\)\{/);
  assert.match(bundle, /function rF\(n,e,s,S\)\{/);
  assert.match(bundle, /function iF\(n,e,t,r,S\)\{const i=t\|\|100,s=typeof window<"u"&&window\.innerWidth>=1024,l=rF\(i,e,S\)\.length/);
  // ProChart takes the source it charts, and its two memos read and follow it
  const kf = bundle.slice(bundle.indexOf('const KF=({candles:n,'), bundle.indexOf('})=>{', bundle.indexOf('const KF=({candles:n,')));
  assert.match(kf, /,priceSource:__lsePs\b/);
  assert.equal([...bundle.matchAll(/w\.useMemo\(\(\)=>iF\([^)]*,__lsePs\),\[[^\]]*,__lsePs,__lsePxDigitsVersion\(\)\]\)/g)].length, 1);
  // the shell's chart, its grid's panels and the panes say which source they chart
  const tc = bundle.slice(bundle.indexOf('function mwt({provider:n,symbol:e,'), bundle.indexOf('function vwt('));
  assert.match(tc, /u\.jsx\(KF,\{candles:r,symbol:e,priceSource:n,/);
  assert.match(tc, /u\.jsx\(S7e,\{layout:ge,syncSettings:ne,pair:e,timeframe:t,colors:Nt,quote:o,priceSource:n\}\)/);
  assert.match(bundle, /function S7e\(\{layout:n,syncSettings:e,pair:t,timeframe:r,colors:i,quote:s,priceSource:__lsePs\}\)/);
  assert.match(bundle, /onViewportTimeChange:y,quote:s,priceSource:__lsePs\},S\)/);
  assert.match(bundle, /function w7e\(\{symbol:n,timeframe:e,colors:t,active:r,onActivate:i,syncedCrosshairTime:s,onCrosshairMove:a,syncedViewportTime:l,onViewportTimeChange:o,quote:c,priceSource:__lsePs\}\)/);
  assert.match(bundle, /u\.jsx\(KF,\{candles:d,symbol:n,priceSource:__lsePs,timeframe:e,/);
  assert.match(bundle, /function vwt\(\{symbol:n,timeframe:e,candles:t,quote:r,provider:__lsePs\}\)/);
  assert.match(bundle, /u\.jsx\(KF,\{candles:t,symbol:n,priceSource:__lsePs,timeframe:e,/);
  // 1b. ProChart chooses its places once a draw, from the quote's
  // max(|bid|,|ask|) (brokerBid:D, brokerAsk:H), before any label is drawn, and
  // its one formatter reads them; the label loop below still draws the gridlines
  assert.match(bundle, /ni=w\.useRef\(null\),Br=w\.useRef\(0\),__lseAx=w\.useRef\(void 0\),/);
  assert.match(bundle, /__lseAx\.current=\(\(\)=>\{const zs=\[D,H\]\.map\(Number\)\.filter\(zv=>isFinite\(zv\)&&zv!==0\)\.map\(Math\.abs\);return zs\.length\?Math\.max\(\.\.\.zs\):void 0\}\)\(\);j\.beginPath\(\);/);
  assert.ok(!bundle.includes('__lseAx.current=__lseAxisScale('), 'the axis is no longer the chart\'s label size');
  assert.equal([...bundle.matchAll(/w\.useCallback\((\w+)=>rF\(\1,t,__lsePs,__lseAx\.current\),\[t,__lsePs,__lsePxDigitsVersion\(\)\]\)/g)].length, 1);
  {
    // the formatter's first use after its definition is in the draw, after the places are chosen
    const def = bundle.indexOf('cd=w.useCallback(ze=>rF(');
    const draw = bundle.indexOf('__lseAx.current=(()=>{const zs=[D,H]');
    const first = def + 30 + bundle.slice(def + 30).search(/[^\w.$]cd\(/);
    assert.ok(def > 0 && draw > def && first > draw, 'the places are chosen before the first label of a draw');
    // the label loop still draws the gridlines over the same price geometry
    const loop = bundle.slice(draw, draw + 1000);
    assert.match(loop, /for\(let Lt=xh;Lt<=Ca\.max;Lt\+=Nl\)\{const Ve=Xa\(Lt\);/);
  }
  // the backtest's chart (BTChart) names no source, so it reads no declarations
  assert.match(bundle, /la=w\.useMemo\(\(\)=>iF\(Vg,t,as\|\|100,F\),\[Vg,zp,t,as,F\]\)/);
  assert.match(bundle, /Jo=w\.useCallback\(Et=>rF\(Et,t\),\[t\]\)/);
  // nothing else formats a price without saying which source's it is
  assert.equal([...bundle.matchAll(/=>rF\(\w+,t\)/g)].length, 1, 'only the backtest\'s chart calls rF with no source');
}

// ── 5. the source says the same ───────────────────────────────────────────
{
  assert.match(utils, /export function setPriceDigits\(map: Record<string, unknown> \| null \| undefined, source\?: string \| null\): void \{/);
  assert.match(utils, /export function priceDigitsVersion\(\): number \{/);
  const body = utils.slice(utils.indexOf('export function formatPriceForSymbol('));
  const declared = body.indexOf('declaredDigits.get(source)');
  assert.ok(declared > 0 && declared < body.indexOf('metalPatterns'), 'the declaration is read first, by source');
  assert.ok(body.indexOf('/^[A-Z]{3}_[A-Z]{3}$/') < body.indexOf('const isStock'), 'the pair rule comes before shares');
  assert.match(utils, /const formatted = formatPriceForSymbol\(price, symbol, source\);/);
  assert.match(mount, /if \('priceDigits' in next\) \{\s*setPriceDigits\(next\.priceDigits, 'priceSource' in next \? next\.priceSource : next\.provider\);\s*delete out\.priceDigits;\s*\}\s*delete out\.priceSource;/);
  assert.match(mount, /<ProChart\s+candles=\{candles\}\s+symbol=\{symbol\}\s+priceSource=\{provider\}/);
  assert.match(mount, /<TerminalMultiGrid[^>]*priceSource=\{provider\}/);
  assert.match(mount, /function PaneChart\(\{ symbol, timeframe, candles, quote, provider \}/);
  assert.match(grid, /<Panel[\s\S]*?priceSource=\{priceSource\}/);
  assert.match(grid, /<ProChart\s+candles=\{candles\}\s+symbol=\{symbol\}\s+priceSource=\{priceSource\}/);
  assert.match(prochart, /return formatPriceForSymbol\(price, symbol, priceSource, priceLabelScaleRef\.current\);\s*(\/\/[^\n]*\n\s*)*\}, \[symbol, priceSource, priceDigitsVersion\(\)\]\);/);
  assert.match(prochart, /calculatePriceAxisWidth\(isMobile, symbol, samplePrice \|\| 100, rightOffset, priceSource\);\s*\}, \[isMobile, isDesktop, symbol, samplePrice, rightOffset, priceSource, priceDigitsVersion\(\)\]\);/);
  // 1b, the source: the formatter still takes a `scale`; ProChart now
  // gives it the quote's max(|bid|,|ask|), before it draws, and its formatter
  // reads it. priceAxisScale stays in utils.ts for the grid and backtest charts.
  assert.match(utils, /export function formatPriceForSymbol\(price: number, symbol\?: string, source\?: string \| null, scale\?: number\): string \{/);
  assert.match(utils, /export function priceAxisScale\(/);
  assert.match(prochart, /return formatPriceForSymbol\(price, symbol, priceSource, priceLabelScaleRef\.current\);/);
  assert.match(prochart, /priceLabelScaleRef\.current = \(\(\) => \{\s*const sides = \[brokerBid, brokerAsk\]\.map\(Number\)\.filter\(\(v\) => isFinite\(v\) && v !== 0\)\.map\(Math\.abs\);\s*return sides\.length \? Math\.max\(\.\.\.sides\) : undefined;\s*\}\)\(\);/);
  assert.ok(!prochart.includes('priceLabelScaleRef.current = priceAxisScale('), 'the axis is no longer ProChart\'s label size');
  assert.ok(prochart.indexOf('priceLabelScaleRef.current = (() => {') < prochart.indexOf('ctx.fillText(formatPrice(price), priceLabelX, y);'));
  assert.match(btchart, /return formatPriceForSymbol\(price, symbol\);\s*(\/\/[^\n]*\n\s*)*\}, \[symbol\]\);/);
  assert.match(btchart, /\}, \[isMobile, isDesktop, symbol, samplePrice, rightOffset\]\);/);
  assert.ok(!btchart.includes('priceDigitsVersion'), 'the backtest\'s chart reads no declarations');
}

// ── 1c. the page prints a declared instrument's prices by the chart's rule ──
{
  const s0 = app.indexOf('function fmtPx(');
  const p = { Number, Math, isFinite, String };
  vm.createContext(p);
  vm.runInContext(app.slice(s0, app.indexOf('\n}\n', s0) + 2), p);
  const c = shipped();
  const plain = (t) => t.replace(/,/g, '');
  // EUR_USD: BUY 1.28040 beside SELL 1.28022, filled @ 1.28080
  assert.equal(p.fmtPx(1.2804, 5), '1.28040');
  assert.equal(p.fmtPx(1.2808, 5), '1.28080');
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 3000; i++) {
    const digits = Math.floor(rnd() * 10);
    const value = Math.pow(10, Math.floor(rnd() * 12) - 6) * (1 + rnd() * 9);
    c.set({ X: digits }, SRC);
    assert.equal(p.fmtPx(value, digits), plain(c.fmt(value, 'X', SRC)), `${value} at ${digits}`);
    const scale = value * (1 + rnd() * 20);
    assert.equal(p.fmtPx(value, digits, scale), plain(c.fmt(value, 'X', SRC, scale)), `${value} at ${digits}, by ${scale}`);
  }
}

// ── 6. the page sends its source's declarations, named, when they change ────
{
  const cutFn = (name) => {
    const s = app.indexOf('function ' + name + '(');
    assert.ok(s >= 0, 'no function ' + name);
    return app.slice(s, app.indexOf('\n}\n', s) + 2);
  };
  const pushed = [];
  const p = {
    state: { candleData: [{ ts: 1 }], provider: 'broker:my-broker', symbol: 'EUR_USD', timeframe: '1h',
             chartType: 'candles', quotes: {}, chartMounted: true, digitsBySym: { EUR_USD: 5, USD_JPY: 3 },
             digitsSource: 'broker:my-broker', digitsVer: 1 },
    chartNoteState: { kind: '' }, chartNote() {},
    window: { LSEChart: { update: (x) => pushed.push(x), mount: (el, x) => pushed.push(x) } },
    $: () => ({}),
  };
  vm.createContext(p);
  vm.runInContext(cutFn('chartDigitsPayload') + cutFn('chartDigitsSource') + cutFn('chartPushDigits')
    + cutFn('pushToChart'), p);
  p.pushToChart();
  assert.deepEqual({ ...pushed[0].priceDigits }, { EUR_USD: 5, USD_JPY: 3 });
  assert.equal(pushed[0].priceSource, 'broker:my-broker');
  p.pushToChart();
  assert.equal('priceDigits' in pushed[1], false, 'sent once, not with every bar');
  assert.equal('priceSource' in pushed[1], false);
  // a source switch that lands its instruments before its bars: named by the
  // source they came from, not by the one the chart still shows
  p.state.digitsBySym = {}; p.state.digitsSource = 'lse'; p.state.digitsVer = 2;
  p.chartPushDigits();
  assert.deepEqual([{ ...pushed[2].priceDigits }, pushed[2].priceSource], [{}, 'lse']);
  // loadInstruments keeps which source its digits came from, on both of its paths
  const load = app.slice(app.indexOf('async function loadInstruments('), app.indexOf('\n}\n', app.indexOf('async function loadInstruments(')));
  assert.equal([...load.matchAll(/state\.digitsVer = \(state\.digitsVer \|\| 0\) \+ 1;/g)].length, 2);
  assert.equal([...load.matchAll(/chartPushDigits\(\);/g)].length, 2);
  assert.equal([...load.matchAll(/state\.digitsSource = asked;/g)].length, 2);
  assert.match(load, /if \(state\.digitsSource !== asked\) \{ state\.digitsBySym = \{\}; state\.digitsSource = asked; \}/);
}

console.log('test_chart_price_digits.mjs: ok');
