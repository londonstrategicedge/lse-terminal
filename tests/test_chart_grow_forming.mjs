// A broker chart's re-ask (chartGrowApply) keeps the live bar the stream is forming; once the venue
// sends that bar closed, the venue's own bar wins. Runs the actual app.js function.
import fs from 'node:fs'; import vm from 'node:vm'; import assert from 'node:assert/strict';
const src = fs.readFileSync(new URL('../lse_terminal/ui/static/app.js', import.meta.url), 'utf8');
const a = src.indexOf('function chartGrowApply(data)'); const b = src.indexOf('\n}', a) + 2; assert(a >= 0 && b > a);
function fixture(lastBar, tick = null) {
  const ctx = { state: { candleData: [], lastBar, engineIndicators: {}, symbol: 'AAPL', timeframe: '1h',
                         prices: tick ? { AAPL: tick.price } : {}, priceTimes: tick ? { AAPL: tick.ms } : {} },
    chartGrow: { shown: 0, held: {} }, TF_SECONDS: { '1m': 60, '1h': 3600 }, Date, Math,
    pushToChart() { ctx.paints++; }, chartGrowPaint() {}, paints: 0 };
  vm.createContext(ctx); vm.runInContext(src.slice(a, b), ctx); return ctx;
}
const page = { candles: [[60, 1, 2, 0.5, 1.5, 10], [120, 1.5, 3, 1, 2, 20]], indicators: {} };
// the stream's forming bar is newer than the page: kept, still the last bar
let c = fixture({ time: 180, open: 2, high: 2.5, low: 1.9, close: 2.2 }); c.chartGrowApply(page);
assert.equal(c.state.candleData.length, 3); assert.equal(c.state.lastBar.time, 180); assert.equal(c.state.lastBar.close, 2.2);
assert.equal(c.state.lastBar.high, 2.5); assert.equal(c.chartGrow.shown, 2); assert.equal(c.paints, 1); assert.equal(c.chartGrow.held, null);
// the venue now sends that bucket closed: its bar wins, no duplicate
c = fixture({ time: 120, open: 9, high: 9, low: 9, close: 9 }); c.chartGrowApply(page);
assert.equal(c.state.candleData.length, 2); assert.equal(c.state.lastBar.close, 2);
// no bar before (nothing streamed yet)
c = fixture(null); c.chartGrowApply(page); assert.equal(c.state.candleData.length, 2); assert.equal(c.state.lastBar.time, 120);
// an empty page never carries a bar of its own
c = fixture({ time: 180, open: 2, high: 2, low: 2, close: 2 }); c.chartGrowApply({ candles: [] });
assert.equal(c.state.candleData.length, 0); assert.equal(c.state.lastBar, null);
// the page ends with the SAME bar, still forming (built by the engine from the venue's minutes): its open stands,
// the stream's latest price stays the close (it never steps back to the last closed minute's), extremes kept
const H = 3600, now = Math.floor(Date.now() / 1000), cur = Math.floor(now / H) * H;
const page2 = { candles: [[cur - H, 1, 2, 0.5, 1.5, 10], [cur, 353.67, 354.21, 353.075, 354.09, 99]] };
c = fixture({ time: cur, open: 353.67, high: 354.3, low: 353.0, close: 353.9 }, { price: 353.9, ms: (now - 1) * 1000 });
c.chartGrowApply(page2);
assert.equal(c.state.candleData.length, 2); assert.deepEqual([c.state.lastBar.time, c.state.lastBar.open, c.state.lastBar.high, c.state.lastBar.low, c.state.lastBar.close, c.state.lastBar.volume], [cur, 353.67, 354.3, 353.0, 353.9, 99]);
// no tick inside this period yet: the page's own close stands
c = fixture({ time: cur, open: 353.67, high: 354.0, low: 353.5, close: 353.8 }, { price: 350, ms: (cur - 10) * 1000 });
c.chartGrowApply(page2); assert.equal(c.state.lastBar.close, 354.09); assert.equal(c.state.lastBar.high, 354.21);
console.log('6 re-ask cases passed: the live bar survives a re-ask with its latest price; the venue\'s closed bar wins');
