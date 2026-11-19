// Code comments a visitor reads name no broker: the Connections screen shows
// each broker it ships, by name and logo, because that is the product; the
// code's comments say "a broker", "a listed row". Every comment line of the
// page (app.js, index.html), its stylesheet, the chart's TypeScript source
// and the page tests is read, block-comment continuation lines included, by
// a lexer that knows strings, template literals, regular expressions and
// JSX, so a broker's name in an identifier, a string or test data is not
// taken for a comment, and a comment is not missed. The user's guide may
// name the rows the product shows and is not read here.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = new URL('..', import.meta.url).pathname;
// The rows the terminal lists, by every spelling, and other brokers' names.
const BROKERS = /alpaca|oanda|capital\.com|capitalcom|interactive brokers|\bibkr\b|\bsaxo\b|etoro|pepperstone|ic markets|\bfxcm\b|plus500|\bxtb\b|dukascopy|tradovate|ameritrade|schwab|robinhood|webull|tradier|tastytrade|zerodha|exness|binance|coinbase|kraken/i;

// ── a lexer that yields each comment's text with its first line number ─────
export function comments(text, jsx = false) {
  const out = [];
  let i = 0, line = 1;
  const n = text.length;
  const adv = (k = 1) => { for (let j = 0; j < k; j++) { if (text[i] === '\n') line++; i++; } };
  // the last significant thing seen in code: decides "/" (regex or divide)
  // and "<" (JSX or less-than)
  let prev = '';
  const exprStart = () => prev === '' || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || prev === '=>'
    || /^(return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await|instanceof)$/.test(prev);
  function comment() {
    const start = line;
    if (text[i + 1] === '/') {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      out.push({ line: start, text: text.slice(i, j) });
      adv(j - i);
    } else {
      const j = text.indexOf('*/', i + 2);
      const end = j < 0 ? n : j + 2;
      out.push({ line: start, text: text.slice(i, end) });
      adv(end - i);
    }
  }
  // a '...' or "..." string; one in code ends at its line if unterminated,
  // a JSX attribute's may span lines
  function quoted(q, lines = false) {
    adv();
    while (i < n && text[i] !== q) {
      if (text[i] === '\\') { adv(2); continue; }
      if (text[i] === '\n' && !lines) break;
      adv();
    }
    adv();
  }
  function template() {
    adv();                                    // the opening backtick
    while (i < n && text[i] !== '`') {
      if (text[i] === '\\') { adv(2); continue; }
      if (text[i] === '$' && text[i + 1] === '{') { adv(2); code('}'); adv(); continue; }
      adv();
    }
    adv();
  }
  function regex() {
    adv();
    let cls = false;
    while (i < n) {
      const ch = text[i];
      if (ch === '\\') { adv(2); continue; }
      if (ch === '\n') break;
      if (cls) { if (ch === ']') cls = false; } else if (ch === '[') cls = true; else if (ch === '/') break;
      adv();
    }
    adv();
    while (i < n && /[a-z]/i.test(text[i])) adv();
  }
  // JSX: an element and its children, comments only inside its {expressions}
  function element() {
    adv();                                    // "<"
    let closing = false;
    if (text[i] === '/') { closing = true; adv(); }
    // the tag and its attributes
    while (i < n && text[i] !== '>') {
      const ch = text[i];
      if (ch === '"' || ch === "'") { quoted(ch, true); continue; }
      if (ch === '{') { adv(); code('}'); adv(); continue; }
      if (ch === '/' && text[i + 1] === '>') { adv(2); return 'self'; }
      if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) { comment(); continue; }
      adv();
    }
    adv();                                    // ">"
    if (closing) return 'closed';
    // its children, up to its own closing tag
    for (;;) {
      while (i < n && text[i] !== '<' && text[i] !== '{') adv();
      if (i >= n) return 'open';
      if (text[i] === '{') { adv(); code('}'); adv(); continue; }
      if (text[i + 1] === '/') { element(); return 'done'; }
      element();
    }
  }
  function code(stop) {
    let depth = 0;
    while (i < n) {
      const ch = text[i];
      if (stop && ch === stop && depth === 0) return;
      if (ch === '{' || ch === '(' || ch === '[') { if (ch === '{' && stop === '}') depth++; prev = ch; adv(); continue; }
      if (ch === '}' || ch === ')' || ch === ']') { if (ch === '}' && stop === '}') depth--; prev = ch; adv(); continue; }
      if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) { comment(); continue; }
      if (ch === '"' || ch === "'") { quoted(ch); prev = 'str'; continue; }
      if (ch === '`') { template(); prev = 'str'; continue; }
      if (ch === '/') {
        if (exprStart()) { regex(); prev = 'rx'; } else { prev = '/'; adv(); }
        continue;
      }
      if (jsx && ch === '<' && exprStart() && /[A-Za-z>]/.test(text[i + 1] || '')) { element(); prev = 'jsx'; continue; }
      if (/\s/.test(ch)) { adv(); continue; }
      if (/[A-Za-z_$0-9]/.test(ch)) {
        let j = i;
        while (j < n && /[A-Za-z_$0-9]/.test(text[j])) j++;
        prev = text.slice(i, j);
        adv(j - i);
        continue;
      }
      if (ch === '=' && text[i + 1] === '>') { prev = '=>'; adv(2); continue; }
      prev = ch;
      adv();
    }
  }
  code('');
  return out;
}
export function cssComments(text) {
  return [...text.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => ({ line: text.slice(0, m.index).split('\n').length, text: m[0] }));
}
// an HTML file's comments, and its inline scripts' and styles'
export function htmlComments(text) {
  const at = (k) => text.slice(0, k).split('\n').length;
  const out = [...text.matchAll(/<!--[\s\S]*?-->/g)].map((m) => ({ line: at(m.index), text: m[0] }));
  for (const m of text.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    const first = at(m.index + '<script>'.length) - 1;
    out.push(...comments(m[1]).map((c) => ({ line: first + c.line, text: c.text })));
  }
  for (const m of text.matchAll(/<style>([\s\S]*?)<\/style>/g)) {
    const first = at(m.index + '<style>'.length) - 1;
    out.push(...cssComments(m[1]).map((c) => ({ line: first + c.line, text: c.text })));
  }
  return out;
}
// every source line of every comment
export function commentLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  const found = file.endsWith('.css') ? cssComments(text)
    : file.endsWith('.html') ? htmlComments(text)
    : comments(text, file.endsWith('.tsx'));
  const lines = [];
  for (const c of found) c.text.split('\n').forEach((t, k) => lines.push({ line: c.line + k, text: t }));
  return lines;
}
export function files() {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
  return [
    path.join(root, 'lse_terminal/ui/static/app.js'),
    path.join(root, 'lse_terminal/ui/static/index.html'),
    path.join(root, 'lse_terminal/ui/static/style.css'),
    ...walk(path.join(root, 'frontend/src')).sort(),
    ...fs.readdirSync(path.join(root, 'tests')).filter((f) => f.endsWith('.mjs')).sort().map((f) => path.join(root, 'tests', f)),
  ];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // the lexer on what it must tell apart
  const t = comments([
    "const a = 'alpaca'; // one",
    'const b = "x // not a comment";',
    'const r = /\\/\\/ not one/g; /* two',
    '   three */',
    'const s = `a ${ "//" } // still a string`;',
    'const d = 4 / 2 / 1; // four',
  ].join('\n'));
  assert.deepEqual(t.map((c) => [c.line, c.text]), [[1, '// one'], [3, '/* two\n   three */'], [6, '// four']]);
  const x = comments([
    "const el = <a href='//x'>Don't // here {/* inside */} and {'//'}</a>; // after",
    'const lt = a < b; // less',
  ].join('\n'), true);
  assert.deepEqual(x.map((c) => [c.line, c.text]), [[1, '/* inside */'], [1, '// after'], [2, '// less']]);

  const bad = [];
  let read = 0;
  for (const f of files()) {
    for (const l of commentLines(f)) {
      read++;
      if (BROKERS.test(l.text)) bad.push(`${path.relative(root, f)}:${l.line}: ${l.text.trim().slice(0, 160)}`);
    }
  }
  assert.ok(read > 10000, 'read ' + read + ' comment lines');
  assert.deepEqual(bad, [], 'comments that name a broker:\n' + bad.join('\n'));
  console.log(`test_comments_name_no_broker.mjs: ok (${read} comment lines in ${files().length} files)`);
}
