/* LSE Terminal dashboard: what runs inside one widget's frame.

   A widget is the user's own JavaScript. It runs here, in a sandboxed frame
   (sandbox="allow-scripts": no origin, so no engine route, no storage, no
   cookie and none of the terminal's page), and reaches data only by asking
   the terminal's page over postMessage. dash.js answers those asks from a
   fixed list of read-only data calls.

   The widget's code is the body of
       async function (lse, ui, el) { ... }
   - lse: the data calls (each returns a promise);
   - ui:  drawing helpers; each appends to the widget and returns its element;
   - el:  the widget's own element, for anything drawn by hand.

   A run draws into an element that is not on screen yet and is swapped in
   when the code finishes, so a refresh never shows a half-drawn widget.
   dash.js writes window.__LSE_BOOT ({code, theme}) ahead of this file. */
(function () {
  "use strict";
  var BOOT = window.__LSE_BOOT || { code: "", theme: {} };
  var T = BOOT.theme || {};
  var root = document.getElementById("root");
  var pending = new Map();
  var seq = 0;
  var shown = null;        // the element on screen
  var drawers = [];        // canvases of the element on screen: () => redraw
  var building = null;     // {el, drawers} of the run in progress
  var running = false, again = false;

  function post(msg) { msg.lse = 1; parent.postMessage(msg, "*"); }

  function call(method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      post({ call: id, method: method, args: args === undefined ? null : args });
    });
  }

  window.addEventListener("message", function (e) {
    if (e.source !== parent) return;
    var d = e.data;
    if (!d || d.lse !== 1) return;
    if (d.reply) {
      var p = pending.get(d.reply);
      if (!p) return;
      pending.delete(d.reply);
      if (d.ok) p.resolve(d.value); else p.reject(new Error(String(d.error || "the call failed")));
    } else if (d.run) {
      run();
    }
  });

  /* ── data ─────────────────────────────────────────────────────────── */
  var lse = {
    candles: function (o) { return call("candles", o); },
    prices: function (symbols) { return call("prices", symbols); },
    instruments: function (query, limit) { return call("instruments", { query: query, limit: limit }); },
    chart: function () { return call("chart"); },
    options: {
      underlyings: function () { return call("options.underlyings"); },
      chain: function (underlying, o) { return call("options.chain", Object.assign({ underlying: underlying }, o || {})); },
      flow: function (o) { return call("options.flow", o || {}); },
    },
    macro: {
      catalog: function (o) { return call("macro.catalog", o || {}); },
      series: function (symbol, o) { return call("macro.series", Object.assign({ symbol: symbol }, o || {})); },
    },
    calendar: function (o) { return call("calendar", o || {}); },
    screener: function () { return call("screener"); },
    news: function () { return call("news"); },
    mydata: {
      list: function () { return call("mydata.list"); },
      rows: function (name) { return call("mydata.rows", { name: name }); },
    },
  };

  /* ── formatting ───────────────────────────────────────────────────── */
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function fmtNum(v, decimals) {
    if (!isNum(v)) return v == null ? "–" : String(v);
    if (decimals != null) {
      return v.toLocaleString("en-GB", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    }
    // No decimals asked for: a large figure to two places, anything smaller
    // to six significant digits, so a price keeps the digits it is quoted
    // in (1.09756, 159.312, 0.00028) and a plain 3.7 stays 3.7.
    if (Math.abs(v) >= 1000) return v.toLocaleString("en-GB", { maximumFractionDigits: 2 });
    return v.toLocaleString("en-GB", { maximumSignificantDigits: 6 });
  }
  function fmtCompact(v) {
    if (!isNum(v)) return "–";
    var a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + "bn";
    if (a >= 1e6) return (v / 1e6).toFixed(2) + "m";
    if (a >= 1e4) return (v / 1e3).toFixed(1) + "k";
    return fmtNum(v);
  }
  // A time as milliseconds: epoch seconds, epoch milliseconds, a Date or a
  // date string. null when it is none of them.
  function toMs(t) {
    if (t instanceof Date) return t.getTime();
    if (isNum(t)) return t < 1e11 ? t * 1000 : t;
    if (typeof t === "string" && t) { var ms = Date.parse(t); return isFinite(ms) ? ms : null; }
    return null;
  }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtTime(ms, spanMs) {
    var d = new Date(ms);
    if (spanMs > 2 * 365 * 864e5) return MON[d.getUTCMonth()] + " " + d.getUTCFullYear();
    if (spanMs > 3 * 864e5) return d.getUTCDate() + " " + MON[d.getUTCMonth()];
    return pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
  }
  function fmtStamp(ms) {
    var d = new Date(ms);
    return d.getUTCDate() + " " + MON[d.getUTCMonth()] + " " + d.getUTCFullYear() + " " +
      pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + " UTC";
  }
  function tone(name) { return name === "up" ? T.up : name === "down" ? T.down : null; }

  /* ── drawing ──────────────────────────────────────────────────────── */
  function make(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  var sink = null;         // where helpers append while a ui.row fills
  function out() { return sink || (building ? building.el : (shown || root)); }
  function add(node) { out().appendChild(node); return node; }
  function onDraw(fn) { (building ? building.drawers : drawers).push(fn); }

  // A canvas that fills its box at the screen's pixel density; draw(ctx, w, h)
  // is called when the widget is shown and whenever its size changes.
  function canvasBox(cls, draw) {
    var box = make("div", cls);
    var cv = make("canvas");
    box.appendChild(cv);
    var paint = function () {
      var w = box.clientWidth, h = box.clientHeight;
      if (w < 10 || h < 10) return;
      var r = window.devicePixelRatio || 1;
      cv.width = Math.round(w * r); cv.height = Math.round(h * r);
      cv.style.width = w + "px"; cv.style.height = h + "px";
      var ctx = cv.getContext("2d");
      ctx.setTransform(r, 0, 0, r, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.font = "12px " + (T.font || "sans-serif");
      ctx.textBaseline = "middle";
      draw(ctx, w, h, cv);
    };
    onDraw(paint);
    box.__paint = paint;
    return box;
  }

  function niceStep(span, target) {
    var raw = span / Math.max(1, target);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var n = raw / mag;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  }

  // Points in every accepted spelling: [t, v] pairs, {t, v} (or time/date,
  // value/close), or bare numbers (then x is the position).
  function points(data) {
    var pts = [];
    (data || []).forEach(function (p, i) {
      var t = null, v = null;
      if (isNum(p)) { t = i; v = p; }
      else if (Array.isArray(p)) { t = p[0]; v = p.length > 2 ? p[4] != null ? p[4] : p[1] : p[1]; }
      else if (p && typeof p === "object") {
        t = p.t != null ? p.t : p.time != null ? p.time : p.date != null ? p.date : p.ts != null ? p.ts : i;
        v = p.v != null ? p.v : p.value != null ? p.value : p.close != null ? p.close : p.price;
      }
      v = typeof v === "string" ? Number(v) : v;
      if (isNum(v)) pts.push({ t: t, v: v });
    });
    return pts;
  }

  var ui = {
    theme: T,
    format: fmtNum,
    compact: fmtCompact,

    /* A line of words. opts.dim / opts.small. */
    text: function (words, opts) {
      opts = opts || {};
      return add(make("div", "w-text" + (opts.dim ? " dim" : "") + (opts.small ? " small" : ""), words));
    },

    /* One figure with its label: ui.number(0.94, {label, sub, decimals,
       prefix, suffix, tone: "up" | "down"}). */
    number: function (value, opts) {
      opts = opts || {};
      var box = make("div", "w-num");
      if (opts.label) box.appendChild(make("div", "w-num-label", opts.label));
      var v = make("div", "w-num-value",
        (opts.prefix || "") + fmtNum(value, opts.decimals) + (opts.suffix || ""));
      var c = tone(opts.tone);
      if (c) v.style.color = c;
      box.appendChild(v);
      if (opts.sub) box.appendChild(make("div", "w-num-sub", opts.sub));
      return add(box);
    },

    /* Several things side by side: ui.row(() => { ui.number(...); ui.number(...); }). */
    row: function (fill) {
      var box = make("div", "w-row");
      var before = sink;
      sink = box;
      try { fill(); } finally { sink = before; }
      return add(box);
    },

    /* A table: rows are objects (or arrays). opts.columns is a list of keys
       or of {key, label, align, decimals, format, tone}; tone(value, row)
       returns "up" or "down" to colour a cell. opts.limit caps the rows. */
    table: function (rows, opts) {
      opts = opts || {};
      rows = Array.isArray(rows) ? rows : [];
      var cols = opts.columns;
      if (!cols) {
        var first = rows[0];
        cols = Array.isArray(first) ? first.map(function (_, i) { return i; })
          : first && typeof first === "object" ? Object.keys(first) : [];
      }
      cols = cols.map(function (c) {
        return (c && typeof c === "object") ? c : { key: c, label: String(c) };
      });
      var wrap = make("div", "w-table");
      var table = make("table");
      var head = make("tr");
      var numeric = cols.map(function (c) {
        return rows.length > 0 && rows.slice(0, 20).every(function (r) {
          var v = r == null ? null : r[c.key];
          return v == null || isNum(v);
        });
      });
      cols.forEach(function (c, i) {
        var th = make("th", null, c.label != null ? c.label : c.key);
        if ((c.align || (numeric[i] ? "right" : "left")) === "right") th.className = "r";
        head.appendChild(th);
      });
      var thead = make("thead"); thead.appendChild(head); table.appendChild(thead);
      var body = make("tbody");
      var shownRows = opts.limit ? rows.slice(0, opts.limit) : rows.slice(0, 500);
      shownRows.forEach(function (r) {
        var tr = make("tr");
        cols.forEach(function (c, i) {
          var v = r == null ? null : r[c.key];
          var text = c.format ? c.format(v, r) : isNum(v) ? fmtNum(v, c.decimals) : v == null ? "–" : String(v);
          var td = make("td", null, text);
          if ((c.align || (numeric[i] ? "right" : "left")) === "right") td.className = "r";
          var col = c.tone ? tone(c.tone(v, r)) : null;
          if (col) td.style.color = col;
          tr.appendChild(td);
        });
        body.appendChild(tr);
      });
      table.appendChild(body);
      wrap.appendChild(table);
      if (!rows.length) wrap.appendChild(make("div", "w-empty", opts.empty || "No rows"));
      return add(wrap);
    },

    /* A line chart. data is one series (points as [t, v], {t, v}, candle
       rows, or bare numbers) or several: [{name, data, color}]. opts:
       {height, decimals, area, min, max, label}. Times are read as UTC. */
    line: function (data, opts) {
      opts = opts || {};
      var series = (Array.isArray(data) && data.length && data[0] && !Array.isArray(data[0]) &&
        typeof data[0] === "object" && Array.isArray(data[0].data))
        ? data.map(function (s) { return { name: s.name || "", color: s.color, pts: points(s.data) }; })
        : [{ name: opts.label || "", color: opts.color, pts: points(data) }];
      series = series.filter(function (s) { return s.pts.length; });
      var timed = series.length > 0 && series.every(function (s) {
        return s.pts.every(function (p) { return toMs(p.t) !== null && (!isNum(p.t) || p.t > 1e8); });
      });
      series.forEach(function (s) {
        s.pts.forEach(function (p, i) { p.x = timed ? toMs(p.t) : isNum(p.t) ? p.t : i; });
        s.pts.sort(function (a, b) { return a.x - b.x; });
      });
      var palette = [T.text, T.dim, T.up, T.down];
      var hover = null;
      var box = canvasBox("w-chart", function (ctx, w, h) {
        if (!series.length) {
          ctx.fillStyle = T.dim; ctx.textAlign = "center";
          ctx.fillText("No data", w / 2, h / 2); return;
        }
        var xs = [], ys = [];
        series.forEach(function (s) { s.pts.forEach(function (p) { xs.push(p.x); ys.push(p.v); }); });
        var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
        var y0 = opts.min != null ? opts.min : Math.min.apply(null, ys);
        var y1 = opts.max != null ? opts.max : Math.max.apply(null, ys);
        if (y0 === y1) { y0 -= Math.abs(y0) * 0.01 || 1; y1 += Math.abs(y1) * 0.01 || 1; }
        var padY = (y1 - y0) * 0.06;
        if (opts.min == null) y0 -= padY;
        if (opts.max == null) y1 += padY;
        if (x0 === x1) { x0 -= 1; x1 += 1; }
        var step = niceStep(y1 - y0, Math.max(2, Math.floor(h / 46)));
        var ticks = [];
        for (var v = Math.ceil(y0 / step) * step; v <= y1 + step * 1e-9; v += step) ticks.push(v);
        var dec = opts.decimals != null ? opts.decimals : Math.max(0, Math.min(6, -Math.floor(Math.log10(step))));
        var labelW = 0;
        ticks.forEach(function (tv) { labelW = Math.max(labelW, ctx.measureText(fmtNum(tv, dec)).width); });
        var L = 6, R = Math.ceil(labelW) + 12, Tp = series.length > 1 || hover ? 22 : 8, B = 22;
        var pw = Math.max(10, w - L - R), ph = Math.max(10, h - Tp - B);
        var X = function (x) { return L + (x - x0) / (x1 - x0) * pw; };
        var Y = function (y) { return Tp + (1 - (y - y0) / (y1 - y0)) * ph; };
        // grid and the scale on the right, as the terminal's own charts have it
        ctx.strokeStyle = T.edge; ctx.lineWidth = 1; ctx.fillStyle = T.dim; ctx.textAlign = "left";
        ticks.forEach(function (tv) {
          var y = Math.round(Y(tv)) + 0.5;
          ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke();
          ctx.fillText(fmtNum(tv, dec), L + pw + 8, y);
        });
        // time (or position) labels
        var n = Math.max(2, Math.min(6, Math.floor(pw / 96)));
        ctx.textAlign = "center";
        for (var i = 0; i <= n; i++) {
          var xv = x0 + (x1 - x0) * i / n;
          var lab = timed ? fmtTime(xv, x1 - x0) : fmtNum(xv, 0);
          var px = Math.min(L + pw - 24, Math.max(L + 24, X(xv)));
          ctx.fillText(lab, px, Tp + ph + 12);
        }
        series.forEach(function (s, si) {
          var col = s.color || palette[si % palette.length];
          ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.lineJoin = "round";
          // the second line is dashed: in ink on ink, colour alone does not
          // tell two lines apart
          ctx.setLineDash(si === 1 && !s.color ? [5, 4] : []);
          ctx.beginPath();
          s.pts.forEach(function (p, i) { if (i) ctx.lineTo(X(p.x), Y(p.v)); else ctx.moveTo(X(p.x), Y(p.v)); });
          ctx.stroke();
          ctx.setLineDash([]);
          if (opts.area && series.length === 1) {
            ctx.lineTo(X(s.pts[s.pts.length - 1].x), Tp + ph); ctx.lineTo(X(s.pts[0].x), Tp + ph); ctx.closePath();
            ctx.globalAlpha = 0.08; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
          }
        });
        // names of several series, or the value under the pointer
        ctx.textAlign = "left";
        if (hover !== null) {
          var hx = x0 + (Math.min(Math.max(hover, L), L + pw) - L) / pw * (x1 - x0);
          var parts = [];
          series.forEach(function (s, si) {
            var best = s.pts[0];
            s.pts.forEach(function (p) { if (Math.abs(p.x - hx) < Math.abs(best.x - hx)) best = p; });
            parts.push({ s: s, p: best, col: s.color || palette[si % palette.length] });
          });
          var gx = Math.round(X(parts[0].p.x)) + 0.5;
          ctx.strokeStyle = T.dim; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(gx, Tp); ctx.lineTo(gx, Tp + ph); ctx.stroke(); ctx.setLineDash([]);
          var tx = L;
          var stamp = timed ? fmtStamp(parts[0].p.x) : "";
          if (stamp) { ctx.fillStyle = T.dim; ctx.fillText(stamp, tx, 11); tx += ctx.measureText(stamp).width + 12; }
          parts.forEach(function (q) {
            var words = (q.s.name ? q.s.name + " " : "") + fmtNum(q.p.v, opts.decimals);
            ctx.fillStyle = q.col; ctx.fillText(words, tx, 11); tx += ctx.measureText(words).width + 12;
            ctx.beginPath(); ctx.arc(X(q.p.x), Y(q.p.v), 3, 0, Math.PI * 2); ctx.fill();
          });
        } else if (series.length > 1) {
          var lx = L;
          series.forEach(function (s, si) {
            ctx.fillStyle = s.color || palette[si % palette.length];
            if (si === 1 && !s.color) { ctx.fillRect(lx, 8, 4, 2); ctx.fillRect(lx + 6, 8, 4, 2); }
            else ctx.fillRect(lx, 8, 10, 2);
            lx += 14;
            ctx.fillText(s.name || ("Series " + (si + 1)), lx, 10);
            lx += ctx.measureText(s.name || ("Series " + (si + 1))).width + 14;
          });
        }
      });
      if (opts.height) { box.style.flex = "none"; box.style.height = opts.height + "px"; }
      box.addEventListener("mousemove", function (e) {
        hover = e.clientX - box.getBoundingClientRect().left; box.__paint();
      });
      box.addEventListener("mouseleave", function () { hover = null; box.__paint(); });
      return add(box);
    },

    /* Bars: items are {label, value, tone} or [label, value]. Upright by
       default; opts.horizontal lists them as rows with the value at the
       right. opts: {decimals, compact, height}. */
    bars: function (items, opts) {
      opts = opts || {};
      var rows = (items || []).map(function (it) {
        return Array.isArray(it) ? { label: String(it[0]), value: Number(it[1]) }
          : { label: String(it.label), value: Number(it.value), tone: it.tone };
      }).filter(function (r) { return isNum(r.value); });
      var show = function (v) { return opts.compact ? fmtCompact(v) : fmtNum(v, opts.decimals); };
      var top = rows.reduce(function (m, r) { return Math.max(m, Math.abs(r.value)); }, 0) || 1;
      if (opts.horizontal) {
        var list = make("div", "w-hbars");
        rows.forEach(function (r) {
          var line = make("div", "w-hbar");
          line.appendChild(make("span", "w-hbar-label", r.label));
          var track = make("span", "w-hbar-track");
          var fill = make("span", "w-hbar-fill");
          fill.style.width = Math.max(1, Math.abs(r.value) / top * 100) + "%";
          fill.style.background = tone(r.tone) || T.text;
          track.appendChild(fill); line.appendChild(track);
          line.appendChild(make("span", "w-hbar-value", show(r.value)));
          list.appendChild(line);
        });
        if (!rows.length) list.appendChild(make("div", "w-empty", "No data"));
        return add(list);
      }
      var hover = -1;
      var box = canvasBox("w-chart", function (ctx, w, h) {
        if (!rows.length) {
          ctx.fillStyle = T.dim; ctx.textAlign = "center"; ctx.fillText("No data", w / 2, h / 2); return;
        }
        var lo = Math.min(0, Math.min.apply(null, rows.map(function (r) { return r.value; })));
        var hi = Math.max(0, Math.max.apply(null, rows.map(function (r) { return r.value; })));
        if (lo === hi) hi = lo + 1;
        if (hi > 0) hi += (hi - lo) * 0.06;
        if (lo < 0) lo -= (hi - lo) * 0.06;
        var step = niceStep(hi - lo, Math.max(2, Math.floor(h / 52)));
        var ticks = [];
        for (var tv = Math.ceil(lo / step) * step; tv <= hi + step * 1e-9; tv += step) ticks.push(tv);
        var dec = opts.decimals != null ? opts.decimals : Math.max(0, Math.min(6, -Math.floor(Math.log10(step))));
        var scale = function (v) { return opts.compact ? fmtCompact(v) : fmtNum(v, dec); };
        var labelW = 0;
        ticks.forEach(function (v) { labelW = Math.max(labelW, ctx.measureText(scale(v)).width); });
        var L = 6, R = Math.ceil(labelW) + 12, Tp = 22, B = 22;
        var pw = w - L - R, ph = h - Tp - B;
        var slot = pw / rows.length, bw = Math.max(1, Math.min(46, slot * 0.72));
        box.__plotW = pw;
        var Y = function (v) { return Tp + (1 - (v - lo) / (hi - lo)) * ph; };
        var zero = Math.round(Y(0)) + 0.5;
        // the scale on the right, as the line chart has it
        ctx.strokeStyle = T.edge; ctx.lineWidth = 1; ctx.fillStyle = T.dim; ctx.textAlign = "left";
        ticks.forEach(function (v) {
          var y = Math.round(Y(v)) + 0.5;
          ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke();
          ctx.fillText(scale(v), L + pw + 8, y);
        });
        var every = Math.max(1, Math.ceil(rows.length / Math.max(1, Math.floor(pw / 64))));
        rows.forEach(function (r, i) {
          var cx = L + slot * (i + 0.5);
          var y = Y(r.value);
          ctx.fillStyle = tone(r.tone) || T.text;
          ctx.globalAlpha = hover === -1 || hover === i ? 1 : 0.45;
          ctx.fillRect(Math.round(cx - bw / 2), Math.min(y, zero), Math.round(bw), Math.max(1, Math.abs(zero - y)));
          ctx.globalAlpha = 1;
          if (i % every === 0) {
            ctx.fillStyle = T.dim; ctx.textAlign = "center";
            ctx.fillText(r.label.length > 10 ? r.label.slice(0, 9) + "…" : r.label, cx, Tp + ph + 12);
          }
        });
        ctx.textAlign = "left"; ctx.fillStyle = T.text;
        if (hover >= 0 && rows[hover]) ctx.fillText(rows[hover].label + "  " + show(rows[hover].value), L, 11);
      });
      if (opts.height) { box.style.flex = "none"; box.style.height = opts.height + "px"; }
      box.addEventListener("mousemove", function (e) {
        var x = e.clientX - box.getBoundingClientRect().left - 6;
        var i = Math.floor(x / (Math.max(1, box.__plotW || box.clientWidth - 12) / Math.max(1, rows.length)));
        hover = i >= 0 && i < rows.length ? i : -1; box.__paint();
      });
      box.addEventListener("mouseleave", function () { hover = -1; box.__paint(); });
      return add(box);
    },

    /* The parts of a whole on one bar: ui.share([{label, value, tone}]). */
    share: function (parts, opts) {
      opts = opts || {};
      var rows = (parts || []).filter(function (p) { return p && isNum(Number(p.value)) && Number(p.value) > 0; });
      var total = rows.reduce(function (s, p) { return s + Number(p.value); }, 0) || 1;
      var box = make("div", "w-share");
      var bar = make("div", "w-share-bar");
      var key = make("div", "w-share-key");
      var inks = [T.text, T.dim];
      rows.forEach(function (p, i) {
        var seg = make("span");
        seg.style.width = (Number(p.value) / total * 100) + "%";
        seg.style.background = tone(p.tone) || inks[i % inks.length];
        bar.appendChild(seg);
        var item = make("span", "w-share-item");
        var dot = make("i"); dot.style.background = seg.style.background;
        item.appendChild(dot);
        item.appendChild(document.createTextNode(p.label + " " + (Number(p.value) / total * 100).toFixed(1) + "%" +
          (opts.values === false ? "" : " · " + (opts.compact === false ? fmtNum(Number(p.value)) : fmtCompact(Number(p.value))))));
        key.appendChild(item);
      });
      box.appendChild(bar); box.appendChild(key);
      return add(box);
    },

    /* A canvas to draw on by hand: ui.canvas((ctx, width, height) => { ... }). */
    canvas: function (draw, opts) {
      var box = canvasBox("w-chart", function (ctx, w, h) { draw(ctx, w, h); });
      if (opts && opts.height) { box.style.flex = "none"; box.style.height = opts.height + "px"; }
      return add(box);
    },
  };

  /* ── a run ────────────────────────────────────────────────────────── */
  function show(el, list) {
    if (shown && shown.parentNode === root) root.removeChild(shown);
    while (root.firstChild) root.removeChild(root.firstChild);
    root.appendChild(el);
    shown = el; drawers = list;
    drawers.forEach(function (d) { try { d(); } catch (e) { /* one canvas */ } });
  }

  function fail(err) {
    var box = make("div", "w-out");
    box.appendChild(make("div", "w-err-title", "This widget stopped"));
    var msg = err && err.message ? err.message : String(err);
    box.appendChild(make("pre", "w-err", msg));
    show(box, []);
    post({ status: "error", message: msg.slice(0, 600) });
  }

  var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  var compiled = null, compileError = null;
  try { compiled = new AsyncFunction("lse", "ui", "el", BOOT.code || ""); }
  catch (e) { compileError = e; }

  async function run() {
    if (running) { again = true; return; }
    running = true;
    post({ status: "running" });
    var mine = { el: make("div", "w-out"), drawers: [] };
    try {
      if (compileError) throw compileError;
      building = mine;
      // `building` is this run's until its code finishes; a helper called
      // after an await still lands in it because runs never overlap.
      await compiled(lse, ui, mine.el);
      building = null;
      if (!mine.el.firstChild) mine.el.appendChild(make("div", "w-empty", "Nothing drawn yet. Call ui.number, ui.line, ui.bars or ui.table, or draw into el."));
      show(mine.el, mine.drawers);
      post({ status: "ok" });
    } catch (e) {
      building = null;
      fail(e);
    } finally {
      running = false;
      if (again) { again = false; run(); }
    }
  }

  var resizeT = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeT);
    resizeT = setTimeout(function () { drawers.forEach(function (d) { try { d(); } catch (e) {} }); }, 60);
  });
  window.addEventListener("error", function (e) { post({ status: "error", message: String(e.message || e).slice(0, 600) }); });
  window.addEventListener("unhandledrejection", function (e) {
    post({ status: "error", message: String((e.reason && e.reason.message) || e.reason).slice(0, 600) });
  });

  root.appendChild(make("div", "w-empty", "Loading…"));
  post({ status: "ready" });
  run();
})();
