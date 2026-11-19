// The key boxes: boxes no browser offers to save or fill, masked on screen,
// taking a paste. The shipped functions are cut out of app.js by name and
// run in node:vm; the markup and the stylesheet are read.
//
// Guarded against: a listed row's boxes as type=password with
// autocomplete="off", which password managers ignore. With Chrome's
// password manager on, Chrome offers to save the row's login (its stats
// table keeps the login email in plain text); Edge has the same engine.
//
// What is pinned:
//   1. A key box (csSecretBox) is a text box masked by -webkit-text-security
//      where the browser has it (Chromium: the desktop app, Chrome, Edge):
//      never type=password there, which is what a password manager takes
//      for a login; autocomplete off, no name, the ignore marks password
//      manager extensions read; copy and cut refused, as a password box
//      refuses them; a paste taken.
//   2. A browser without -webkit-text-security gets a password box back, so
//      what is typed is never shown.
//   3. Every key box goes through it: a broker's hidden fields (a listed
//      row's and a linked row's), and the four LSE key boxes. A field that
//      is not hidden (a login email) stays a plain text box. No box in the
//      page or its markup is type=password but csSecretBox's own fallback.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test, done } from './ticket_page.mjs';

const src = fs.readFileSync(new URL('../lse_terminal/ui/static/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../lse_terminal/ui/static/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../lse_terminal/ui/static/style.css', import.meta.url), 'utf8');
function cut(name) {
  let start = src.indexOf('\nasync function ' + name + '(');
  if (start < 0) start = src.indexOf('\nfunction ' + name + '(');
  assert.ok(start >= 0, 'no function ' + name);
  return src.slice(start + 1, src.indexOf('\n}\n', start) + 2);
}

function input() {
  const attrs = {}, listeners = {}, cls = new Set();
  return { tagName: 'INPUT', type: 'text', autocomplete: '', spellcheck: true, dataset: {}, value: '', name: '',
    attrs, listeners,
    setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return k in attrs ? attrs[k] : null },
    removeAttribute(k) { delete attrs[k]; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    classList: { add: (c) => cls.add(c), contains: (c) => cls.has(c), remove: (c) => cls.delete(c) } };
}
function ctx(supports) {
  const c = { String, CSS: { supports: (p, v) => supports && p === '-webkit-text-security' && v === 'disc' } };
  vm.createContext(c);
  vm.runInContext(cut('csSecretBox'), c);
  return c;
}
const fire = (inp, type) => { let stopped = false;
  for (const fn of inp.listeners[type] || []) fn({ preventDefault() { stopped = true; } });
  return stopped; };

await test('1. a key box in Chromium: a masked text box, never type=password', () => {
  const c = ctx(true);
  const inp = c.csSecretBox(input());
  assert.equal(inp.type, 'text');
  assert.ok(inp.classList.contains('cs-secret'), 'masked by the stylesheet');
  assert.equal(inp.autocomplete, 'off');
  assert.equal(inp.spellcheck, false);
  assert.equal(inp.name, '', 'no name for a manager to file it under');
  assert.equal(inp.dataset.secret, '1');
  for (const k of ['data-1p-ignore', 'data-lpignore', 'data-bwignore', 'data-form-type']) {
    assert.ok(inp.getAttribute(k) !== null, 'marked for password manager extensions: ' + k);
  }
  assert.equal(fire(inp, 'copy'), true, 'copy refused');
  assert.equal(fire(inp, 'cut'), true, 'cut refused');
  assert.equal(fire(inp, 'paste'), false, 'a paste is taken');
  assert.ok(/\.cs-secret\s*\{[^}]*-webkit-text-security:\s*disc/.test(css), 'the stylesheet masks it');
});

await test('2. a browser without -webkit-text-security: a password box, so nothing typed is shown', () => {
  const inp = ctx(false).csSecretBox(input());
  assert.equal(inp.type, 'password');
});

await test('3. a broker\'s hidden fields go through it, its email box does not', () => {
  for (const fn of ['csBrokerCard', 'csExampleRow']) {
    const body = cut(fn);
    assert.ok(/f\.type === "password"\s*\?\s*csSecretBox\(/.test(body) || /csSecretBox\(inp\)/.test(body),
              fn + ' masks its hidden fields through csSecretBox');
    assert.ok(!/inp\.type = f\.type === "password" \? "password"/.test(body), fn + ' still makes a password box');
  }
});

await test('3. the LSE key boxes go through it, and no box is type=password but its fallback', () => {
  assert.ok(/<input id="lse-key" type="text" class="cs-secret"/.test(html), 'the MARKETS key form\'s box');
  assert.ok(!/type="password"/.test(html), 'no password box in the markup');
  // a box made a password box: an assignment to .type (not the === guard) whose
  // value is "password". csSecretBox's masked?-fallback ternary is the only one.
  const left = src.split('\n').filter((l) => /\.type\s*=\s*[^=]/.test(l) && /"password"/.test(l) && !/===/.test(l));
  assert.deepEqual(left.map((l) => l.trim()), ['inp.type = masked ? "text" : "password";'],
                   'only csSecretBox\'s own fallback');
  for (const where of ['lse-key', 'conn-keyline', 'cs-keyline', 'air-code']) {
    assert.ok(src.includes(where), where);
  }
  // each LSE key box is put through it
  assert.ok(/csSecretBox\(\$\("lse-key"\)\)/.test(src), '#lse-key');
  assert.ok(/csSecretBox\(keyline\.querySelector\("input"\)\)/.test(src), 'the connection menu\'s');
  assert.ok(/const input = csSecretBox\(document\.createElement\("input"\)\)/.test(src), 'the LSE card\'s');
  assert.ok(/const inp = csSecretBox\(document\.createElement\("input"\)\)/.test(src), 'the assistant\'s');
});

done('test_key_boxes.mjs');
