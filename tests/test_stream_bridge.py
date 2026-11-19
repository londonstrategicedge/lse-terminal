import asyncio,unittest
from lse_terminal.engine.streaming import bridge
class Socket:
 def __init__(self):self.closed=asyncio.Event();self.sent=[]
 async def receive(self):await self.closed.wait();return {'type':'websocket.disconnect'}
 async def send_json(self,x):self.sent.append(x)
class BridgeTests(unittest.IsolatedAsyncioTestCase):
 async def test_quiet_chart_close_releases_capacity_before_any_next_tick(self):
  allowance=asyncio.Semaphore(1); entered=asyncio.Event();released=asyncio.Event()
  async def feed():
   async with allowance:
    entered.set()
    try:
     await asyncio.Future()
     yield {}
    finally:released.set()
  ws=Socket();task=asyncio.create_task(bridge(ws,feed()));await entered.wait()
  next_chart=asyncio.create_task(allowance.acquire())
  await asyncio.sleep(0);self.assertFalse(next_chart.done())
  ws.closed.set();await asyncio.wait_for(next_chart,0.2);await asyncio.wait_for(task,0.2)
  self.assertTrue(released.is_set())
 async def test_stream_finishes_without_leaving_receiver_task(self):
  async def feed():yield {'symbol':'BTC/USD','price':1}
  ws=Socket();before=set(asyncio.all_tasks());await bridge(ws,feed())
  self.assertEqual(ws.sent,[{'symbol':'BTC/USD','price':1,'type':'tick'}])
  self.assertEqual(set(asyncio.all_tasks()),before)
 async def test_error_surface_stops_upstream(self):
  closed=asyncio.Event()
  async def feed():
   try:yield {'error':'subscription refused'};await asyncio.Future()
   finally:closed.set()
  ws=Socket();await asyncio.wait_for(bridge(ws,feed()),0.2)
  self.assertTrue(closed.is_set());self.assertEqual(ws.sent,[{'type':'error','message':'subscription refused'}])
 async def test_outer_cancellation_closes_subscription(self):
  entered=asyncio.Event();closed=asyncio.Event()
  async def feed():
   try:entered.set();await asyncio.Future();yield {}
   finally:closed.set()
  task=asyncio.create_task(bridge(Socket(),feed()));await entered.wait();task.cancel()
  with self.assertRaises(asyncio.CancelledError):await task
  self.assertTrue(closed.is_set())
if __name__=='__main__':unittest.main()
