import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const src=fs.readFileSync(new URL('../lse_terminal/ui/static/app.js',import.meta.url),'utf8');
const start=src.indexOf('function recoverUnavailableSymbol(detail)');const end=src.indexOf('\n}',start)+2;
function fixture(){const c={state:{provider:'lse',symbol:'0001.HK',instruments:[{symbol:'EUR/USD'},{symbol:'BTC/USD'}],watchlists:{lse:['0001.HK','ES.F','BTC/USD']}},saveShellState(){c.saved++},renderWatchlist(){},connectStream(){c.connected++},tpbFollowChart(s){c.ticket=s},saved:0,connected:0};vm.createContext(c);vm.runInContext(src.slice(start,end),c);return c;}
let c=fixture();assert.equal(c.recoverUnavailableSymbol(`candles failed: [404] {"detail":"'0001.HK' has no candle data; browse /catalog"}`),true);assert.equal(c.state.symbol,'EUR/USD');assert.deepEqual([...c.state.watchlists.lse],['ES.F','BTC/USD']);assert.equal(c.saved,1);assert.equal(c.connected,1);assert.equal(c.ticket,'EUR/USD');
for(const detail of ['network timeout','[401] unauthorized','[404] route missing','[503] unavailable']){c=fixture();assert.equal(c.recoverUnavailableSymbol(detail),false);assert.equal(c.state.symbol,'0001.HK');assert.equal(c.saved,0);}
c=fixture();c.state.provider='userdata';assert.equal(c.recoverUnavailableSymbol('[404] has no candle data'),false);
console.log('Saved selection retires only confirmed unavailable LSE symbols; transient errors and aliases preserved.');
