import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const src=fs.readFileSync(new URL('../lse_terminal/ui/static/app.js',import.meta.url),'utf8');
const begin=src.indexOf('function onTick(t)');const end=src.indexOf('\n}',begin)+2;assert(begin>=0&&end>begin);
function fixture(timeframe='1m'){
 const bar={time:120,open:100,high:105,low:95,close:102};
 const ctx={state:{symbol:'TEST',timeframe,prices:{},quotes:{},priceTimes:{},lastBar:{...bar},candleData:[{...bar}]},savePriceCache(){},document:{querySelectorAll:()=>[]},CSS:{escape:s=>s},TF_SECONDS:{'1m':60},TICK_MAX_BARS:1000,Date,Math,decOf:()=>2,pushToChart(){ctx.paints++},paints:0};
 vm.createContext(ctx);for(const name of ["sourcePriceTime","acceptPriceTime"]){const a=src.indexOf("function "+name+"(");vm.runInContext(src.slice(a,src.indexOf("\n}",a)+2),ctx);}vm.runInContext(src.slice(begin,end),ctx);return ctx;
}
let c=fixture();const before=JSON.stringify(c.state.candleData);c.onTick({symbol:'TEST',price:1,bid:1,ask:2,ts:61});assert.equal(JSON.stringify(c.state.candleData),before);assert.equal(c.state.lastBar.close,102);assert.equal(c.state.prices.TEST,1);assert.equal(c.paints,0);
c=fixture();c.onTick({symbol:'TEST',price:110,ts:130});assert.equal(c.state.lastBar.time,120);assert.equal(c.state.lastBar.close,110);assert.equal(c.state.lastBar.high,110);assert.equal(c.paints,1);
c=fixture();c.onTick({symbol:'TEST',price:110,ts:181});assert.equal(c.state.lastBar.time,180);assert.equal(c.state.candleData.length,2);
c=fixture('tick');c.onTick({symbol:'TEST',price:1,ts:60});assert.equal(c.state.candleData.length,1);assert.equal(c.state.lastBar.time,120);assert.equal(c.paints,0);
c=fixture('tick');c.onTick({symbol:'TEST',price:110,ts:121});assert.equal(c.state.candleData.length,2);assert.equal(c.state.lastBar.time,121);
console.log('5 stale/current/new tick cases passed on actual installed UI candidate');
