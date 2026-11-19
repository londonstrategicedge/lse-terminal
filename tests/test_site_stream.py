import asyncio, importlib.util, json
from pathlib import Path
import sys, types, unittest
from unittest.mock import patch
from lse_terminal.providers import site_stream as module

class Socket:
 def __init__(self,mapping=None,auth=None,error=None,cached=True):
  self.mapping=mapping or {};self.auth=auth or {'type':'auth','status':'ok'};self.error=error;self.cached=cached;self.q=asyncio.Queue();self.q.put_nowait(json.dumps({'type':'welcome'}));self.sent=[];self.closed=False;self.subscribed=set();self.peak=0
 async def send(self,raw):
  data=json.loads(raw);self.sent.append(data)
  if data['action']=='auth':self.q.put_nowait(json.dumps(self.auth))
  if data['action']=='subscribe':
   if self.error and data['symbol']==self.error[0]:self.q.put_nowait(json.dumps(self.error[1]));return
   canonical=self.mapping.get(data['symbol'],data['symbol']);self.q.put_nowait(json.dumps({'type':'subscribed','symbol':canonical}))
   if canonical not in self.subscribed and self.cached:self.push(canonical,10)
   self.subscribed.add(canonical);self.peak=max(self.peak,len(self.subscribed))
  if data['action']=='unsubscribe':
   self.subscribed.discard(data['symbol']);self.q.put_nowait(json.dumps({'type':'unsubscribed','symbol':data['symbol']}))
 def push(self,symbol,price,ts=1793076000):self.q.put_nowait(json.dumps({'type':'tick','symbol':symbol,'price':price,'bid':price-1,'ask':price+1,'ts':ts,'volume':2}))
 async def recv(self):return await self.q.get()
 async def __aenter__(self):return self
 async def __aexit__(self,*args):self.closed=True
