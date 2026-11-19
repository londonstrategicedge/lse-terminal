// The rail's model menus are built from what the user's own CLI says
// (GET /api/ai/models), not from a list typed into the page.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../lse_terminal/ui/static/app.js', import.meta.url), 'utf8');
const begin = src.indexOf('const AIR_CLAUDE_MODELS = [');
const end = src.indexOf('const AIR_EFFORTS =');
assert.ok(begin > 0 && end > begin, 'the model block is where the test expects it');
const block = src.slice(begin, end);

// No exact model id and no version number may be typed into the page again:
// that is the list that went out of date.
assert.ok(!/gpt-\d/.test(block), 'no exact ChatGPT model id in the page');
assert.ok(!/claude-(opus|sonnet|haiku|fable)-\d/.test(block), 'no exact Claude model id in the page');
assert.ok(!/(Opus|Sonnet|Haiku|Fable) \d/.test(block), 'no model version in the page words');

function page(stored, answers) {
  const store = new Map(Object.entries(stored || {}));
  const asked = [];
  const posts = [];
  const c = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
    },
    fetch: (url, opts) => {
      if (opts && opts.method === 'POST') posts.push({ url, body: JSON.parse(opts.body) });
      else asked.push(url);
      const a = answers.shift();
      if (a instanceof Error) return Promise.reject(a);
      return Promise.resolve({ ok: a.status === undefined || a.status === 200, json: () => Promise.resolve(a.body) });
    },
    Date, JSON, Promise, encodeURIComponent, String, Array, Object,
  };
  vm.createContext(c);
  vm.runInContext(block + '\nglobalThis.x = { modelsFor, modelMenuRows, aiModelsRefresh, aiModelsApply, modelUpdateNote, aiLiveModels, aiCliUpdate, aiCliUpdating, aiShouldAutoUpdate, aiUpdateOffer };', c);
  return { x: c.x, asked, posts, store };
}
const ids = (rows) => Array.from(rows, (r) => r.id);
const fixture = (name) => JSON.parse(fs.readFileSync(new URL('./data/agent_models/' + name, import.meta.url), 'utf8'));

// What the engine answers, built from the real fixtures the way agent_models.py builds it.
const codexAnswer = {
  ok: true, agent: 'codex', source: 'cli', unavailable: [],
  models: [{ id: '', name: 'Default (recommended)', desc: 'Codex picks the model for you' }].concat(
    fixture('codex_0.161.0_account_catalogue.json').models
      .filter((m) => m.visibility === 'list').sort((a, b) => a.priority - b.priority)
      .map((m) => ({ id: m.slug, name: m.display_name, desc: m.description }))),
};
const claudeOld = {
  ok: true, agent: 'claude', source: 'cli',
  models: [
    { id: '', name: 'Default (recommended)', desc: 'Opus 4.8 with 1M context' },
    { id: 'opus[1m]', name: 'Opus', desc: 'Opus 4.8 with 1M context' },
    { id: 'sonnet', name: 'Sonnet', desc: 'Sonnet 5' },
  ],
  unavailable: [{ name: 'Opus 5.5', desc: 'Update to 2.1.280+ to use Opus 5.5' }],
};

// 1. Before any CLI has answered: names that cannot go dead, and a typed name for every provider.
{
  const { x } = page({}, []);
  assert.deepEqual(ids(x.modelsFor('claude')), ['', 'opus', 'fable', 'sonnet', 'haiku']);
  assert.deepEqual(ids(x.modelsFor('codex')), ['']);
  assert.deepEqual(ids(x.modelsFor('gemini')), ['']);
  for (const agent of ['claude', 'codex', 'gemini']) {
    const rows = x.modelMenuRows(agent);
    assert.equal(rows[rows.length - 1].id, '__custom', agent + ' can always type a model');
  }
}

