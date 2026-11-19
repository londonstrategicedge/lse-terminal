import importlib.util
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import threading
from types import SimpleNamespace

import pandas as pd
import pytest

from lse_terminal.engine import lse_import as imports
from lse_terminal.providers import userdata
UTC = timezone.utc
BASE = datetime(2026, 10, 1, tzinfo=UTC)


@pytest.fixture(autouse=True)
def isolated_library(tmp_path, monkeypatch):
    monkeypatch.setattr(userdata.cfg, 'config_dir', lambda: tmp_path)
    monkeypatch.setattr(imports, '_active', False)


def candle(i, *, symbol='BTC/USD'):
    return {'timestamp': (BASE + timedelta(minutes=i)).isoformat(), 'symbol': symbol,
            'open': 100.123456789, 'high': 101.987654321, 'low': 99.123456789,
            'close': 100.987654321, 'volume': 0.123456789}


def point(i, value=None):
    return {'date': (BASE + timedelta(days=i)).date().isoformat(), 'symbol': 'US10Y',
            'value': i + 0.123456789 if value is None else value}


def specification(kind='ohlcv', cap=5000):
    return {'symbol': 'BTC/USD' if kind == 'ohlcv' else 'US10Y', 'dataset': 'crypto' if kind == 'ohlcv' else 'bonds',
            'kind': kind, 'timeframe': '1m' if kind == 'ohlcv' else None, 'name': 'Example',
            'folder': 'LSE', 'start': BASE, 'end': BASE + timedelta(days=30),
            'row_cap': cap, 'interval': 0}


