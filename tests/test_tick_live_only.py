import importlib.util,sys,unittest
from pathlib import Path
from unittest.mock import Mock
from lse_terminal.providers import lse as m

class Tests(unittest.TestCase):
 def test_initial_chart_is_empty_with_dataframe_contract_and_no_network(self):
  provider=m.LseProvider(api_key='fixture');provider._lse=Mock(side_effect=AssertionError('must not call retired replay'))
  frame=provider.candles('BTC/USD','tick',limit=5000)
  self.assertTrue(frame.empty);self.assertEqual(list(frame.columns),list(m.CANDLE_COLUMNS));provider._lse.assert_not_called()
 def test_explicit_history_bounds_are_rejected(self):
  provider=m.LseProvider(api_key='fixture')
  for kwargs in ({'start':'2026-10-27'},{'end':'2026-10-27'}):
   with self.assertRaisesRegex(ValueError,'live only'):provider.candles('BTC/USD','tick',**kwargs)
if __name__=='__main__':unittest.main()
