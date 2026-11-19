"""Import supported customer candle/series readers into the local library.

The published SDK performs every remote read. No exports, replay, direct DB
access, price repair, timestamp deduplication or timeframe inference occur here.
The library's existing CSV/manifest formats are retained. Downloads stage to a
private temporary file and only complete, validated walks become library rows.
"""
from __future__ import annotations

import csv
from datetime import date, datetime, timedelta, timezone
import json
import math
import os
from pathlib import Path
import tempfile
import threading
import time
import uuid

UTC = timezone.utc
MAX_FILE_BYTES = 300_000_000
_jobs_lock = threading.Lock()
_active = False


class ImportProblem(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status
        self.message = message


def import_meta(meta, userdata):
    """Only offer what these readers and the installed local provider support."""
    out = dict(meta)
    access = meta.get('access') or {}
    for name in ('candle_classes', 'synth_candle_classes'):
        out[name] = [x for x in meta.get(name, []) if 'candles' in access.get(x, [])]
    out['series_classes'] = [x for x in meta.get('series_classes', []) if 'series' in access.get(x, [])]
    out['timeframes'] = [x for x in meta.get('timeframes', []) if x in userdata._TF_SECONDS]
    out['datasets'] = out['candle_classes'] + out['synth_candle_classes'] + out['series_classes']
    out['reference'], out['options_timeframes'] = [], []
    return out


def _bound(value, *, end=False):
    if not value:
        return None
    try:
        value = str(value).strip()
        if len(value) == 10:
            d = date.fromisoformat(value)
            if end:
                d += timedelta(days=1)  # a date-only To includes that day
            return datetime.combine(d, datetime.min.time(), UTC)
        d = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return d.replace(tzinfo=UTC) if d.tzinfo is None else d.astimezone(UTC)
    except (ValueError, OverflowError):
        raise ImportProblem(f'Invalid date: {value}; use YYYY-MM-DD or an ISO timestamp.') from None


def _iso(value):
    return value.isoformat().replace('+00:00', 'Z') if value else None


def prepare(client, body, userdata):
    dataset, symbol = body.dataset.strip(), body.symbol.strip()
    if not dataset or not symbol:
        raise ImportProblem('Choose a dataset and one instrument or series.')
    meta = import_meta(client.vault_meta(), userdata)
    candle_classes = meta['candle_classes'] + meta['synth_candle_classes']
    if dataset in candle_classes:
        kind, tf = 'ohlcv', (body.timeframe or '1h').strip()
        if tf not in meta['timeframes']:
            raise ImportProblem('Choose a supported candle interval. Tick history is not available for library imports.')
    elif dataset in meta['series_classes']:
        kind, tf = 'series', None
    else:
        raise ImportProblem('Library imports support market candles, economic series and bond yields. Options, tick history and reference exports are unavailable.')
    start, end = _bound(body.start), _bound(body.end, end=True)
    # Freeze an open-ended walk so incoming live bars cannot keep it running.
    end = end or datetime.now(UTC)
    if start is not None and start >= end:
        raise ImportProblem('The start must be before the end.')
    usage = client._vault_call('/usage')
    try:
        row_cap = int(usage['max_rows_per_request'])
        rpm = int(usage['calls_per_minute'])
    except (KeyError, TypeError, ValueError):
        raise ImportProblem('Could not read the key limits; try again.', 502) from None
    row_cap = 5000 if row_cap == -1 else min(row_cap, 5000)
    if row_cap < (2 if kind == 'series' else 1) or rpm == 0 or rpm < -1:
        raise ImportProblem('The key does not allow this import.', 403)
    display = symbol
    for item in client.datasets(dataset):
        if item.get('symbol') == symbol:
            display = str(item.get('name') or symbol)
            break
    return {'dataset': dataset, 'symbol': symbol, 'kind': kind, 'timeframe': tf,
            'start': start, 'end': end, 'folder': body.folder.strip().strip('/'),
            'name': display, 'row_cap': row_cap,
            'interval': 60.0 / min(rpm, 55) if rpm > 0 else 0.05}


def _number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ImportProblem(f'The response contains an invalid {name}; nothing was imported.', 502)
    return value


def _row(row, spec):
    if not isinstance(row, dict) or row.get('symbol') != spec['symbol']:
        raise ImportProblem('The response contains another instrument; nothing was imported.', 502)
    if spec['kind'] == 'ohlcv':
        ts = _bound(row.get('timestamp'))
        if ts is None or ts.microsecond:
            raise ImportProblem('The candle response has an invalid bar timestamp.', 502)
        values = [_number(row.get(k), k) for k in ('open', 'high', 'low', 'close', 'volume')]
        o, h, l, c, v = values
        if l > min(o, c, h) or h < max(o, c, l) or v < 0:
            raise ImportProblem('The response contains invalid OHLCV values; nothing was imported.', 502)
        return ts, [int(ts.timestamp()), *values]
    try:
        d = date.fromisoformat(row['date'])
    except (KeyError, TypeError, ValueError):
        raise ImportProblem('The series response has an invalid observation date.', 502) from None
    ts = datetime.combine(d, datetime.min.time(), UTC)
    return ts, [int(ts.timestamp()) * 1000, _number(row.get('value'), 'value')]


def _read_manifest(path):
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return {}
    try:
        manifest = json.loads(raw)
    except (ValueError, UnicodeError):
        raise ImportProblem('The library index is unreadable; existing files were left unchanged.', 409) from None
    if not isinstance(manifest, dict):
        raise ImportProblem('The library index is invalid; existing files were left unchanged.', 409)
    return manifest


def _commit(stage, spec, userdata, rows, first, last):
    # Every existing library mutation takes this same short-lived lock.
    with userdata.STORE_LOCK:
        directory = userdata.data_dir()
        manifest_path = userdata._manifest_path()
        manifest = _read_manifest(manifest_path)
        base = userdata._slug(spec['symbol'] + ('_' + spec['timeframe'] if spec['timeframe'] else '')).upper()
        symbol, serial = base, 1
        occupied = {str(k).casefold() for k in manifest}
        while symbol.casefold() in occupied or (directory / f'{userdata._slug(symbol)}.csv').exists():
            serial += 1
            symbol = f'{base}_{serial}'
        destination = directory / f'{userdata._slug(symbol)}.csv'
        entry = {'symbol': symbol, 'name': spec['name'], 'kind': spec['kind'], 'folder': spec['folder'],
                 'columns': ['value'] if spec['kind'] == 'series' else [], 'file': destination.name, 'ext': '.csv',
                 'timeframe': spec['timeframe'], 'rows': rows,
                 'first_ts': int(first.timestamp()), 'last_ts': int(last.timestamp()),
                 'imported_at': int(time.time()), 'source': 'lse-import',
                 'source_dataset': spec['dataset'], 'source_symbol': spec['symbol']}
        manifest[symbol] = entry
        fd, name = tempfile.mkstemp(prefix='.lse-manifest-', suffix='.tmp', dir=directory)
        manifest_tmp = Path(name)
        installed = False
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(manifest, f, indent=2, allow_nan=False)
                f.write('\n')
                f.flush()
                os.fsync(f.fileno())
            os.replace(stage, destination)
            installed = True
            os.replace(manifest_tmp, manifest_path)
        except BaseException:
            if installed:
                destination.unlink(missing_ok=True)
            raise
        finally:
            manifest_tmp.unlink(missing_ok=True)
        return entry, destination.stat().st_size


def download(client, spec, userdata, job, *, sleep=time.sleep, monotonic=time.monotonic):
    directory = userdata.data_dir()
    directory.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.lse-import-', suffix='.part', dir=directory)
    stage = Path(name)
    first = last = last_values = None
    count = pages = 0
    cursor, next_call = spec['start'], 0.0
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='') as f:
            writer = csv.writer(f)
            writer.writerow(['ts', 'open', 'high', 'low', 'close', 'volume'] if spec['kind'] == 'ohlcv' else ['time', 'value'])
            while True:
                sleep(max(0.0, next_call - monotonic()))
                params = {'dataset': spec['dataset'], 'start': _iso(cursor), 'end': _iso(spec['end']),
                          'order': 'asc', 'limit': spec['row_cap']}
                next_call = monotonic() + spec['interval']
                if spec['kind'] == 'ohlcv':
                    response = client.candles(spec['symbol'], timeframe=spec['timeframe'], **params)
                else:
                    response = client.series(spec['symbol'], **params)
                pages += 1
                if not isinstance(response, list) or len(response) > spec['row_cap']:
                    raise ImportProblem('The server returned an invalid page; nothing was imported.', 502)
                old_last = last
                for i, item in enumerate(response):
                    ts, values = _row(item, spec)
                    if spec['kind'] == 'series' and old_last is not None and i == 0:
                        # Repeat the previous boundary day, proving that the page
                        # seam cannot silently skip another point on that date.
                        if ts != old_last or values != last_values:
                            raise ImportProblem('The series changed while downloading; retry the import.', 409)
                        continue
                    if last is not None and ts <= last:
                        raise ImportProblem('The response repeats or reorders timestamps. Multiple observations on one date cannot be imported without losing data.', 502)
                    if (spec['start'] is not None and ts < spec['start']) or ts >= spec['end']:
                        raise ImportProblem('The response contains rows outside the requested dates.', 502)
                    writer.writerow(values)
                    count += 1
                    first = first or ts
                    last, last_values = ts, values
                job.update(status='exporting', rows=count, pages=pages,
                           detail=f'Downloaded {count:,} rows in {pages} pages')
                if f.tell() > MAX_FILE_BYTES:
                    raise ImportProblem('This import exceeds the 300 MB library limit. Choose a shorter range or a coarser interval.', 413)
                if spec['kind'] == 'series' and old_last is not None and not response:
                    raise ImportProblem('The series changed while downloading; retry the import.', 409)
                if len(response) < spec['row_cap']:
                    break
                if last is None or (old_last is not None and last <= old_last):
                    raise ImportProblem('The server page made no progress; nothing was imported.', 502)
                cursor = last + timedelta(seconds=1) if spec['kind'] == 'ohlcv' else last
            if count == 0:
                raise ImportProblem('No stored data is available in this date range.', 404)
            f.flush()
            os.fsync(f.fileno())
        job.update(status='importing', detail='Saving the complete download to your library')
        entry, file_bytes = _commit(stage, spec, userdata, count, first, last)
        job.update(status='done', entry=entry, file_bytes=file_bytes,
                   detail=f'Imported {count:,} rows')
        return entry
    finally:
        stage.unlink(missing_ok=True)


def submit(client, body, userdata, jobs):
    """Keep the existing asynchronous job API used by the modal and tool."""
    global _active
    with _jobs_lock:
        if _active:
            raise ImportProblem('An LSE import is already running. Wait for it to finish.', 409)
        _active = True
    try:
        spec = prepare(client, body, userdata)
    except BaseException:
        with _jobs_lock:
            _active = False
        raise
    job_id = uuid.uuid4().hex[:12]
    job = {'id': job_id, 'status': 'exporting', 'detail': 'Reading available data',
           'dataset': spec['dataset'], 'symbol': spec['symbol']}
    jobs[job_id] = job
    def run():
        global _active
        try:
            download(client, spec, userdata, job)
        except Exception as exc:
            job.update(status='failed', error=str(getattr(exc, 'message', None) or exc)[:300],
                       error_status=getattr(exc, 'status', None))
        finally:
            with _jobs_lock:
                _active = False
    try:
        threading.Thread(target=run, daemon=True, name=f'lse-databank-{job_id}').start()
    except BaseException:
        jobs.pop(job_id, None)
        with _jobs_lock:
            _active = False
        raise
    return {'job_id': job_id}
