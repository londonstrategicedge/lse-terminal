// A real broker the terminal ships an adapter for is a row of its own, with its key boxes, before it
// is linked; one Connect links it as the user's own profile, stores what was typed and connects.
// Same method as the other .mjs tests: the functions are cut out of app.js by name and run in
// node:vm against stubs, so what is tested is the shipped text.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../lse_terminal/ui/static/app.js', import.meta.url), 'utf8');
function fn(name) {
  let start = src.indexOf('async function ' + name + '(');
  if (start < 0) start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'app.js has no function ' + name);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 2);
}
const X = { key: 'alpaca', name: 'Alpaca', label: 'Alpaca (paper trading)', args: ['--paper'],
  form: [{ key: 'api_key', label: 'API key ID', type: 'text' }, { key: 'api_secret', label: 'API secret key', type: 'password' }] };

function mk({ link = { ok: true, row: { broker: 'my-alpaca' } }, connect = null } = {}) {
  const calls = [];
  const ctx = {
    Object, String, Array, JSON, calls,
    connScreen: { keyDrafts: {}, errors: {}, addBusy: false, broker: '', brokerPinned: false, addFocus: '' },
    brokerPicker: { rows: [] },
    renderConnScreen: () => calls.push(['render', ctx.connScreen.addBusy]),
    refreshConnScreen: async () => {
      calls.push(['refresh', JSON.stringify(ctx.connScreen.keyDrafts)]);
      if (calls.some((c) => c[0] === 'link') && !ctx.brokerPicker.rows.length) {
        ctx.brokerPicker.rows.push({ broker: 'my-alpaca', registered: true, example: 'alpaca' });
      }
    },
    csLinkBroker: async (body) => { calls.push(['link', body]); return link; },
    csConnect: async (key, hub, boxes, stored) => {
      calls.push(['connect', key, hub && hub.broker, Object.fromEntries(Object.entries(boxes).map(([k, v]) => [k, v.value])), stored]);
      if (connect instanceof Error) throw connect;
      return connect;
    },
  };
  vm.createContext(ctx);
  for (const n of ['csSlug', 'csListWords', 'csDraft', 'csDraftSet', 'csDraftDrop', 'csExampleKey', 'csNativeConnect']) {
    vm.runInContext(fn(n), ctx);
  }
  return ctx;
}
const boxes = (k, s) => ({ api_key: { value: k }, api_secret: { value: s } });

// its key never collides with a profile ID (a ":" is never in one)
{
  const c = mk();
  assert.equal(c.csExampleKey(X), 'example:alpaca');
  assert.equal(c.csSlug('example:alpaca').includes(':'), false);
}
// an empty box stops it before anything is sent, and names the box
{
  const c = mk();
  await c.csNativeConnect(X, boxes('PKTEST', '  '));
  assert.equal(c.calls.filter((x) => x[0] === 'link' || x[0] === 'connect').length, 0);
  assert.match(c.connScreen.errors['example:alpaca'].message, /Type your API secret key, then press Connect/);
  assert.equal(c.connScreen.addFocus, 'cred:example:alpaca:api_secret');
}
// link, then the typed keys follow the new profile through the repaint, then save and connect
{
  const c = mk();
  await c.csNativeConnect(X, boxes(' PKTEST ', 'SECRET'));
  const link = c.calls.find((x) => x[0] === 'link');
  assert.deepEqual(JSON.parse(JSON.stringify(link[1])), { name: 'my-alpaca', example: 'alpaca' });
  const refresh = c.calls.find((x) => x[0] === 'refresh');
  assert.deepEqual(JSON.parse(refresh[1]), { 'my-alpaca': { api_key: 'PKTEST', api_secret: 'SECRET' } });
  const con = c.calls.find((x) => x[0] === 'connect');
  assert.deepEqual(JSON.parse(JSON.stringify(con.slice(1))), ['my-alpaca', 'my-alpaca', { api_key: 'PKTEST', api_secret: 'SECRET' }, []]);
  assert.ok(c.calls.indexOf(link) < c.calls.indexOf(refresh) && c.calls.indexOf(refresh) < c.calls.indexOf(con));
  assert.deepEqual(JSON.parse(JSON.stringify(c.connScreen.keyDrafts)), {});    // submitted: nothing typed is kept
  assert.equal(c.connScreen.broker, 'my-alpaca');
  assert.equal(c.connScreen.addBusy, false);
  assert.equal(Object.keys(c.connScreen.errors).length, 0);
  assert.equal(c.calls[c.calls.length - 1][0], 'render');
}
// the engine refuses the link: the adapter's own words on the row, nothing stored or connected
{
  const c = mk({ link: { ok: false, message: 'The adapter stopped before answering.', stderr: 'Traceback' } });
  await c.csNativeConnect(X, boxes('PKTEST', 'SECRET'));
  assert.equal(c.calls.filter((x) => x[0] === 'connect').length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(c.connScreen.errors['example:alpaca'])), { message: 'The adapter stopped before answering.', stderr: 'Traceback' });
  assert.equal(c.connScreen.addBusy, false);
}
// the broker refuses the key: said on the linked row, the screen not left busy
{
  const c = mk({ connect: new Error('Alpaca refused the key (401).') });
  await c.csNativeConnect(X, boxes('PKTEST', 'WRONG'));
  assert.equal(c.connScreen.errors['my-alpaca'].message, 'Alpaca refused the key (401).');
  assert.equal(c.connScreen.addBusy, false);
}
// a second press while one is running does nothing
{
  const c = mk();
  c.connScreen.addBusy = true;
  await c.csNativeConnect(X, boxes('PKTEST', 'SECRET'));
  assert.equal(c.calls.length, 0);
}
console.log('native broker rows: an empty box stops before sending; link, keys kept through the repaint, save and connect in order; refusals said on the right row; no double press');
