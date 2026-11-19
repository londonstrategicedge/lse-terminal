import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const src=fs.readFileSync(new URL('../lse_terminal/ui/static/app.js',import.meta.url),'utf8');
const begin=src.indexOf('async function loadChart()');const end=src.indexOf('\n}',begin)+2;
let releaseError;const delayed=new Promise(r=>releaseError=r);let fetched=0;
const c={state:{provider:'lse',symbol:'0001.HK',timeframe:'1h',instruments:[{symbol:'EUR/USD'}],watchlists:{lse:['0001.HK']},candleData:[]},updateWindowTitle(){},status(){},indicatorQuery:()=>'',pushToChart(){},recoverUnavailableSymbol(){c.recovered=true;return false},fetch:async()=>{fetched++;return fetched===1?{ok:false,status:502,json:()=>delayed}:{ok:true,json:async()=>({candles:[[100,1,2,1,2,0]]})};}};
vm.createContext(c);vm.runInContext(src.slice(begin,end),c);
const old=c.loadChart();await new Promise(r=>setTimeout(r,0));c.state.symbol='BTC/USD';await c.loadChart();releaseError({detail:'candles failed: [404] has no candle data'});await old;
assert.equal(c.state.symbol,'BTC/USD');assert.equal(c.state.lastBar.close,2);assert.equal(c.recovered,undefined);
console.log('Delayed obsolete-symbol failure cannot replace a newer chart selection.');
