// The connected row's pill on the Connections screen says "● Connected ·
// LIVE": the pill is drawn in var(--cs-on) with the pill's own ink, and the
// LIVE word inside it must be drawn in that ink too, readable in both themes.
// It was drawn in var(--text), which in the dark theme is the pill's own
// colour (#e8e8e8 on #e8e8e8). The stylesheet is read as text and its
// cascade worked out for the pill's own markup (csBrokerRow: div.cs-brow >
// button.cs-bhead > span.cs-pickstate.ok > span.cs-live): the rule that wins
// for each element by specificity, then order, with `inherit` and no colour
// taking the parent's; var() resolved in each theme.
import fs from 'node:fs';
import assert from 'node:assert/strict';

const css = fs.readFileSync(new URL('../lse_terminal/ui/static/style.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [];
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const decls = {};
  for (const d of m[2].split(';')) {
    const i = d.indexOf(':');
    if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
  }
  for (const sel of m[1].split(',')) rules.push({ sel: sel.trim(), decls, order: rules.length });
}

// A compound selector (".cs-brow.on", "html:not(.dark)", "span") against an
// element {tag, classes}; null for what this test does not model.
function compound(c, el) {
  if (/::|:hover|:focus|:active|:disabled|\[|#/.test(c)) return false;
  const not = [...c.matchAll(/:not\(\.([\w-]+)\)/g)].map((x) => x[1]);
  const rest = c.replace(/:not\(\.[\w-]+\)/g, '');
  if (/:/.test(rest)) return false;
  const tag = (rest.match(/^[a-z]+/) || [''])[0];
  const classes = [...rest.matchAll(/\.([\w-]+)/g)].map((x) => x[1]);
  if (tag && tag !== el.tag) return false;
  if (!classes.every((k) => el.classes.includes(k))) return false;
  return !not.some((k) => el.classes.includes(k));
}
// The whole selector against the element at `at` of the path (outermost first).
function matches(sel, path, at) {
  const parts = sel.replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
  if (parts[0] === ':root') parts[0] = 'html';
  let i = at;
  let k = parts.length - 1;
  if (!compound(parts[k], path[i])) return false;
  k--;
  while (k >= 0) {
    const child = parts[k] === '>';
    if (child) k--;
    if (child) {
      i--;
      if (i < 0 || !compound(parts[k], path[i])) return false;
    } else {
      do { i--; } while (i >= 0 && !compound(parts[k], path[i]));
      if (i < 0) return false;
    }
    k--;
  }
  return true;
}
const specificity = (sel) => {
  const s = sel.replace(/::[\w-]+/g, '');
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const cls = (s.match(/\.[\w-]+|:not\(|\[/g) || []).length + (s.match(/:(?!not)[\w-]+/g) || []).length;
  const tags = (s.replace(/:not\([^)]*\)/g, '').match(/(^|[\s>])[a-z]+/g) || []).length;
  return ids * 10000 + cls * 100 + tags;
};
function won(prop, path, at) {
  let best = null;
  for (const r of rules) {
    if (!(prop in r.decls) || !matches(r.sel, path, at)) continue;
    const key = [specificity(r.sel), r.order];
    if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && key[1] > best.key[1])) best = { key, r };
  }
  return best ? best.r : null;
}
function tokens(dark) {
  const out = {};
  for (const r of rules) {
    const applies = r.sel === ':root' || (dark ? r.sel === 'html.dark' : r.sel === 'html:not(.dark)');
    if (!applies) continue;
    for (const [k, v] of Object.entries(r.decls)) if (k.startsWith('--')) out[k] = v;
  }
  return out;
}
function resolve(v, t) {
  for (let i = 0; i < 10 && /var\(/.test(v); i++) v = v.replace(/var\((--[\w-]+)\)/g, (m, k) => t[k] || m);
  return v;
}
function computed(prop, path, at, t) {
  if (at < 0) return prop === 'color' ? '#000000' : 'transparent';
  const r = won(prop, path, at);
  if (!r || r.decls[prop] === 'inherit' || r.decls[prop] === 'currentColor') {
    return prop === 'color' ? computed(prop, path, at - 1, t) : (r ? computed('color', path, at, t) : 'transparent');
  }
  return resolve(r.decls[prop], t);
}
const rgb = (hex) => { const h = hex.replace('#', ''); const x = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)); };
const lum = (hex) => { const [r, g, b] = rgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
function green(hex) {
  const [r, g, b] = rgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return false;
  const s = d / (1 - Math.abs(2 * l - 1));
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  return hue >= 75 && hue <= 165 && s >= 0.2;
}

for (const dark of [true, false]) {
  const t = tokens(dark);
  const path = [{ tag: 'html', classes: dark ? ['dark'] : [] }, { tag: 'body', classes: [] },
                { tag: 'div', classes: ['cs-brow', 'on', 'open'] }, { tag: 'button', classes: ['cs-bhead'] },
                { tag: 'span', classes: ['cs-pickstate', 'ok'] }, { tag: 'span', classes: ['cs-live'] }];
  const pill = { ink: computed('color', path, 4, t), ground: computed('background', path, 4, t) };
  const live = computed('color', path, 5, t);
  const theme = dark ? 'dark' : 'light';
  assert.match(pill.ground, /^#[0-9a-f]{3,6}$/i, theme + ' pill ground ' + pill.ground);
  assert.equal(pill.ground.toLowerCase(), resolve('var(--cs-on)', t).toLowerCase(), theme + ': the pill is --cs-on');
  assert.equal(live.toLowerCase(), pill.ink.toLowerCase(), `${theme}: LIVE is drawn in the pill's own ink`);
  const ratio = contrast(live, pill.ground);
  assert.ok(ratio >= 4.5, `${theme}: LIVE ${live} on ${pill.ground} is ${ratio.toFixed(2)}:1`);
  assert.ok(!green(live) && !green(pill.ground), theme + ': no green');
  // outside a connected pill the word keeps its own weight and the page's ink
  const plain = [...path.slice(0, 3), { tag: 'button', classes: ['cs-bhead'] },
                 { tag: 'span', classes: ['cs-pickstate'] }, { tag: 'span', classes: ['cs-live'] }];
  plain[2] = { tag: 'div', classes: ['cs-brow'] };
  assert.equal(computed('color', plain, 5, t).toLowerCase(), resolve('var(--text)', t).toLowerCase(), theme);
  console.log(`${theme}: LIVE ${live} on ${pill.ground}, ${ratio.toFixed(1)}:1`);
}
console.log('test_pill_ink.mjs: ok');
