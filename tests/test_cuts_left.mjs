// Words the page cuts at a fixed length. Four were left in app.js after the
// broker paths were cleared of them: the assistant's
// sign-out failure (60 characters, carrying the engine's detail), an
// assistant stream's exception (200), a directory row's welcome line (160)
// and an installer line (160). The shipped functions are cut out of app.js
// by name and run in node:vm where they can be; the two inside the
// assistant's closures are read in the source.
//
// What is pinned:
//   1. Each is shown whole, on one line (runs of spaces, tabs and line breaks
//      read as one space): oneLine.
//   2. Where the layout needs a cut (an installer line in a library row's
//      status cell), the cell cuts it with a visible "…" (CSS ellipsis) and
//      keeps the whole line as its tooltip; nothing is lost from the words.
//   3. None of the four fixed-length cuts is left.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test, done } from './ticket_page.mjs';

const src = fs.readFileSync(new URL('../lse_terminal/ui/static/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../lse_terminal/ui/static/style.css', import.meta.url), 'utf8');
function cut(name) {
  let start = src.indexOf('\nasync function ' + name + '(');
  if (start < 0) start = src.indexOf('\nfunction ' + name + '(');
  assert.ok(start >= 0, 'no function ' + name);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start + 1, end + 2);
}
const LONG = 'pip: ' + 'x'.repeat(150) + '\n  then\tthe rest of the line that matters ' + 'y'.repeat(120);
const ONE = LONG.replace(/\s+/g, ' ').trim();

await test('1. oneLine: the words whole, on one line', () => {
  const c = { String };
  vm.createContext(c);
  vm.runInContext(cut('oneLine'), c);
  assert.equal(c.oneLine(LONG), ONE);
  assert.equal(c.oneLine(LONG).length, ONE.length, 'nothing cut');
  assert.equal(c.oneLine(null), '');
  assert.equal(c.oneLine('  a \n b  '), 'a b');
});

await test('1. an installer line (pip\'s own) is whole, on one line', () => {
  const c = { String, Math };
  vm.createContext(c);
  vm.runInContext(cut('oneLine'), c);
  vm.runInContext(cut('mlInstallLine'), c);
  assert.equal(c.mlInstallLine({ stage: 'other', line: LONG }), ONE);
  assert.equal(c.mlInstallLine({ stage: 'other' }), '');
});

await test('1. a directory row\'s welcome line is whole, on one line', () => {
  // the card's welcome note, as csBrokerCard builds it
  const at = src.indexOf('if (extra.welcome) {');
  assert.ok(at > 0);
  const block = src.slice(at, src.indexOf('\n  }\n', at) + 4);
  const made = [];
  const c = { String, extra: { welcome: LONG }, card: { appendChild: (e) => made.push(e) },
              document: { createElement: () => ({ className: '', textContent: '' }) } };
  vm.createContext(c);
  vm.runInContext(cut('oneLine'), c);
  vm.runInContext(block, c);
  assert.equal(made.length, 1);
  assert.equal(made[0].textContent, ONE);
});

await test('1. the sign-out failure and a stream\'s exception say the words whole', () => {
  assert.ok(/Sign out failed: \$\{oneLine\(e\.message \|\| e\)\}/.test(src), 'the sign-out failure through oneLine');
  assert.ok(/kind: "error", text: oneLine\(e\) \|\| "error"/.test(src), 'the stream exception through oneLine');
});

await test('2. a library row\'s status cell cuts with a visible "…" and keeps the whole line as its tooltip', () => {
  assert.ok(/#ml-libs \.ml-lib-status\.busy \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/
    .test(css), 'the busy status cell ends in an ellipsis');
  const at = src.indexOf('const setStatus = (line) => {');
  assert.ok(at > 0);
  const body = src.slice(at, src.indexOf('\n  };', at));
  assert.ok(/st\.title = line;/.test(body), 'the whole line is the cell\'s tooltip');
});

await test('3. none of the four fixed-length cuts is left', () => {
  for (const old of ['String(e.message || e).slice(0, 60)', 'String(e).slice(0, 200)',
                     'String(extra.welcome).slice(0, 160)', '(f.line || "").slice(0, 160)']) {
    assert.ok(!src.includes(old), 'still cut: ' + old);
  }
});

done('test_cuts_left.mjs');