class Reader:
    def __init__(self, pages):
        self.pages = iter(pages)
        self.calls = []

    def candles(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        response = next(self.pages)
        if isinstance(response, BaseException):
            raise response
        return response

    series = candles


def read(pages, spec=None, job=None):
    client = Reader(pages)
    entry = imports.download(client, spec or specification(), userdata, job if job is not None else {})
    return entry, client


def assert_no_staging():
    assert not list(userdata.data_dir().glob('.*.part'))
    assert not list(userdata.data_dir().glob('.*.tmp'))


def test_full_page_walk_values_native_interval_and_inclusive_end():
    rows = [candle(i) for i in range(5002)]
    job = {}
    entry, client = read([rows[:5000], rows[5000:]], job=job)
    assert entry['rows'] == 5002 and entry['timeframe'] == '1m'
    frame = pd.read_csv(userdata.dataset_path(entry['symbol']), float_precision='round_trip')
    assert frame.close.tolist() == [r['close'] for r in rows]
    assert frame.volume.tolist() == [r['volume'] for r in rows]
    assert client.calls[1][1]['start'] == (BASE + timedelta(minutes=4999, seconds=1)).isoformat().replace('+00:00', 'Z')
    assert job['status'] == 'done' and job['pages'] == 2
    assert job['file_bytes'] == userdata.dataset_path(entry['symbol']).stat().st_size
    assert imports._bound('2026-10-01', end=True) == BASE + timedelta(days=1)
    assert imports._bound('2026-10-01T03:00:00+03:00') == BASE
    assert_no_staging()


def test_series_boundary_day_is_repeated_without_loss():
    rows = [point(i) for i in range(6)]
    entry, client = read([rows[:3], rows[2:5], rows[4:]], specification('series', 3))
    assert entry['rows'] == 6 and entry['kind'] == 'series' and entry['columns'] == ['value']
    frame = pd.read_csv(userdata.dataset_path(entry['symbol']), float_precision='round_trip')
    assert frame.value.tolist() == [r['value'] for r in rows]
    assert frame.time.iloc[0] == int(BASE.timestamp()) * 1000
    assert client.calls[1][1]['start'] == '2026-10-03T00:00:00Z'


@pytest.mark.parametrize('pages', [
    [[point(0), point(1), point(2)], [point(2), point(2, 22), point(3)]],
    [[point(0), point(1), point(2)], [point(2, 99), point(3)]],
    [[point(0), point(1), point(2)], []],
])
def test_series_duplicates_or_changed_seam_are_not_silently_deduplicated(pages):
    with pytest.raises(imports.ImportProblem):
        read(pages, specification('series', 3))
    assert userdata.load_manifest() == {}
    assert_no_staging()


def test_collision_keeps_original_and_explicit_timeframe():
    original, _ = read([[candle(0), candle(1)]])
    original_path = userdata.dataset_path(original['symbol'])
    old = original_path.read_bytes()
    # Sparse bars must retain the requested interval, not infer one day.
    second, _ = read([[candle(0), candle(1440), candle(2880)]])
    assert second['symbol'] == original['symbol'] + '_2'
    assert second['timeframe'] == '1m' and original_path.read_bytes() == old
    assert len(userdata.load_manifest()) == 2


class QuotaError(Exception):
    status = 429
    message = 'monthly data allowance exceeded'


@pytest.mark.parametrize('failure', [QuotaError(), OSError('connection cut')])
def test_late_failure_leaves_old_library_unchanged(failure):
    old, _ = read([[candle(0)]])
    before_manifest = userdata._manifest_path().read_bytes()
    before_file = userdata.dataset_path(old['symbol']).read_bytes()
    with pytest.raises(type(failure)):
        read([[candle(1), candle(2)], failure], specification(cap=2))
    assert userdata._manifest_path().read_bytes() == before_manifest
    assert userdata.dataset_path(old['symbol']).read_bytes() == before_file
    assert_no_staging()


@pytest.mark.parametrize('bad', [
    [candle(1), candle(0)],
    [candle(0), candle(0)],
    [{**candle(0), 'close': float('nan')}],
    [{**candle(0), 'symbol': 'AAPL'}],
    [{**candle(0), 'low': 102}],
    [{**candle(0), 'timestamp': '2026-10-01T00:00:00.100Z'}],
])
def test_invalid_pages_leave_no_registered_file(bad):
    with pytest.raises(imports.ImportProblem):
        read([bad])
    assert userdata.load_manifest() == {}
    assert_no_staging()


def test_size_limit_does_not_publish_partial_file(monkeypatch):
    monkeypatch.setattr(imports, 'MAX_FILE_BYTES', 50)
    with pytest.raises(imports.ImportProblem, match='300 MB'):
        read([[candle(0)]])
    assert userdata.load_manifest() == {}
    assert_no_staging()


def test_manifest_replace_failure_preserves_old_file(monkeypatch):
    old, _ = read([[candle(0)]])
    manifest = userdata._manifest_path().read_bytes()
    old_bytes = userdata.dataset_path(old['symbol']).read_bytes()
    replace = imports.os.replace
    def fail_manifest(src, dst):
        if Path(dst) == userdata._manifest_path():
            raise OSError('disk failure')
        return replace(src, dst)
    monkeypatch.setattr(imports.os, 'replace', fail_manifest)
    with pytest.raises(OSError, match='disk failure'):
        read([[candle(1)]])
    assert userdata._manifest_path().read_bytes() == manifest
    assert userdata.dataset_path(old['symbol']).read_bytes() == old_bytes
    assert len(list(userdata.data_dir().glob('*.csv'))) == 1
    assert_no_staging()


@pytest.mark.parametrize('other', ['upload', 'rename'])
def test_import_commit_preserves_concurrent_upload_or_rename(monkeypatch, other):
    old, _ = read([[candle(0)]])
    held, downloaded, release = threading.Event(), threading.Event(), threading.Event()
    original_load = userdata.load_manifest
    def delayed_load():
        value = original_load()
        if threading.current_thread().name == 'existing-library-mutation':
            held.set()
            assert release.wait(5)
        return value
    monkeypatch.setattr(userdata, 'load_manifest', delayed_load)
    def mutate():
        threading.current_thread().name = 'existing-library-mutation'
        if other == 'upload':
            return userdata.import_table('UPLOAD', pd.DataFrame([candle(0), candle(1)]))
        return userdata.update_dataset(old['symbol'], name='Renamed while downloading')
    class ConcurrentReader(Reader):
        def candles(self, *args, **kwargs):
            downloaded.set()
            return super().candles(*args, **kwargs)
    client = ConcurrentReader([[candle(2)]])
    with ThreadPoolExecutor(max_workers=2) as pool:
        writing = pool.submit(mutate)
        assert held.wait(5)
        importing = pool.submit(imports.download, client, specification(), userdata, {})
        assert downloaded.wait(5)  # the download itself never holds STORE_LOCK
        assert not importing.done()
        release.set()
        writing.result(timeout=5)
        new = importing.result(timeout=5)
    manifest = userdata.load_manifest()
    assert old['symbol'] in manifest and new['symbol'] in manifest
    if other == 'upload':
        assert 'UPLOAD' in manifest and len(manifest) == 3
    else:
        assert manifest[old['symbol']]['name'] == 'Renamed while downloading'


def test_unreadable_manifest_is_not_replaced():
    userdata.data_dir().mkdir(parents=True)
    userdata._manifest_path().write_text('{broken')
    with pytest.raises(imports.ImportProblem, match='unreadable'):
        read([[candle(0)]])
    assert userdata._manifest_path().read_text() == '{broken'
    assert not list(userdata.data_dir().glob('*.csv'))


def test_import_meta_filters_unimplemented_history():
    meta = {'datasets': ['crypto', 'options', 'economics'], 'candle_classes': ['crypto'],
            'synth_candle_classes': [], 'series_classes': ['economics'],
            'timeframes': ['tick', '1s', '5s', '1m', '1mo'], 'reference': ['economic_calendar'],
            'options_timeframes': [], 'access': {'crypto': ['candles'], 'economics': ['series'], 'options': ['options']}}
    offered = imports.import_meta(meta, userdata)
    assert offered['datasets'] == ['crypto', 'economics']
    assert offered['timeframes'] == ['1s', '1m'] and offered['reference'] == []
    assert 'options' in meta['datasets']  # never mutate the SDK's cached metadata


def test_prepare_reads_real_plan_caps_and_rejects_ticks():
    class Client:
        def vault_meta(self):
            return {'candle_classes': ['crypto'], 'timeframes': ['1m'], 'access': {'crypto': ['candles']}}
        def _vault_call(self, path):
            assert path == '/usage'
            return {'max_rows_per_request': 1000, 'calls_per_minute': 60}
        def datasets(self, dataset):
            return [{'symbol': 'BTC/USD', 'name': 'Bitcoin'}]
    body = SimpleNamespace(dataset='crypto', symbol='BTC/USD', timeframe='1m', start='2026-10-01', end='2026-10-02', folder='LSE')
    spec = imports.prepare(Client(), body, userdata)
    assert spec['row_cap'] == 1000 and spec['interval'] == 60 / 55
    assert spec['end'] == BASE + timedelta(days=2)
    body.timeframe = 'tick'
    with pytest.raises(imports.ImportProblem, match='Tick history'):
        imports.prepare(Client(), body, userdata)


def test_thread_start_failure_releases_import_slot(monkeypatch):
    jobs = {}
    monkeypatch.setattr(imports, 'prepare', lambda *args: specification())
    def fail(self):
        raise RuntimeError('no thread resources')
    monkeypatch.setattr(imports.threading.Thread, 'start', fail)
    with pytest.raises(RuntimeError, match='thread resources'):
        imports.submit(object(), object(), userdata, jobs)
    assert not imports._active and jobs == {}
