"""Display quote ownership must not consume other readers' subscriptions."""
import importlib.util,os,threading,unittest
from pathlib import Path
path=os.getenv('LSE_BROKER_HUB_SOURCE')
if path:
 spec=importlib.util.spec_from_file_location('quote_scope_candidate',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);BrokerHub=module.BrokerHub;BrokerProvider=module.BrokerProvider;NotSupported=module.NotSupported
else:
 from lse_terminal.engine.broker_hub import BrokerHub,BrokerProvider,NotSupported

class Connector:
 def __init__(self,existing=(),cap=100,quotes=True):
  self.subscribed=list(existing);self.alive=True;self.cap=cap;self.requests=[];self.fail_add=None;self.fail_drop=False;self.block=None;self.entered=threading.Event()
  self.handshake={'capabilities':{'data':{'quotes':quotes}}}
 def subscribe(self,names):
  self.entered.set()
  if self.block:self.block.wait(2)
  take=[];refused=[]
  for s in names:
   if s in self.subscribed:continue
   if s==self.fail_add:raise RuntimeError('add failed')
   if len(self.subscribed)>=self.cap:refused.append(s);continue
   self.subscribed.append(s);take.append(s);self.requests.append(('add',s))
  return {'subscribed':take,'refused':refused,'cap':self.cap}
 def unsubscribe(self,names):
  if self.fail_drop:raise RuntimeError('drop failed')
  for s in names:
   if s in self.subscribed:self.subscribed.remove(s);self.requests.append(('drop',s))
  return {'unsubscribed':names}
 def close(self):self.alive=False

def hub(*connectors):
 h=BrokerHub.__new__(BrokerHub);h.lock=threading.RLock();h._quote_owners={};h.conns={str(i):c for i,c in enumerate(connectors)};h.registry={str(i):{} for i in range(len(connectors))};h.quotes={};h.pending_auth={};return h