// 2. The CLI's answer becomes the menu, in its order and its words, and is kept for the next launch.
{
  const { x, asked, store } = page({}, [{ body: codexAnswer }, { body: codexAnswer }]);
  assert.equal(await x.aiModelsRefresh('codex'), true, 'the rows changed');
  assert.deepEqual(asked, ['/api/ai/models?agent=codex']);
  assert.deepEqual(ids(x.modelsFor('codex')), ['', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra',
    'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
  assert.equal(x.modelsFor('codex')[1].name, 'GPT-6.1 Terra');
  assert.ok(!ids(x.modelsFor('codex')).includes('gpt-5.5'), 'a withdrawn model is not offered');
  assert.equal(await x.aiModelsRefresh('codex', true), false, 'the same answer changes nothing');
  assert.equal(asked[1], '/api/ai/models?agent=codex&refresh=1');
  const kept = JSON.parse(store.get('lset-air-models'));
  assert.equal(kept.codex.models.length, 9);

  // The next launch starts from the kept answer, before anything is asked.
  const next = page({ 'lset-air-models': store.get('lset-air-models') }, []);
  assert.equal(next.x.modelsFor('codex')[1].id, 'gpt-6.1-terra');
  assert.equal(next.asked.length, 0);
}

// 3. A model that needs a newer CLI is shown with the CLI's own line and cannot be picked.
{
  const { x } = page({}, [{ body: claudeOld }]);
  await x.aiModelsRefresh('claude');
  const rows = Array.from(x.modelMenuRows('claude'));
  assert.deepEqual(ids(rows), ['', 'opus[1m]', 'sonnet', '__update:0', '__custom']);
  const gated = rows[3];
  assert.equal(gated.needsUpdate, true);
  assert.equal(gated.name, 'Opus 5.5');
  assert.equal(gated.desc, 'Update to 2.1.280+ to use Opus 5.5');
  const note = x.modelUpdateNote('claude', gated);
  assert.ok(note.includes('Opus 5.5') && note.includes('/update') && note.includes('2.1.280') && note.includes('Claude Code'));
  // only real models are selectable rows of modelsFor (the label lookup)
  assert.ok(!ids(x.modelsFor('claude')).some((id) => id.startsWith('__')));
}

// 3b. A CLI that is itself behind its newest version: one row offers the update, with both versions.
const behindCli = (extra) => Object.assign({ name: 'Codex', installed: '0.144.6', latest: '0.169.0', outdated: true, update: 'codex update', auto: null, tried: '', updating: false }, extra || {});
{
  const behind = Object.assign({}, codexAnswer, { cli: behindCli() });
  const current = Object.assign({}, codexAnswer, { cli: behindCli({ installed: '0.169.0', outdated: false }) });
  const { x, store } = page({}, [{ body: behind }, { body: current }]);
  await x.aiModelsRefresh('codex');
  let rows = Array.from(x.modelMenuRows('codex'));
  const row = rows[rows.length - 2];
  assert.equal(rows[rows.length - 1].id, '__custom');
  assert.equal(row.id, '__update:cli');
  assert.equal(row.cliUpdate, true);
  assert.ok(!row.needsUpdate, 'the row is a button, not a dimmed line');
  assert.equal(row.name, 'Update Codex to 0.169.0');
  assert.ok(row.desc.includes('0.144.6') && row.desc.includes('keep it up to date'));
  // It is kept with the list, so the next launch shows it before anything is asked...
  const next = page({ 'lset-air-models': store.get('lset-air-models') }, []);
  assert.ok(Array.from(next.x.modelMenuRows('codex')).some((r) => r.id === '__update:cli'));
  // ...but an answer kept from the last launch never starts an update or a note.
  next.x.aiLiveModels.codex.cli.auto = true;
  assert.equal(next.x.aiShouldAutoUpdate('codex'), false);
  assert.equal(next.x.aiUpdateOffer('codex'), '');
  // Once the CLI is current the row goes, and that counts as a change to redraw.
  assert.equal(await x.aiModelsRefresh('codex'), true);
  rows = Array.from(x.modelMenuRows('codex'));
  assert.ok(!rows.some((r) => r.id === '__update:cli'));
  // No verdict (offline, or no version read) draws no row.
  const { x: y } = page({}, [{ body: Object.assign({}, codexAnswer, { cli: behindCli({ latest: '', outdated: false }) }) }]);
  await y.aiModelsRefresh('codex');
  assert.ok(!Array.from(y.modelMenuRows('codex')).some((r) => r.id === '__update:cli'));
}

// 3c. When the terminal updates the CLI by itself, and when it only says so.
{
  const answer = (cli) => ({ body: Object.assign({}, codexAnswer, { cli }) });
  // Never chosen: no update by itself; one line, once per new version.
  let p = page({}, [answer(behindCli()), answer(behindCli()), answer(behindCli({ latest: '0.170.0' }))]);
  await p.x.aiModelsRefresh('codex');
  assert.equal(p.x.aiShouldAutoUpdate('codex'), false);
  const offer = p.x.aiUpdateOffer('codex');
  assert.ok(offer.includes('Codex 0.169.0 is out') && offer.includes('0.144.6') && offer.includes('/update'));
  await p.x.aiModelsRefresh('codex');
  assert.equal(p.x.aiUpdateOffer('codex'), '', 'said once for this version');
  await p.x.aiModelsRefresh('codex');
  assert.ok(p.x.aiUpdateOffer('codex').includes('0.170.0'), 'said again for the next version');
  // The next launch does not repeat it either.
  const again = page({ 'lset-air-update-offered': p.store.get('lset-air-update-offered') }, [answer(behindCli({ latest: '0.170.0' }))]);
  await again.x.aiModelsRefresh('codex');
  assert.equal(again.x.aiUpdateOffer('codex'), '');

  // Turned on: update by itself, and the row no longer asks to "keep it up to date".
  p = page({}, [answer(behindCli({ auto: true }))]);
  await p.x.aiModelsRefresh('codex');
  assert.equal(p.x.aiShouldAutoUpdate('codex'), true);
  assert.equal(p.x.aiUpdateOffer('codex'), '');
  const rowOn = Array.from(p.x.modelMenuRows('codex')).find((r) => r.id === '__update:cli');
  assert.ok(rowOn.desc.endsWith('Click to update now.'));
  // ...but not a version an update already failed to reach, and not when the user said no.
  p = page({}, [answer(behindCli({ auto: true, tried: '0.169.0' }))]);
  await p.x.aiModelsRefresh('codex');
  assert.equal(p.x.aiShouldAutoUpdate('codex'), false);
  p = page({}, [answer(behindCli({ auto: false }))]);
  await p.x.aiModelsRefresh('codex');
  assert.equal(p.x.aiShouldAutoUpdate('codex'), false);
  assert.equal(p.x.aiUpdateOffer('codex'), '', 'a user who said no is not asked again');
  assert.ok(Array.from(p.x.modelMenuRows('codex')).some((r) => r.id === '__update:cli'), 'the row stays for when they want it');
}

// 3d. The update itself: one request to the engine, the row busy meanwhile, then the CLI asked again.
{
  const answer = (cli) => ({ body: Object.assign({}, codexAnswer, { cli }) });
  const done = { ok: true, changed: true, before: '0.144.6', after: '0.169.0', error: '' };
  const p = page({}, [answer(behindCli()), { body: done }, answer(behindCli({ installed: '0.169.0', outdated: false, auto: true }))]);
  await p.x.aiModelsRefresh('codex');
  const running = p.x.aiCliUpdate('codex', true);
  const busy = Array.from(p.x.modelMenuRows('codex')).find((r) => r.id === '__update:cli');
  assert.ok(busy.busy && busy.needsUpdate && busy.name === 'Updating Codex…');
  assert.equal(await p.x.aiCliUpdate('codex', true), null, 'a second click while it runs does nothing');
  const res = await running;
  assert.equal(res.ok, true);
  assert.equal(res.after, '0.169.0');
  assert.deepEqual(p.posts, [{ url: '/api/ai/update', body: { agent: 'codex', asked: true } }]);
  assert.equal(p.asked[p.asked.length - 1], '/api/ai/models?agent=codex&refresh=1');
  assert.ok(!Array.from(p.x.modelMenuRows('codex')).some((r) => r.id === '__update:cli'), 'the row is gone once it is current');
  assert.equal(p.x.aiLiveModels.codex.auto, true);
  // The engine refusing (a message is being answered) or being away is an answer, not an exception.
  const q = page({}, [answer(behindCli({ auto: true })), { status: 409, body: { detail: 'a message is being answered; update when it has finished' } }, answer(behindCli({ auto: true })),
    new Error('engine away'), answer(behindCli({ auto: true }))]);
  await q.x.aiModelsRefresh('codex');
  const refused = await q.x.aiCliUpdate('codex', false);
  assert.equal(refused.ok, false);
  assert.ok(refused.error.includes('being answered'));
  assert.deepEqual(q.posts[0].body, { agent: 'codex', asked: false });
  const away = await q.x.aiCliUpdate('codex', false);
  assert.equal(away.ok, false);
  assert.equal(q.x.aiCliUpdating.codex, false);
}

// 4. A CLI that cannot answer leaves the menu as it was; nothing throws.
{
  const { x } = page({}, [{ body: codexAnswer }, { body: { ok: false, models: [], error: 'not installed' } },
    { status: 403, body: {} }, new Error('engine away'), { body: null }, { body: { ok: true, models: [] } }]);
  await x.aiModelsRefresh('codex');
  for (let i = 0; i < 5; i += 1) assert.equal(await x.aiModelsRefresh('codex'), false);
  assert.equal(x.modelsFor('codex').length, 9);
  assert.equal(await x.aiModelsRefresh('lse'), false, 'the hosted assistant has no model menu');
  assert.equal(await x.aiModelsRefresh(''), false);
}

// 5. Rows the page will not take: not strings, too long, no name.
{
  const { x } = page({}, []);
  assert.equal(x.aiModelsApply('codex', { ok: true, models: [
    { id: 5, name: 'number id' }, { id: 'x'.repeat(101), name: 'long' }, { id: 'no-name' }, null,
    { id: 'kept', name: 'Kept', desc: 7 },
  ] }), true);
  assert.deepEqual(ids(x.modelsFor('codex')), ['kept']);
  assert.equal(x.modelsFor('codex')[0].desc, '7');
}

// 6. A kept answer older than a week is dropped, not trusted.
{
  const old = { codex: { models: [{ id: 'gpt-old', name: 'Old', desc: '' }], unavailable: [], at: Date.now() - 8 * 86400 * 1000 } };
  const { x } = page({ 'lset-air-models': JSON.stringify(old) }, []);
  assert.deepEqual(ids(x.modelsFor('codex')), ['']);
  const { x: y } = page({ 'lset-air-models': '{not json' }, []);
  assert.deepEqual(ids(y.modelsFor('codex')), ['']);
}

// 7. Both menus draw the same rows, and neither keeps a typed list of its own.
assert.equal((src.match(/modelMenuRows\(ai\.agent\)/g) || []).length, 3, 'the "/" menu, its pick and the header menu share one row builder');
assert.ok(!src.includes('ai.agent === "claude" ? []'), 'Claude is no longer left without the typed-name row');

console.log('Live model menus: built-in names cannot go dead; the CLI\'s answer is the menu, kept for the next launch; update-gated rows carry the CLI\'s line; a CLI behind its newest version is one click (or automatic once chosen) from current; a silent CLI changes nothing.');
