import ast,io,json,tempfile,time,unittest,urllib.error,urllib.parse
from pathlib import Path
from unittest.mock import patch
from fastapi import HTTPException
SOURCE=Path(__file__).resolve().parents[1]/'lse_terminal/engine/server.py'
TREE=ast.parse(SOURCE.read_text())
def functions(names, env):
 nodes=[]
 for node in ast.walk(TREE):
  if isinstance(node,ast.FunctionDef) and node.name in names:
   node.decorator_list=[];nodes.append(node)
 exec(compile(ast.Module(body=nodes,type_ignores=[]),str(SOURCE),'exec'),env)
 return env
class Tests(unittest.TestCase):
 def setUp(self):
  # _source_broker and _local_refusal: the broker's-terms check get_candles makes (SPEC 3.3); for these providers it returns before reading any broker.
  self.tmp=tempfile.TemporaryDirectory();self.env=functions({'_mbo_get','mbo_status','_tool_dispatch','_source_broker','_local_refusal'},{'HTTPException':HTTPException,'time':time,'mbo_cache':{},'_mbo_key':lambda:'fixture-key','_MBO_VAULT':'https://example.invalid/vault','__version__':'fixture','_json':json,'ai_dir':Path(self.tmp.name)})
 def tearDown(self):self.tmp.cleanup()
 def test_retired_mbo_is_unavailable_cached_and_no_contracts(self):
  err=urllib.error.HTTPError('https://example.invalid',410,'Gone',{},io.BytesIO(b'retired'))
  with patch('urllib.request.urlopen',side_effect=err) as call:
   self.assertEqual(self.env['mbo_status'](),{'available':False,'symbols':{}})
   self.assertFalse(self.env['mbo_status']()['available']);self.assertEqual(call.call_count,1)
 def test_mbo_service_errors_and_limits_remain_errors(self):
  for status,expected in [(503,502),(429,429)]:
   self.env['mbo_cache'].clear()
   with patch('urllib.request.urlopen',side_effect=urllib.error.HTTPError('x',status,'failure',{},None)):
    with self.assertRaises(HTTPException) as exc:self.env['mbo_status']()
    self.assertEqual(exc.exception.status_code,expected);self.assertFalse(self.env['mbo_cache'])
 def test_candles_explicit_lse_identity_overrides_local_chart(self):
  (Path(self.tmp.name)/'context.json').write_text(json.dumps({'provider':'userdata','symbol':'BTCUSD'}))
  with patch('urllib.request.urlopen',return_value=io.BytesIO(b'{"candles":[],"symbol":"BTC/USD","timeframe":"1h"}')) as call:
   result=self.env['_tool_dispatch']('get_candles',{'provider':'lse','symbol':'BTC/USD','timeframe':'1h','limit':5},'http://127.0.0.1:17899',None)
  self.assertEqual(json.loads(result)['candles'],[])
  self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(call.call_args.args[0]).query),{'provider':['lse'],'symbol':['BTC/USD'],'timeframe':['1h'],'limit':['5']})
 def test_tool_returns_exact_utc_and_closed_bucket_without_altering_prices(self):
  rows=[[1793077200,1,3,1,2,10],[1793080800,2,4,2,3,5]]
  body=json.dumps({'provider':'lse','symbol':'BTC/USD','timeframe':'1h','candles':rows}).encode()
  with patch('urllib.request.urlopen',return_value=io.BytesIO(body)),patch('time.time',return_value=1793080950):
   result=json.loads(self.env['_tool_dispatch']('get_candles',{'provider':'lse','symbol':'BTC/USD','timeframe':'1h'},'http://127.0.0.1:1',None))
  self.assertEqual(result['candles'],rows)
  self.assertEqual([x['timestamp_utc'] for x in result['candles_utc']],['2026-10-27T05:00:00Z','2026-10-27T06:00:00Z'])
  self.assertEqual([x['completed'] for x in result['candles_utc']],[True,False])
  self.assertEqual(result['latest_completed_candle']['close'],2)
  self.assertEqual(result['latest_completed_candle']['timestamp_utc'],'2026-10-27T05:00:00Z')
 def test_tool_propagates_bounded_body_without_headers_or_url(self):
  err=urllib.error.HTTPError('https://invalid/?secret=not-output',404,'generic',{'secret':'not-output'},io.BytesIO(b'{"detail":"BTCUSD has no candle data; use exact symbol"}'))
  with patch('urllib.request.urlopen',side_effect=err):
   with self.assertRaises(HTTPException) as exc:self.env['_tool_dispatch']('get_candles',{'provider':'lse','symbol':'BTCUSD'},'http://127.0.0.1:1',None)
  self.assertEqual(exc.exception.status_code,404);self.assertIn('no candle data',exc.exception.detail);self.assertNotIn('not-output',exc.exception.detail)
  err=urllib.error.HTTPError('x',502,'generic',{},io.BytesIO(b'x'*9000))
  with patch('urllib.request.urlopen',side_effect=err):
   with self.assertRaises(HTTPException) as exc:self.env['_tool_dispatch']('get_candles',{},'http://127.0.0.1:1',None)
  self.assertEqual(len(exc.exception.detail),2048)
 def test_tool_schema_exposes_exact_provider_identity(self):
  tree=ast.parse((SOURCE.parent/'approve_bridge.py').read_text());specs=[]
  for node in ast.walk(tree):
   if isinstance(node,ast.Dict):
    try:value=ast.literal_eval(node)
    except (ValueError,TypeError):continue
    if isinstance(value,dict) and value.get('name')=='get_candles':specs.append(value)
  self.assertEqual(len(specs),1);spec=specs[0]
  self.assertIn('provider',spec['inputSchema']['properties']);self.assertIn('BTC/USD',spec['description']);self.assertIn('do not substitute',spec['description'])
if __name__=='__main__':unittest.main()
