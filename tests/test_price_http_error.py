import ast,io,math,types,unittest,urllib.error
from pathlib import Path
from fastapi import HTTPException
SOURCE=Path(__file__).resolve().parents[1]/'lse_terminal/engine/server.py'
class Body(io.BytesIO):
 def __init__(self,data):super().__init__(data);self.read_bytes=0
 def read(self,*a):b=super().read(*a);self.read_bytes+=len(b);return b
class Tests(unittest.TestCase):
 def invoke(self,error):
  def fail(symbols):raise error
  env={'HTTPException':HTTPException,'math':math,'reg':types.SimpleNamespace(get=lambda p:types.SimpleNamespace(prices=fail))}
  node=next(n for n in ast.walk(ast.parse(SOURCE.read_text()))if isinstance(n,ast.FunctionDef)and n.name=='prices');node.decorator_list=[];exec(compile(ast.Module(body=[node],type_ignores=[]),str(SOURCE),'exec'),env)
  with self.assertRaises(HTTPException)as exc:env['prices']('lse','BTC/USD')
  return exc.exception
 def test_quota_preserves_status_and_full_error_eof(self):
  body=Body(b'x'*9000);e=self.invoke(urllib.error.HTTPError('x',429,'limit',{'Retry-After':'4.2'},body));self.assertEqual(e.status_code,429);self.assertEqual(e.headers,{'Retry-After':'5'});self.assertEqual(body.read_bytes,9000);self.assertTrue(body.closed);self.assertNotIn('xxxx',e.detail)
 def test_missing_invalid_extreme_retry_is_bounded(self):
  for value,expected in [(None,'60'),('bad','60'),('inf','60'),('99999','120'),('-5','3')]:
   headers={}if value is None else{'Retry-After':value};e=self.invoke(urllib.error.HTTPError('x',429,'limit',headers,Body(b'limit')));self.assertEqual(e.headers['Retry-After'],expected)
 def test_other_upstream_errors_stay_failures(self):
  self.assertEqual(self.invoke(urllib.error.HTTPError('x',503,'unavailable',{},Body(b'no'))).status_code,502)
if __name__=='__main__':unittest.main()
