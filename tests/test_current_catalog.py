import ast
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1] / 'lse_terminal'

def extracted(path, names, env):
    nodes = []
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.FunctionDef) and node.name in names:
            node.decorator_list = []
            nodes.append(node)
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), 'exec'), env)
    return env

class CachedClient:
    def __init__(self, rows):
        self.rows = rows
        self._catalog_cache = [{'symbol':'STALE', 'dataset':'stocks'}]
        self._vault_catalog_cache = [{'symbol':'STALE', 'dataset':'stocks', 'live':1}]
        self.calls = 0
    def datasets(self):
        if self._vault_catalog_cache is None:
            self.calls += 1
            self._vault_catalog_cache = self.rows
        return self._vault_catalog_cache
    def catalog(self):
        if self._catalog_cache is None:
            self._catalog_cache = [dict(symbol=r['symbol'], dataset=r['dataset'],
                name=r.get('name',''), category=r.get('category','Stocks')) for r in self.datasets()]
        return self._catalog_cache

class CurrentCatalogTests(unittest.TestCase):
    def provider(self, rows):
        client = CachedClient(rows)
        methods = extracted(ROOT/'providers/lse.py', {'_refresh_catalog','search'},
            {'time':time, 'Instrument':SimpleNamespace, '_CANDLE_DATASETS':{'stocks','fx','crypto'}})
        provider = SimpleNamespace(name='lse', _CATEGORY_ORDER=['Forex','Stocks','Crypto'],
                                  _lse=lambda:client)
        provider._instruments = lambda: provider._catalog
        provider.refresh = lambda:methods['_refresh_catalog'](provider)
        provider.search = lambda query='',limit=50:methods['search'](provider, query, limit)
        provider.refresh()
        return provider, client
    def test_current_false_overrides_live_true_and_legacy_falls_back(self):
        rows=[{'symbol':s,'dataset':d,**flags} for s,d,flags in [
            ('CURRENT','stocks',{'live':0,'current':1}),
            ('RETIRED','stocks',{'live':1,'current':0}),
            ('LEGACY','stocks',{'live':1}),
            ('ARCHIVE','stocks',{'live':0}),
            ('NO_FLAG','stocks',{}),
            ('COLLISION','stocks',{'live':0,'current':0}),
            ('COLLISION','economics',{'live':1,'current':1}),
            ('OPTION','options',{'live':1,'current':1})]]
        provider, client = self.provider(rows)
        self.assertEqual([i.symbol for i in provider.search(limit=None)], ['CURRENT','LEGACY'])
        self.assertEqual(client.calls,1)
    def test_refresh_invalidates_both_views_and_reaches_new_source(self):
        provider,client=self.provider([dict(symbol='OLD',dataset='stocks',current=1)])
        client.rows=[dict(symbol='NEW',dataset='stocks',current=1)]
        provider.refresh()
        self.assertEqual([i.symbol for i in provider.search(limit=None)],['NEW'])
        self.assertEqual(client.calls,2)
    def test_full_discovery_exceeds_old_limit_and_keeps_search_bounds(self):
        rows=[dict(symbol=f'S{i:06d}',dataset='stocks',current=1,live=int(i<4900)) for i in range(15037)]
        provider,_=self.provider(rows)
        all_items=provider.search(limit=None)
        self.assertEqual(len(all_items),15037)
        self.assertEqual(all_items[-1].symbol,'S015036')
        self.assertEqual(len(provider.search(limit=5000)),5000)
        self.assertEqual(len(provider.search('S01',30)),30)
        self.assertEqual(provider.search('S015036',30)[0].symbol,'S015036')
        all_items.clear()
        self.assertEqual(len(provider._catalog),15037)
        with self.assertRaises(ValueError):provider.search('S',None)
    def route(self):
        calls=[]
        def search(query,limit):
            calls.append((query,limit))
            return [SimpleNamespace(symbol='LAST',name='Last',category='Stocks',meta={})]
        fn=extracted(ROOT/'engine/server.py',{'instruments'},
           {'reg':SimpleNamespace(get=lambda provider:SimpleNamespace(search=search)), 'HTTPException':HTTPException})['instruments']
        return fn,calls
    def test_only_explicit_lse_empty_query_is_uncapped(self):
        route,calls=self.route()
        self.assertEqual(route('lse',all_current=True)[0]['symbol'],'LAST')
        self.assertEqual(calls,[('',None)])
        route('lse',limit=9000);route('broker:x',limit=9000);route('lse',query='S',limit=30)
        self.assertEqual(calls[1:],[('',5000),('',5000),('S',30)])
    def test_invalid_full_requests_rejected_before_provider(self):
        route,calls=self.route()
        for provider,query in [('broker:x',''),('userdata',''),('lse','SMIN')]:
            with self.assertRaises(HTTPException) as exc:route(provider,query,all_current=True)
            self.assertEqual(exc.exception.status_code,400)
        self.assertEqual(calls,[])

if __name__=='__main__':unittest.main()