class QuoteScopes(unittest.TestCase):
 def test_150_changes_preserve_held_provider_and_unowned_without_cap_leak(self):
  c=Connector(['EXTERNAL']);h=hub(c);h.subscribe('0',['PROVIDER'])
  for i in range(150):
   result=h.subscribe_display('0',[f'TICKET{i}','HELD']);self.assertEqual(result['refused'],[])
   self.assertEqual(set(c.subscribed),{'EXTERNAL','PROVIDER','HELD',f'TICKET{i}'})
  self.assertEqual(len([x for x in c.requests if x[0]=='drop']),149)
 def test_provider_claim_of_existing_display_symbol_survives_noop_dedup(self):
  c=Connector();h=hub(c);h.subscribe_display('0',['BOTH']);self.assertEqual(h.subscribe('0',['BOTH'])['subscribed'],[])
  h.subscribe_display('0',['NEXT']);self.assertEqual(set(c.subscribed),{'BOTH','NEXT'})
  h.subscribe_display('0',['BOTH']);h.subscribe_display('0',[]);self.assertEqual(c.subscribed,['BOTH'])
 def test_unowned_subscription_added_after_scope_creation_is_protected(self):
  c=Connector();h=hub(c);h.subscribe_display('0',['OLD']);c.subscribe(['EXTERNAL']);h.subscribe_display('0',['EXTERNAL']);h.subscribe_display('0',[]);self.assertEqual(c.subscribed,['EXTERNAL'])
 def test_additive_reader_keeps_existing_claims(self):
  c=Connector();h=hub(c);h.subscribe('0',['A']);h.subscribe('0',['B']);h.subscribe_display('0',['C']);h.subscribe_display('0',[]);self.assertEqual(set(c.subscribed),{'A','B'})
 def test_failure_to_unsubscribe_is_visible_and_retry_finishes(self):
  c=Connector();h=hub(c);h.subscribe_display('0',['OLD','HELD']);c.fail_drop=True
  with self.assertRaisesRegex(RuntimeError,'drop failed'):h.subscribe_display('0',['NEW','HELD'])
  self.assertEqual(set(c.subscribed),{'OLD','HELD'});c.fail_drop=False;h.subscribe_display('0',['NEW','HELD']);self.assertEqual(set(c.subscribed),{'NEW','HELD'})
 def test_partial_subscribe_failure_tracks_accepted_names_and_recovers(self):
  c=Connector();h=hub(c);h.subscribe_display('0',['OLD']);c.fail_add='BAD'
  with self.assertRaisesRegex(RuntimeError,'add failed'):h.subscribe_display('0',['FIRST','BAD'])
  self.assertEqual(c.subscribed,['FIRST']);self.assertEqual(h._quote_owners['0']['display'],{'FIRST'});c.fail_add=None;h.subscribe_display('0',['NEW']);self.assertEqual(c.subscribed,['NEW'])
 def test_partial_provider_failure_protects_overlap_without_phantom_claim(self):
  c=Connector();h=hub(c);h.subscribe_display('0',['BOTH']);c.fail_add='BAD'
  with self.assertRaises(RuntimeError):h.subscribe('0',['BOTH','GOOD','BAD'])
  self.assertEqual(h._quote_owners['0']['shared'],{'BOTH','GOOD'});h.subscribe_display('0',['NEXT']);self.assertEqual(set(c.subscribed),{'BOTH','GOOD','NEXT'})
 def test_cap_refusal_is_visible_and_unaccepted_name_not_claimed(self):
  c=Connector(['EXTERNAL'],cap=2);h=hub(c);out=h.subscribe_display('0',['HELD','NEXT']);self.assertEqual(out['refused'],['NEXT']);self.assertEqual(h._quote_owners['0']['display'],{'HELD'});out=h.subscribe_display('0',['NEXT']);self.assertEqual(out['refused'],[]);self.assertEqual(set(c.subscribed),{'EXTERNAL','NEXT'})
 def test_disconnect_clears_owners_and_reconnect_starts_fresh(self):
  c=Connector();h=hub(c);h.subscribe('0',['OLD_PROVIDER']);h.subscribe_display('0',['OLD']);h.disconnect('0');self.assertNotIn('0',h._quote_owners)
  new=Connector();h.conns['0']=new;h.subscribe_display('0',['NEW']);self.assertEqual(new.subscribed,['NEW']);self.assertEqual(h._quote_owners['0']['shared'],set())
 def test_replaced_connector_invalidates_late_old_request(self):
  c=Connector();h=hub(c);c.block=threading.Event();errors=[]
  def request():
   try:h.subscribe_display('0',['OLD'])
   except Exception as e:errors.append(e)
  t=threading.Thread(target=request);t.start();self.assertTrue(c.entered.wait(1));h.disconnect('0');new=Connector();h.conns['0']=new;h.subscribe_display('0',['NEW']);c.block.set();t.join(1)
  self.assertFalse(t.is_alive());self.assertEqual(len(errors),1);self.assertIsInstance(errors[0],LookupError);self.assertEqual(new.subscribed,['NEW']);self.assertIs(h._quote_owners['0']['connector'],new)
 def test_slow_broker_does_not_block_independent_broker(self):
  c=Connector();other=Connector();h=hub(c,other);c.block=threading.Event();t=threading.Thread(target=h.subscribe_display,args=('0',['A']));t.start();self.assertTrue(c.entered.wait(1));done=threading.Event()
  t2=threading.Thread(target=lambda:(h.subscribe_display('1',['B']),done.set()));t2.start();self.assertTrue(done.wait(.5));c.block.set();t.join(1);t2.join(1);self.assertEqual(other.subscribed,['B'])
 def test_same_broker_additive_claim_serializes_with_display_replacement(self):
  c=Connector();h=hub(c);h.subscribe_display('0',['BOTH']);c.entered.clear();c.block=threading.Event()
  a=threading.Thread(target=h.subscribe,args=('0',['BOTH']));a.start();self.assertTrue(c.entered.wait(1));b=threading.Thread(target=h.subscribe_display,args=('0',['NEXT']));b.start();c.block.set();a.join(1);b.join(1);self.assertEqual(set(c.subscribed),{'BOTH','NEXT'})
 def test_no_quote_capability_and_empty_inputs_do_not_add(self):
  c=Connector(quotes=False);h=hub(c);self.assertEqual(h.subscribe_display('0',['A']),{'subscribed':[],'refused':[],'quotes':False});self.assertFalse(c.requests)
 def test_duplicate_names_do_not_send_duplicate_requests(self):
  c=Connector();h=hub(c);h.subscribe_display('0',['A','A','','B']);self.assertEqual(c.requests,[('add','A'),('add','B')]);h.subscribe_display('0',['B','B']);self.assertEqual(c.subscribed,['B'])

class BrokerQuoteTime(unittest.TestCase):
 def provider(self,row):
  p=BrokerProvider(None,'test','Test broker');p._board=lambda symbols:{'OLD':row};return p
 def test_closed_market_source_age_and_millisecond_conversion(self):
  stamp=1792836000123;row={'bid':10,'ask':12,'time':stamp};p=self.provider(row)
  self.assertEqual(p.prices(['OLD'])[0]['ts'],stamp);self.assertEqual(p.quote('OLD').ts,stamp/1000.0);self.assertEqual(p.quote('OLD').price,10)  # the bid: every price shown is the bid
 def test_unknown_source_time_never_becomes_receipt_time(self):
  for stamp in (None,0,-1,float('nan'),float('inf'),True,'yesterday'):
   with self.subTest(stamp=stamp):
    p=self.provider({'bid':10,'ask':12,'time':stamp});self.assertIsNone(p.prices(['OLD'])[0]['ts'])
    with self.assertRaisesRegex(NotSupported,'no source timestamp'):p.quote('OLD')
 def test_one_sided_quote_retains_source_time(self):
  p=self.provider({'bid':10,'ask':None,'time':1792836000000});self.assertEqual(p.quote('OLD').ts,1792836000);self.assertEqual(p.quote('OLD').price,10)
 def test_no_bid_the_ask_is_the_price(self):
  p=self.provider({'bid':None,'ask':12,'time':1792836000000});self.assertEqual(p.quote('OLD').price,12);self.assertEqual(p.prices(['OLD'])[0]['price'],12)

if __name__=='__main__':unittest.main()