class Tests(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):self.provider=types.SimpleNamespace(_key='fixture-key')
 async def asyncTearDown(self):await module.close(self.provider)
 async def row(self,gen):return await asyncio.wait_for(anext(gen),1)
 async def test_all_markets_aliases_unicode_one_socket(self):
  mapping={'ES.F':'SP500.F','GC.F':'GOLD.F','VOD.L':'VOD.UK','ACO-X.TO':'ACO.X.CA','ß.F':'SS.F'}
  syms=['EUR/USD','AAPL','BTC/USD','SPX.IDX','XAU/USD','ES.F','GC.F','VOD.L','ACO-X.TO','ß.F'];ws=Socket(mapping)
  with patch.object(module.websockets,'connect',return_value=ws) as c:
   gen=module.stream(self.provider,syms);rows=[await self.row(gen) for _ in syms];await gen.aclose();await module.close(self.provider)
  self.assertEqual([r['symbol']for r in rows],syms);self.assertEqual(c.call_count,1);self.assertTrue(ws.closed)
 async def test_twenty_four_fast_chart_switches_reuse_connection_and_free_old_slot(self):
  ws=Socket()
  with patch.object(module.websockets,'connect',return_value=ws) as c:
   for i in range(24):
    gen=module.stream(self.provider,[f'SYM{i%3}']);self.assertEqual((await self.row(gen))['symbol'],f'SYM{i%3}');await gen.aclose()
   await asyncio.sleep(.01);await module.close(self.provider)
  self.assertEqual(c.call_count,1);self.assertEqual(ws.peak,1);self.assertEqual(ws.subscribed,set());self.assertTrue(ws.closed)
 async def test_two_charts_share_quote_and_releasing_one_keeps_other_live(self):
  ws=Socket({'ES.F':'SP500.F'})
  with patch.object(module.websockets,'connect',return_value=ws) as c:
   a=module.stream(self.provider,['SP500.F']);b=module.stream(self.provider,['ES.F'])
   self.assertEqual((await self.row(a))['symbol'],'SP500.F');self.assertEqual((await self.row(b))['symbol'],'ES.F')
   await a.aclose();await asyncio.sleep(.01);ws.push('SP500.F',12,1793076001)
   self.assertEqual((await self.row(b))['price'],12);self.assertIn('SP500.F',ws.subscribed);await b.aclose();await asyncio.sleep(.01);await module.close(self.provider)
  self.assertEqual(c.call_count,1);self.assertEqual(ws.peak,1)
 async def test_second_chart_same_spelling_gets_cache_without_new_subscribe(self):
  ws=Socket()
  with patch.object(module.websockets,'connect',return_value=ws):
   a=module.stream(self.provider,['BTC/USD']);b=module.stream(self.provider,['BTC/USD']);first=await self.row(a);second=await self.row(b);await a.aclose();await b.aclose();await module.close(self.provider)
  self.assertEqual(first,second);self.assertEqual(sum(r['action']=='subscribe'for r in ws.sent),1)
 async def test_multiple_charts_and_aliases_infer_one_quote_per_print(self):
  ws=Socket({'ES.F':'SP500.F'})
  class Synth:
   def __init__(self):self.count=0
   def fill(self,row):self.count+=1;return {**row,'bid':row['price']-self.count,'ask':row['price']+self.count}
  with patch.object(module.websockets,'connect',return_value=ws):
   a=module.stream(self.provider,['SP500.F']);await self.row(a)
   hub=self.provider._site_stream_hub;hub.synth=Synth()
   b=module.stream(self.provider,['ES.F']);await self.row(b)
   c=module.stream(self.provider,['SP500.F']);await self.row(c)
   ws.push('SP500.F',15,1793076001)
   rows=[await self.row(g)for g in (a,b,c)]
   self.assertEqual(hub.synth.count,1);self.assertTrue(all(r['bid']==14 and r['ask']==16 for r in rows))
   for g in (a,b,c):await g.aclose()
   await module.close(self.provider)
 async def test_idle_releases_subscription_then_closes_within_bound(self):
  ws=Socket()
  with patch.object(module.websockets,'connect',return_value=ws),patch.object(module,'IDLE_CLOSE_SECONDS',.04):
   gen=module.stream(self.provider,['VOD.UK']);await self.row(gen);await gen.aclose();await asyncio.sleep(.01)
   self.assertEqual(ws.subscribed,set());self.assertFalse(ws.closed)
   await asyncio.wait_for(self.provider._site_stream_hub.task,.2)
  self.assertTrue(ws.closed);self.assertTrue(self.provider._site_stream_hub.closed)
 async def test_quiet_cancel_unsubscribes_without_waiting_for_tick(self):
  ws=Socket(cached=False)
  with patch.object(module.websockets,'connect',return_value=ws):
   gen=module.stream(self.provider,['VOD.UK']);task=asyncio.create_task(anext(gen));await asyncio.sleep(.01);task.cancel()
   with self.assertRaises(asyncio.CancelledError):await task
   await gen.aclose();await asyncio.sleep(.01);self.assertEqual(ws.subscribed,set());await module.close(self.provider)
  self.assertTrue(ws.closed)
 async def test_auth_rejection_never_subscribes_anonymously(self):
  ws=Socket(auth={'type':'auth','status':'rejected','message':'Invalid fixture-key'})
  with patch.object(module.websockets,'connect',return_value=ws):rows=[r async for r in module.stream(self.provider,['BTC/USD'])]
  self.assertEqual(rows,[{'error':'Invalid [redacted]'}]);self.assertEqual([r['action']for r in ws.sent],['auth']);self.assertTrue(ws.closed)
 async def test_subscription_limit_surfaces_only_to_rejected_chart(self):
  ws=Socket(error=('SECOND',{'type':'error','code':'LIMIT_REACHED','message':'Max 1 symbols'}))
  with patch.object(module.websockets,'connect',return_value=ws):
   a=module.stream(self.provider,['BTC/USD']);await self.row(a);b=module.stream(self.provider,['SECOND']);self.assertEqual(await self.row(b),{'error':'Max 1 symbols'});await b.aclose()
   ws.push('BTC/USD',12,1793076001);self.assertEqual((await self.row(a))['price'],12);await a.aclose();await module.close(self.provider)
 async def test_old_quotes_do_not_roll_price_back(self):
  ws=Socket()
  with patch.object(module.websockets,'connect',return_value=ws):
   gen=module.stream(self.provider,['BTC/USD']);await self.row(gen);ws.push('BTC/USD',9,1793075900);ws.push('BTC/USD',11,1793076001);row=await self.row(gen);await gen.aclose();await module.close(self.provider)
  self.assertEqual((row['price'],row['ts']),(11,1793076001))
 async def test_missing_timestamp_is_error_not_fabricated_now(self):
  ws=Socket(cached=False)
  with patch.object(module.websockets,'connect',return_value=ws):
   gen=module.stream(self.provider,['BTC/USD']);task=asyncio.create_task(anext(gen));await asyncio.sleep(.01);ws.push('BTC/USD',10,None);row=await task;await gen.aclose();await module.close(self.provider)
  self.assertIn('timestamp',row['error'])
 async def test_connection_failure_bounded(self):
  with patch.object(module.websockets,'connect',side_effect=OSError('offline')) as c,patch.object(module,'RECONNECT_DELAY',0):rows=[r async for r in module.stream(self.provider,['BTC/USD'])]
  self.assertEqual(c.call_count,3);self.assertIn('offline',rows[0]['error'])
 async def test_reconnect_discards_older_cache_and_keeps_requested_alias(self):
  a=Socket({'ES.F':'SP500.F'});b=Socket({'ES.F':'SP500.F'},cached=False)
  with patch.object(module.websockets,'connect',side_effect=[a,b]),patch.object(module,'RECONNECT_DELAY',0):
   gen=module.stream(self.provider,['ES.F']);await self.row(gen)
   # Raise network error on the next delivery from the current pending recv.
   async def broken():raise OSError('network lost')
   a.recv=broken;a.push('SP500.F',10)
   await self.row(gen)
   task=asyncio.create_task(anext(gen));await asyncio.sleep(.02);b.push('SP500.F',9,1793075900);b.push('SP500.F',12,1793076001);row=await asyncio.wait_for(task,1);await gen.aclose();await module.close(self.provider)
  self.assertEqual((row['symbol'],row['price']),('ES.F',12));self.assertTrue(a.closed and b.closed)
 async def test_worker_key_change_closes_old_stream_and_wakes_old_chart(self):
  a=Socket();b=Socket();new_provider=types.SimpleNamespace(_key='new-fixture-key')
  with patch.object(module.websockets,'connect',side_effect=[a,b]) as c:
   old=module.stream(self.provider,['BTC/USD']);await self.row(old)
   # An unconsumed tick must not leak out after the config handler signs out.
   a.push('BTC/USD',12,1793076001);await asyncio.sleep(.01)
   await asyncio.to_thread(module.close_sync,self.provider)
   self.assertTrue(a.closed)
   with self.assertRaises(StopAsyncIteration):await anext(old)
   new=module.stream(new_provider,['BTC/USD']);await self.row(new)
   self.assertEqual([r['api_key']for r in a.sent if r['action']=='auth'],['fixture-key'])
   self.assertEqual([r['api_key']for r in b.sent if r['action']=='auth'],['new-fixture-key'])
   await new.aclose();await module.close(new_provider)
  self.assertEqual(c.call_count,2);self.assertTrue(b.closed)
 async def test_close_sync_rejects_event_loop_deadlock(self):
  ws=Socket()
  with patch.object(module.websockets,'connect',return_value=ws):
   gen=module.stream(self.provider,['BTC/USD']);await self.row(gen)
   with self.assertRaisesRegex(RuntimeError,'worker thread'):module.close_sync(self.provider)
   await gen.aclose();await module.close(self.provider)
 async def test_shutdown_leaves_no_tasks(self):
  before=set(asyncio.all_tasks());ws=Socket()
  with patch.object(module.websockets,'connect',return_value=ws):
   gen=module.stream(self.provider,['BTC/USD']);await self.row(gen);await module.close(self.provider);await gen.aclose()
  self.assertEqual(set(asyncio.all_tasks()),before);self.assertTrue(ws.closed)
if __name__=='__main__':unittest.main()
