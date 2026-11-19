// ============================================================================
// mount.tsx - bridge between the terminal shell and the chart engine.
//
// The terminal's shell (ui/static/app.js) is plain JavaScript and owns the
// MARKETS / BACKTEST / MY DATA sections, the sidebar and the keybar. This entry
// point exposes an imperative API on `window.LSEChart` so the shell can mount
// the React chart into its existing #chart element and push symbol, timeframe,
// candle and trade-marker changes at it, without the shell needing React.
//
// Composition note: upstream, ProChart is wrapped by a live-streaming container
// that merges websocket ticks into the last candle and talks to broker
// runtimes. The terminal has no live feed, so that layer is deliberately not
// included. What IS reproduced exactly is the interaction wiring between the
// canvas and the drawing overlay - the converter handshake, the redraw ref, the
// scroll-offset ref and the cursor-badge ref - because that wiring is what
// makes panning, zooming, the crosshair and drawing placement behave the way
// they do on the live charts.
//
// All user state (drawings, indicator setups, layouts, tool favourites) is
// persisted to ~/.config/lse-terminal/workspace.json through lib/api, so a
// downloaded terminal keeps the user's work across cache clears and reinstalls.
// ============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ProChart from '@/components/chart/ProChart';
import { ChartDrawingOverlay, type Drawing, type DrawingTool } from '@/components/chart/ChartDrawingOverlay';
import DrawingToolsPanel from '@/components/chart/sidebar/DrawingToolsPanel';
import { DEFAULT_INDICATOR_CONFIG, type IndicatorConfig } from '@/components/chart/IndicatorSettings';
import { getDefaultColors, type Candle, type ChartType } from '@/components/chart/core/types';
import { MemoryRouter } from 'react-router-dom';
import { ChartSettingsProvider, useChartSettings, useHasSavedAppearance } from '@/contexts/ChartSettingsContext';
import { AppearancePanel, ChartSettingsPanel } from '@/components/chart/InlineChartSettings';
import MultiTimeframeLayoutSelector from '@/components/chart/MultiTimeframeLayoutSelector';
import TerminalMultiGrid from '@/components/chart/TerminalMultiGrid';
import { layoutStore, useLayoutState } from '@/lib/layoutStore';
import { setEngineContext } from '@/lib/localEngine';
import { isMarketOpenForPair } from '@/lib/marketHours';
import { initWorkspaceBridge } from '@/lib/workspaceBridge';
import { api, invalidateSection } from '@/lib/api';
import { toCustomIndicators, type EngineIndicatorPayload } from '@/lib/engineIndicators';
import { setPriceDigits, orderFormPrice } from '@/lib/utils';
import './index.css';

// Converter handed up by ProChart once it has laid out its axes. The overlay
// needs it to place drawings in price/time space, so it is held in state (not a
// ref): the overlay must re-render when it first arrives or the drawings would
// sit at stale pixel positions until the next unrelated render.
type Converter = {
  timeToX: (time: number) => number | null;
  xToTime: (x: number) => number | null;
  priceToY: (price: number) => number;
  yToPrice: (y: number) => number;
  priceAxisWidth: number;
};

// A backtest fill, pushed in by the shell after a run so trades render on the
// pro engine the same way they do on the classic view.
export interface TradeMarker {
  time: number;
  price: number;
  side: 'buy' | 'sell';
  quantity?: number;
  pnl?: number;
}

export interface ChartProps {
  provider: string;
  symbol: string;
  timeframe: string;
  candles: Candle[];
  chartType?: ChartType;
  trades?: TradeMarker[];
  // Indicators computed by the local engine in Python (built-ins and the
  // user's own), already evaluated and returned with the candles.
  engineIndicators?: EngineIndicatorPayload;
  // Live quote for the mounted symbol; drawn as MT5-style bid/ask lines.
  // `synthetic` marks quotes the provider inferred locally for feeds that
  // stream trade prints only (see lse_terminal/providers/spread.py).
  quote?: { bid: number; ask: number; synthetic?: boolean } | null;
  // Live sim positions for the mounted symbol, drawn as the engine's
  // interactive order lines: click selects, SL/TP handles drag, the line's
  // × closes. Distinct from `trades` (static backtest fills) so a backtest
  // replay and a live position can coexist without id collisions.
  positions?: Array<{ id: string; price: number; side: 'buy' | 'sell';
    quantity: number; pnl?: number; stopLoss?: number; takeProfit?: number }>;
  onPositionModify?: (id: string, sl?: number, tp?: number) => void;
  onPositionClose?: (id: string) => void;
  autoSelectPositionId?: string | null;
  // The decimals a source declares for its instruments, by symbol (a
  // broker's catalog), and the source they are (`priceSource`; else the
  // `provider` pushed with them). Handed to the price formatter
  // (setPriceDigits), never kept as props: the whole map, each time that
  // source's change.
  priceDigits?: Record<string, number> | null;
  priceSource?: string | null;
}

interface TerminalChartProps extends ChartProps {
  // Imperative indicator overrides from the shell; merged over whatever was
  // loaded for this instrument.
  indicatorPatch?: Record<string, any> | null;
}

const TF_MS: Record<string, number> = {
  '1s': 1000, '5s': 5000, '10s': 10000, '30s': 30000,
  '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000,
  '1h': 3600000, '4h': 14400000, '1d': 86400000,
  '1w': 604800000, '1M': 2592000000,
};

// One row in a context menu. Hover is a JS handler rather than a CSS class
// because these rows are inline-styled from the shell's vars (Tailwind's
// hover:bg-muted resolves to the component palette, not the terminal's), and
// the two chart menus must not drift apart again.
const ctxRow: React.CSSProperties = {
  display: 'block', width: '100%', padding: '3px 10px',
  background: 'transparent', border: 'none', cursor: 'pointer',
  font: 'inherit', color: 'inherit', lineHeight: 1.5, textAlign: 'left',
};
const onCtxRowIn = (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.background = 'var(--hover)'; };
const onCtxRowOut = (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.background = 'transparent'; };
// Two symbols are the one instrument when their letters and digits match, so a
// chart spelt one way (a source's) and the ticket's instrument spelt another
// (its broker's) are compared without their separators or case. The menu's
// order rows show only when the chart shows the instrument the order goes to.
const bareMatch = (a?: string | null, b?: string | null): boolean =>
  !!b && String(a).replace(/[^A-Z0-9]/gi, '').toUpperCase() === String(b).replace(/[^A-Z0-9]/gi, '').toUpperCase();

function TerminalChart({ provider, symbol, timeframe, candles, chartType = 'candlestick', trades = [], engineIndicators, indicatorPatch = null, quote = null, positions = [], onPositionModify, onPositionClose, autoSelectPositionId = null }: TerminalChartProps) {
  const [converter, setConverter] = useState<Converter | null>(null);
  const [activeTool, setActiveTool] = useState<DrawingTool>(null);
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [indicators, setIndicators] = useState<IndicatorConfig>(DEFAULT_INDICATOR_CONFIG);
  const [drawingsLocked, setDrawingsLocked] = useState(false);
  const [drawingsHidden, setDrawingsHidden] = useState(false);
  // Indicator management lives in the shell (Python registry browser +
  // editor); the chart's settings affordances just ask the shell to open it.
  const openIndicatorBrowser = useCallback(() => {
    window.dispatchEvent(new CustomEvent('lset:open-indicators'));
  }, []);

  // Right-click context menu (site parity: template / reset / flip /
  // settings). Flip is the site's exact trick: scaleY(-1) on the chart
  // container. Reset reuses ProChart's own bottom-toolbar button through the
  // DOM, so the chart's own file stays untouched.
  // price/ref/trade are snapshotted AT the click: price is the level under
  // the cursor, ref the live price it is compared against, trade the shell's
  // tradeInfo. Rendering from live values instead would let a tick crossing
  // the clicked level flip "Buy Limit" into "Buy Stop" while the user's
  // pointer is on the row.
  const [ctxMenu, setCtxMenu] = useState<{
    x: number; y: number; price: number | null; ref: number | null;
    trade: { available: boolean; symbol?: string; instrument?: string;
             digits?: number | null; tick?: number | null; qty?: number | null;
             pendingTypes?: string[] } | null;
  } | null>(null);
  const [tplOpen, setTplOpen] = useState(false);
  // Template save/delete state: tplSaving shows the inline name input
  // (window.prompt does not exist in the desktop shell), tplPendingDelete
  // arms a row's x so deletion is a deliberate second click, tplTick
  // re-renders after the shell's async save/delete lands so the submenu
  // reflects the store without closing.
  const [tplSaving, setTplSaving] = useState(false);
  const [tplName, setTplName] = useState('');
  const [tplPendingDelete, setTplPendingDelete] = useState<string | null>(null);
  const [tplErr, setTplErr] = useState('');
  const [, setTplTick] = useState(0);
  // Pending-order form: clicking "Buy Limit @ x" opens a two-field step
  // (price and size, both prefilled and editable) instead of firing at the
  // ticket's size, so the trader can type in the lot size themselves.
  // Market rows stay one-click; their size is in the label.
  const [ordForm, setOrdForm] = useState<{ side: string; otype: string } | null>(null);
  const [ordPrice, setOrdPrice] = useState('');
  const [ordQty, setOrdQty] = useState('');
  const [ordErr, setOrdErr] = useState('');
  const [flipped, setFlipped] = useState(false);
  const chartAreaRef = useRef<HTMLDivElement | null>(null);
  // The one commit path for the save row, shared by the Save button and the
  // Enter key so the two can never drift. A refused save keeps the input
  // open and says why: silently swallowing it is what made the feature look
  // like it had no save at all.
  const saveTemplate = async () => {
    const name = tplName.trim();
    if (!name) { setTplErr('name the template first'); return; }
    const ok = await (window as any).__lseShell?.saveLayout?.(name);
    if (ok) { setTplSaving(false); setTplErr(''); setTplTick((t) => t + 1); }
    else setTplErr('could not save this template');
  };
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => {
      setCtxMenu(null); setTplOpen(false);
      setTplSaving(false); setTplPendingDelete(null); setTplErr('');
      setOrdForm(null); setOrdErr('');
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

  // The appearance/settings dialog (colours, wicks, background, crosshair,
  // axis). The panels are the site's own InlineChartSettings panels; edits go
  // through ChartSettingsContext, which persists to the workspace file and
  // repaints ProChart live. Opened imperatively by the shell's gear button.
  // Screen-layout state lives in the shared layoutStore module (the shell's
  // top-bar Layout button drives it from its own React root).
  const layoutState = useLayoutState();
  const layout = layoutState.layout;
  const syncSettings = layoutState.sync;

  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [appearanceView, setAppearanceView] = useState<'appearance' | 'chart'>('appearance');
  // Refs mirror the state so the imperative opener (registered once) never
  // reads a stale closure.
  const appearanceOpenRef = useRef(appearanceOpen);
  appearanceOpenRef.current = appearanceOpen;
  const appearanceViewRef = useRef(appearanceView);
  appearanceViewRef.current = appearanceView;
  useEffect(() => {
    // TOGGLE, not open: the shell's buttons must also dismiss the panel on a
    // second click; open-only felt stuck. With two toolbar doors (Chart
    // layout -> chart tab, Appearance -> colours tab), a click for the tab
    // NOT currently shown switches tabs in place instead of closing.
    openAppearanceFn = (view?: 'appearance' | 'chart') => {
      if (!appearanceOpenRef.current) {
        setAppearanceView(view || 'appearance');
        setAppearanceOpen(true);
        return;
      }
      if (view && view !== appearanceViewRef.current) {
        setAppearanceView(view);
        return;
      }
      setAppearanceOpen(false);
    };
    return () => { openAppearanceFn = null; };
  }, []);
  // Escape dismisses the panel like every other popover in the terminal.
  useEffect(() => {
    if (!appearanceOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAppearanceOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [appearanceOpen]);
  // Drag-to-move: the title strip is the handle. Position is kept in state
  // (null = default top-right anchor) and clamped to the chart area so the
  // panel can't be lost off-screen; it resets to the anchor on reopen.
  const appearanceRef = useRef<HTMLDivElement | null>(null);
  const [appearancePos, setAppearancePos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => { if (!appearanceOpen) setAppearancePos(null); }, [appearanceOpen]);
  const onAppearanceDrag = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const panel = appearanceRef.current;
    // left/top are relative to the panel's positioned ancestor (the mount
    // root, which also holds the tool rail), so clamp against that same box.
    const host = panel?.offsetParent as HTMLElement | null;
    if (!host || !panel) return;
    const hr = host.getBoundingClientRect();
    const pr = panel.getBoundingClientRect();
    const grabX = e.clientX - pr.left, grabY = e.clientY - pr.top;
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      setAppearancePos({
        x: Math.max(0, Math.min(ev.clientX - hr.left - grabX, hr.width - pr.width)),
        y: Math.max(0, Math.min(ev.clientY - hr.top - grabY, hr.height - 36)),
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

  // Pre-placement defaults for new drawings. The engine's built-in
  // default is black, which is correct on the light web chart but almost
  // invisible on the terminal's dark canvas, so the default here is the
  // chart's own text colour. Persisted to the workspace file so a user's
  // preferred colour/width/style ships with their install.
  const [toolSettings, setToolSettings] = useState({
    color: '#e6e8ea',
    strokeWidth: 2,
    lineStyle: 'solid' as 'solid' | 'dashed' | 'dotted',
    opacity: 100,
  });

  useEffect(() => {
    let alive = true;
    (async () => {
      const saved = await api.getTools();
      if (alive && saved?.drawingDefaults) {
        setToolSettings((prev) => ({ ...prev, ...saved.drawingDefaults }));
      }
    })();
    return () => { alive = false; };
  }, []);

  // Ref wiring, mirroring the upstream contract:
  //  - requestRedrawRef : overlay -> canvas, forces a repaint in the same frame
  //                       so drawing-preview badges appear without a React render
  //  - scrollOffsetRef  : canvas -> overlay, CSS-transform sync while panning
  //  - drawingCursorRef : overlay -> canvas, live cursor price/time for axis badges
  //  - scrollSyncRef    : canvas -> overlay, called each scroll frame
  const requestRedrawRef = useRef<(() => void) | null>(null);
  const scrollOffsetRef = useRef<number>(0);
  const scrollSyncRef = useRef<() => void>(() => {});
  const drawingCursorRef = useRef<Array<{ price: number | null; time: number | null; x: number | null }>>([]);

  // Keep the data adapter pointed at whatever the shell is showing, so the
  // engine's fetch layer resolves history against the right instrument.
  useEffect(() => {
    setEngineContext({ provider, symbol });
  }, [provider, symbol]);

  // Drawings and indicator setups are stored per instrument: switching symbols
  // must not carry another instrument's trendlines across, and returning to a
  // symbol must restore exactly what was left there.
  const instrumentKey = `${provider}:${symbol}`;

  // Guards the initial load: without it the empty starting state would be
  // written back over the saved drawings before the load resolves.
  const loadedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadedKeyRef.current = null;
    (async () => {
      const [saved, savedIndicators] = await Promise.all([
        api.getDrawings(instrumentKey),
        api.getIndicators(instrumentKey),
      ]);
      if (!alive) return;
      setDrawings(saved as Drawing[]);
      setIndicators(savedIndicators ?? DEFAULT_INDICATOR_CONFIG);
      setSelectedDrawingId(null);
      loadedKeyRef.current = instrumentKey;
    })();
    return () => { alive = false; };
  }, [instrumentKey]);

  const handleDrawingsChange = useCallback((next: Drawing[]) => {
    setDrawings(next);
    // Fire-and-forget: persistence must never block the drawing interaction.
    if (loadedKeyRef.current === instrumentKey) {
      void api.setDrawings(instrumentKey, next);
    }
  }, [instrumentKey]);

  const handleIndicatorsChange = useCallback((next: IndicatorConfig) => {
    setIndicators(next);
    if (loadedKeyRef.current === instrumentKey) {
      void api.setIndicators(instrumentKey, next);
    }
  }, [instrumentKey]);

  useEffect(() => {
    if (!indicatorPatch) return;
    setIndicators((prev) => ({ ...prev, ...indicatorPatch } as IndicatorConfig));
  }, [indicatorPatch]);

  const clearAllDrawings = useCallback(() => {
    handleDrawingsChange([]);
    setSelectedDrawingId(null);
  }, [handleDrawingsChange]);

  const deleteDrawing = useCallback((id: string) => {
    handleDrawingsChange(drawings.filter((d) => d.id !== id));
    setSelectedDrawingId(null);
  }, [drawings, handleDrawingsChange]);

  // Python indicators from the engine ride in as precomputed customIndicators,
  // so they draw alongside the chart's own registry rather than in a separate
  // widget. Recomputed only when the candles or the payload change.
  const withEngineIndicators = useMemo(() => {
    const custom = toCustomIndicators(engineIndicators, candles);
    if (!custom.length) return indicators;
    return { ...indicators, customIndicators: custom } as IndicatorConfig;
  }, [indicators, engineIndicators, candles]);

  // Candle/background/grid colours come from the user's saved chart settings
  // (the Appearance panel edits them); without this the colors prop is static
  // and Appearance edits repaint nothing. Two regimes, switched by
  // hasSavedAppearance (NOT by comparing values to defaults; the old
  // value-equals-default heuristic silently ignored any setting matching the
  // site's light palette, which mangled a saved white-background/gray-grid
  // theme into dark-with-wrong-grid):
  //   - user has saved appearance: apply the saved settings VERBATIM.
  //   - fresh profile, nothing saved: the terminal's dark base.
  const chartSettings = useChartSettings();
  const hasSavedAppearance = useHasSavedAppearance();
  const colors = useMemo(() => {
    const base = getDefaultColors();
    const c = chartSettings?.candles;
    const ch = chartSettings?.chart;
    if (!hasSavedAppearance || !c || !ch) return { ...base };
    return {
      ...base,
      background: ch.backgroundColor,
      backgroundOpacity: ch.backgroundOpacity,
      grid: ch.gridColor,
      gridOpacity: ch.gridOpacity,
      axisLabel: ch.axisLabelColor,
      axisLine: ch.axisLineColor,
      crosshair: ch.crosshairColor,
      priceTickerBullish: ch.priceTickerBullish,
      priceTickerBearish: ch.priceTickerBearish,
      bullish: c.bodyBullish,
      bearish: c.bodyBearish,
      bullishBorder: c.bordersBullish,
      bearishBorder: c.bordersBearish,
      bullishWick: c.wickBullish,
      bearishWick: c.wickBearish,
    };
  }, [chartSettings, hasSavedAppearance]);
  // The settings panel's Timezone pick (data.timezone, default "local") must
  // be passed to ProChart explicitly: the prop's own default is 'UTC', so
  // omitting it pinned every axis/crosshair/badge time to raw UTC and made
  // the Timezone setting a silent no-op (AAPL bar times rendered shifted
  // by the UTC offset).
  const chartTimezone = chartSettings?.data?.timezone || 'local';
  const timeframeMs = TF_MS[timeframe] ?? 3600000;
  const livePrice = candles.length ? candles[candles.length - 1].close : null;

  // Bar-close countdown for the axis price badge: blank while the
  // instrument's market is closed, else the remaining time in compact
  // h:mm:ss form. The site's long "21:00 (16m 45s)" format only fits its
  // 110px axis because the RightToolbar gap pads it; with rightOffset=0 the
  // terminal's axis is sized to the price text alone, and ProChart draws the
  // countdown row unclipped, so a wider string would paint over the candles.
  const [countdown, setCountdown] = useState('');
  useEffect(() => {
    const tick = () => {
      // A tick chart has no bar interval, so there is no close to count
      // down to; without this guard the TF_MS fallback shows a bogus
      // 1-hour countdown on the price badge.
      if (timeframe === 'tick') { setCountdown(''); return; }
      if (!symbol || !isMarketOpenForPair(symbol)) { setCountdown(''); return; }
      const now = Date.now();
      const nextClose = Math.ceil(now / timeframeMs) * timeframeMs;
      const diff = Math.max(0, nextClose - now);
      const s = Math.floor(diff / 1000);
      const m = Math.floor(s / 60) % 60;
      const h = Math.floor(s / 3600);
      const two = (n: number) => String(n).padStart(2, '0');
      setCountdown(h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [symbol, timeframeMs, timeframe]);

  // How many indicators are switched on, for the tool rail's badge.
  const indicatorCount = useMemo(
    () => Object.values(indicators || {}).filter((v: any) => v && v.enabled).length,
    [indicators]
  );

  // Backtest fills are rendered through the chart's own position-line layer,
  // which is what draws entry markers on the live charts. Live sim positions
  // ride the same layer with their real ids so select/modify/close route back
  // to the right /api/sim position.
  const positionLines = useMemo(
    () => [
      ...trades.map((t, i) => ({
        id: `trade-${i}`,
        price: t.price,
        side: t.side,
        quantity: t.quantity ?? 0,
        symbol,
        pnl: t.pnl,
      })),
      ...positions.map((p) => ({ ...p, symbol })),
    ],
    [trades, positions, symbol]
  );

  // The shell initialises its symbol to null, and a JS default parameter only
  // fills `undefined` - an explicit null reaches the chart and throws inside
  // the symbol-classification helpers. Guard here rather than editing the
  // chart component, so it stays unmodified.
  if (!symbol) {
    return <div className="h-full w-full" />;
  }

  return (
    <div className="relative h-full w-full flex">
      {/* Tool rail: the chart's drawing-tools panel, so every one of the
          engine's 33 drawing tools is reachable exactly as on the live chart. */}
      {/* The rail wears the SHELL's chrome vars, not the chart palette: it
          must follow the terminal's light/dark class like every other panel. */}
      <div className="shrink-0 border-r border-[var(--edge)] bg-[var(--panel)] overflow-y-auto">
        <DrawingToolsPanel
          activeTool={activeTool}
          onToolSelect={setActiveTool}
          drawings={drawings}
          onClearAllDrawings={clearAllDrawings}
          selectedDrawingId={selectedDrawingId}
          onDeleteSelectedDrawing={deleteDrawing}
          drawingsLocked={drawingsLocked}
          onToggleLock={() => setDrawingsLocked((v) => !v)}
          drawingsHidden={drawingsHidden}
          onToggleHide={() => setDrawingsHidden((v) => !v)}
          indicatorCount={indicatorCount}
          onClearIndicators={() => handleIndicatorsChange(DEFAULT_INDICATOR_CONFIG)}
          onOpenSettings={openIndicatorBrowser}
        />
      </div>

      <div
        ref={chartAreaRef}
        className="relative flex-1 min-w-0"
        style={flipped ? { transform: 'scaleY(-1)' } : undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          setTplOpen(false);
          setOrdForm(null); setOrdErr('');
          // Price under the cursor, for the menu's trading rows. Only the
          // single-pane chart has a converter; the multi-grid keeps the menu
          // but without trading. The flipped chart is pure CSS scaleY(-1),
          // so the screen y is mirrored back before the converter sees it.
          let price: number | null = null;
          if (layout === '1x1' && converter && chartAreaRef.current) {
            const r = chartAreaRef.current.getBoundingClientRect();
            const y = flipped ? r.height - (e.clientY - r.top) : e.clientY - r.top;
            const p = converter.yToPrice(y);
            if (Number.isFinite(p) && p > 0) price = p;
          }
          const trade = (window as any).__lseShell?.tradeInfo?.() || null;
          setCtxMenu({
            x: Math.min(e.clientX, window.innerWidth - 240),
            // taller menu when the trading rows render; the clamp keeps the
            // whole thing on screen for clicks near the bottom edge
            y: Math.min(e.clientY, window.innerHeight
                 - (trade?.available && bareMatch(symbol, trade.instrument) ? 360 : 230)),
            price, ref: livePrice, trade,
          });
        }}
      >
        {layout !== '1x1' ? (
          <TerminalMultiGrid
            layout={layout}
            syncSettings={syncSettings}
            pair={symbol}
            timeframe={timeframe}
            colors={colors}
            quote={quote}
            priceSource={provider}
          />
        ) : (<>
        <ProChart
          candles={candles}
          symbol={symbol}
          priceSource={provider}
          timeframe={timeframe}
          chartType={chartType}
          livePrice={livePrice}
          countdown={countdown}
          timezone={chartTimezone}
          // The terminal has no RightToolbar icon strip overlaying the price
          // axis, so the site's 48px toolbar gap collapses to a 6px breathing
          // margin: 0 put the digits hard against the window edge, 48 was
          // ~50px of dead space.
          rightOffset={6}
          colors={colors}
          indicators={withEngineIndicators}
          onIndicatorsChange={handleIndicatorsChange}
          // Removing a Python/engine indicator is the SHELL's action, not the
          // chart's: withEngineIndicators rebuilds customIndicators from the
          // engine payload on every render, so anything the chart deleted
          // locally would reappear on the next paint. This drops it from the
          // shell's active list, exactly like its chip's ×.
          onRemoveEngineIndicator={(label) => (window as any).__lseShell?.removeIndicator?.(label)}
          // Same reason for editing: the chart holds only the precomputed
          // series, so "Settings..." reopens the shell's parameter editor,
          // exactly what clicking the indicator's chip does. editIndicator
          // returns false when no active indicator carries that label (a label
          // the chart derived from the payload no longer matching the shell's
          // list); fall back to the indicator browser rather than leave the
          // legend's gear looking dead, which is the failure the engine rows'
          // trash button already had once.
          onEditEngineIndicator={(label) => {
            if (!(window as any).__lseShell?.editIndicator?.(label)) openIndicatorBrowser();
          }}
          drawings={drawings}
          selectedDrawingId={selectedDrawingId}
          drawingCursorRef={drawingCursorRef}
          requestRedrawRef={requestRedrawRef}
          scrollOffsetRef={scrollOffsetRef}
          onScrollSync={() => scrollSyncRef.current?.()}
          onConverterReady={setConverter}
          onOpenSettings={openIndicatorBrowser}
          positionLines={positionLines}
          onPositionModify={onPositionModify}
          onPositionClose={onPositionClose}
          autoSelectPositionId={autoSelectPositionId}
          // Broker-convention quote lines: drawn only from a real live quote
          // (never the hardcoded fallback table; showBidAskSpread stays off
          // until the first quoted tick arrives, so the renderer's
          // getSpreadForSymbol branch is unreachable).
          showBidAskSpread={!!quote}
          brokerBid={quote?.bid ?? null}
          brokerAsk={quote?.ask ?? null}
        />
        <ChartDrawingOverlay
          activeTool={activeTool}
          onToolSelect={setActiveTool}
          drawings={drawings}
          onDrawingsChange={handleDrawingsChange}
          selectedDrawingId={selectedDrawingId}
          onSelectDrawing={setSelectedDrawingId}
          converter={converter}
          scrollSyncRef={scrollSyncRef}
          scrollOffsetRef={scrollOffsetRef}
          drawingCursorRef={drawingCursorRef}
          requestRedrawRef={requestRedrawRef}
          toolSettings={toolSettings}
          isLocked={drawingsLocked}
          isHidden={drawingsHidden}
          currentSymbol={symbol}
          timeframeMs={timeframeMs}
          currentPrice={livePrice ?? undefined}
          candles={candles}
        />
        </>)}
      </div>

      {/* The built-in indicator dialog is retired: the indicator library is
          Python, so the rail's indicator button opens the SHELL's browser
          (every registry indicator plus the user's own), via the
          lset:open-indicators event the shell listens for. */}

      {/* Chart colours & settings: floats over the chart's top-right, same
          panels the site serves from its layout button. */}
      {appearanceOpen && (
        <div
          ref={appearanceRef}
          className="absolute z-[95] w-80"
          // Opaque shell chrome by explicit vars (the tokens also resolve now,
          // but the panel over live candles must never depend on them again).
          style={{
            ...(appearancePos
              ? { left: appearancePos.x, top: appearancePos.y }
              : { top: 8, right: 8 }),
            background: 'var(--panel)',
            border: '1px solid var(--edge)',
            borderRadius: 3,
            boxShadow: '0 10px 32px var(--shadow)',
          }}>
          {/* Title strip = drag handle (grab anywhere that isn't the close
              button). Micro-label styling to match the shell's section heads. */}
          <div
            onPointerDown={onAppearanceDrag}
            className="flex items-center justify-between px-3 py-1.5 select-none"
            style={{ borderBottom: '1px solid var(--edge)', cursor: 'move' }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.1em', color: 'var(--dim)' }}>
              CHART LAYOUT
            </span>
            <button
              onClick={() => setAppearanceOpen(false)}
              aria-label="Close settings"
              className="text-muted-foreground hover:text-foreground"
              style={{ fontSize: 14, lineHeight: 1, padding: '0 2px' }}>
              ×
            </button>
          </div>
          <div className="flex items-center" style={{ borderBottom: '1px solid var(--edge)' }}>
            <button
              onClick={() => setAppearanceView('appearance')}
              className="flex-1 px-3 py-1.5 text-xs font-medium transition-colors"
              style={appearanceView === 'appearance'
                ? { color: 'var(--text)', background: 'var(--active)' }
                : { color: 'var(--dim)' }}>
              Appearance
            </button>
            <button
              onClick={() => setAppearanceView('chart')}
              className="flex-1 px-3 py-1.5 text-xs font-medium transition-colors"
              style={appearanceView === 'chart'
                ? { color: 'var(--text)', background: 'var(--active)' }
                : { color: 'var(--dim)' }}>
              Chart
            </button>
          </div>
          <div className="max-h-[70vh] overflow-y-auto">
            {appearanceView === 'appearance'
              ? <AppearancePanel hideHeader onBack={() => setAppearanceOpen(false)} />
              : <ChartSettingsPanel hideHeader onBack={() => setAppearanceOpen(false)} />}
          </div>
          {/* Done = the explicit exit. Every control above saves as it
              changes, so Done only closes; it exists because a panel whose
              only way out is the tiny x reads as unfinished business. */}
          <div
            className="flex justify-end px-3 py-2"
            style={{ borderTop: '1px solid var(--edge)' }}>
            <button
              onClick={() => setAppearanceOpen(false)}
              className="text-xs font-medium"
              style={{
                padding: '3px 16px', color: 'var(--text)',
                background: 'var(--active)', border: '1px solid var(--edge)',
                borderRadius: 2,
              }}>
              Done
            </button>
          </div>
        </div>
      )}

      {/* Right-click menu. Rendered OUTSIDE the flippable container so it
          never renders upside down. Templates come from the shell's LAYOUTS
          zone over the window bridge. */}
      {ctxMenu && (
        // Shell chrome by explicit vars, matching #conn-menu in style.css and
        // the indicator panel menu ProChart draws: same surface, hairline
        // border, 2px corners, 12px dense rows. The Tailwind popover tokens it
        // used before rendered a rounded, airy card that read as generic
        // dashboard chrome next to the rest of the terminal.
        <div
          className="fixed z-[110]"
          style={{
            // 190 not 170: the Chart template row puts a caret hard right, and
            // a tighter box collides it with the label.
            left: ctxMenu.x, top: ctxMenu.y, minWidth: 190,
            padding: '2px 0 6px',
            background: 'var(--panel)', border: '1px solid var(--edge)',
            borderRadius: 2, boxShadow: '0 6px 20px var(--shadow)',
            fontSize: 12, color: 'var(--text)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Trading rows (MT-style): market both ways, then the pending
              orders that are VALID at the clicked level: below the market a
              buy rests as a limit and a sell as a stop, above it the mirror.
              Offering all four and letting the broker refuse half is the MT4
              greyed-row pattern; showing only the two that can rest reads
              cleaner and cannot invite a guaranteed rejection. All values
              come from the click snapshot, the placement itself is the
              ticket's (qty box, broker routing, result message). */}
          {ctxMenu.trade?.available && bareMatch(symbol, ctxMenu.trade.instrument) && (() => {
            const t = ctxMenu.trade!;
            const fp = (p: number) =>
              (window as any).__lseShell?.fmtPrice?.(p) ?? String(p);
            const cap = (s: string) => s === 'limit' ? 'Limit' : 'Stop';
            // The two-field step for a pending order. Both values are
            // editable: the click picked a level by eye, and the size the
            // ticket happens to hold is not a decision the trader made here.
            if (ordForm) {
              const inp: React.CSSProperties = {
                flex: 1, minWidth: 0, padding: '3px 6px', fontSize: 12,
                color: 'var(--text)', background: 'var(--bg2)',
                border: '1px solid var(--edge)', borderRadius: 2,
              };
              const lab: React.CSSProperties = {
                width: 38, fontSize: 11, color: 'var(--dim)', flexShrink: 0,
              };
              const place = () => {
                const pv = parseFloat(ordPrice), qv = parseFloat(ordQty);
                if (!(pv > 0)) { setOrdErr('enter a price'); return; }
                if (!(qv > 0)) { setOrdErr('enter a size'); return; }
                (window as any).__lseShell?.quickOrder?.(ordForm.side, ordForm.otype, pv, qv);
                setCtxMenu(null); setOrdForm(null);
              };
              const key = (e: React.KeyboardEvent) => {
                e.stopPropagation();
                if (e.key === 'Enter') place();
                if (e.key === 'Escape') { setOrdForm(null); setOrdErr(''); }
              };
              return (<>
                <div style={{ ...ctxRow, cursor: 'default', fontWeight: 600 }}>
                  {ordForm.side === 'buy' ? 'Buy' : 'Sell'} {cap(ordForm.otype)} · {t.instrument}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '2px 10px 4px' }}
                     onClick={(e) => e.stopPropagation()}>
                  <span style={lab}>Price</span>
                  <input autoFocus value={ordPrice} spellCheck={false} inputMode="decimal"
                         style={inp} onChange={(e) => setOrdPrice(e.target.value)} onKeyDown={key} />
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '0 10px 4px' }}
                     onClick={(e) => e.stopPropagation()}>
                  <span style={lab}>Units</span>
                  <input value={ordQty} spellCheck={false} inputMode="decimal"
                         style={inp} onChange={(e) => setOrdQty(e.target.value)} onKeyDown={key} />
                </div>
                <div style={{ display: 'flex', gap: 4, margin: '0 10px 2px', justifyContent: 'flex-end' }}
                     onClick={(e) => e.stopPropagation()}>
                  <button
                    style={{ padding: '3px 10px', fontSize: 12, borderRadius: 2, cursor: 'pointer',
                             border: '1px solid var(--edge)', background: 'transparent', color: 'var(--dim)' }}
                    onClick={() => { setOrdForm(null); setOrdErr(''); }}
                  >Back</button>
                  <button
                    style={{ padding: '3px 12px', fontSize: 12, borderRadius: 2, cursor: 'pointer',
                             border: '1px solid var(--edge)', background: 'var(--active)', color: 'var(--text)' }}
                    onClick={place}
                  >Place</button>
                </div>
                {ordErr && <div style={{ ...ctxRow, color: '#e05d5d', cursor: 'default' }}>{ordErr}</div>}
                <div style={{ margin: '3px 0', borderTop: '1px solid var(--edge)' }} />
              </>);
            }
            const qty = t.qty != null ? `${t.qty} ` : '';
            const rows: Array<{ label: string; side: string; otype: string }> = [
              { label: `Buy ${qty}${t.instrument} at market`, side: 'buy', otype: 'market' },
              { label: `Sell ${qty}${t.instrument} at market`, side: 'sell', otype: 'market' },
            ];
            const p = ctxMenu.price, ref = ctxMenu.ref;
            const types = t.pendingTypes || [];
            if (p != null && ref != null && p !== ref && types.length) {
              const pend = p < ref
                ? [{ side: 'buy', otype: 'limit' }, { side: 'sell', otype: 'stop' }]
                : [{ side: 'sell', otype: 'limit' }, { side: 'buy', otype: 'stop' }];
              for (const r of pend) {
                if (!types.includes(r.otype)) continue;
                rows.push({ ...r, label:
                  `${r.side === 'buy' ? 'Buy' : 'Sell'} ${cap(r.otype)} @ ${fp(p)}…` });
              }
            }
            return (<>
              {rows.map((r) => (
                <button
                  key={`${r.side}-${r.otype}`}
                  className="w-full text-left" style={ctxRow}
                  onMouseEnter={onCtxRowIn} onMouseLeave={onCtxRowOut}
                  onClick={(e) => {
                    if (r.otype === 'market') {
                      (window as any).__lseShell?.quickOrder?.(r.side, r.otype, ctxMenu.price);
                      setCtxMenu(null);
                      return;
                    }
                    // pending: open the price/size step in place of the rows
                    e.stopPropagation();
                    setOrdForm({ side: r.side, otype: r.otype });
                    // NOT fp(): the shell's fmt is a display rounding (2dp
                    // between 10 and 1000) and would move an FX level by
                    // most of a pip (184.577 -> "184.58"). The prefill is
                    // the order's actual price: at the places the INSTRUMENT
                    // the order goes to declares (t.digits), snapped to its
                    // tick (t.tick), so a level read off one grid is put on
                    // the order's own; the chart source's places
                    // (orderFormPrice) only when the instrument declares none.
                    // Six places of a five-place pair were refused by the broker.
                    setOrdPrice(p != null
                      ? (t.digits != null
                          ? (t.tick && t.tick > 0 ? Math.round(p / t.tick) * t.tick : p).toFixed(t.digits)
                          : orderFormPrice(p, symbol, provider))
                      : '');
                    setOrdQty(t.qty != null ? String(t.qty) : '');
                    setOrdErr('');
                  }}
                >{r.label}</button>
              ))}
              <div style={{ margin: '3px 0', borderTop: '1px solid var(--edge)' }} />
            </>);
          })()}
          <button
            className="w-full text-left"
            // display must be set HERE, not via a flex class: ctxRow's inline
            // display:block wins over Tailwind and left the caret glued to the
            // label instead of pushed to the right edge.
            style={{ ...ctxRow, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
            onMouseEnter={onCtxRowIn} onMouseLeave={onCtxRowOut}
            onClick={() => setTplOpen((v) => !v)}
          >
            <span>Chart template</span>
            <span style={{ color: 'var(--dim)' }}>{tplOpen ? '▾' : '▸'}</span>
          </button>
          {tplOpen && (
            <div className="max-h-48 overflow-y-auto" style={{ borderTop: '1px solid var(--edge)', borderBottom: '1px solid var(--edge)', margin: '3px 0' }}>
              {(((window as any).__lseShell?.layouts?.() || []) as Array<{ id: string; name: string }>).length === 0 ? (
                <div style={{ ...ctxRow, color: 'var(--dim)' }}>No saved templates yet</div>
              ) : (((window as any).__lseShell.layouts()) as Array<{ id: string; name: string }>).map((l) => (
                <div
                  key={l.id}
                  style={{ ...ctxRow, display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 20, cursor: 'pointer' }}
                  onMouseEnter={onCtxRowIn} onMouseLeave={onCtxRowOut}
                  onClick={() => { (window as any).__lseShell?.applyLayout?.(l.id); setCtxMenu(null); }}
                >
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>
                  {/* Two-click delete: first click arms, second deletes. */}
                  <button
                    title={tplPendingDelete === l.id ? 'Click again to delete' : 'Delete template'}
                    style={{
                      border: 'none', background: 'none', cursor: 'pointer',
                      fontSize: tplPendingDelete === l.id ? 11 : 13, lineHeight: 1, padding: '0 2px',
                      color: tplPendingDelete === l.id ? '#e05d5d' : 'var(--dim)',
                    }}
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (tplPendingDelete !== l.id) { setTplPendingDelete(l.id); return; }
                      await (window as any).__lseShell?.deleteLayout?.(l.id);
                      setTplPendingDelete(null);
                      setTplTick((t) => t + 1);
                    }}
                  >{tplPendingDelete === l.id ? 'sure?' : '×'}</button>
                </div>
              ))}
              {/* Save door: an inline name input in the submenu itself, with
                  the Save button beside it. The button is not decoration:
                  before it existed the row turned into a bare text box whose
                  only commit was a blind Enter, and the menu then offered
                  nothing labelled save at all. Enter still works. */}
              {tplSaving ? (
                <div
                  style={{ display: 'flex', gap: 4, margin: '3px 12px 5px', alignItems: 'center' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    autoFocus
                    value={tplName}
                    placeholder="Template name"
                    spellCheck={false}
                    style={{
                      flex: 1, minWidth: 0, padding: '3px 6px', fontSize: 12, color: 'var(--text)',
                      background: 'var(--bg2)', border: '1px solid var(--edge)', borderRadius: 2,
                    }}
                    onChange={(e) => setTplName(e.target.value)}
                    onKeyDown={async (e) => {
                      e.stopPropagation();
                      if (e.key === 'Escape') { setTplSaving(false); return; }
                      if (e.key !== 'Enter') return;
                      await saveTemplate();
                    }}
                  />
                  <button
                    disabled={!tplName.trim()}
                    title={tplName.trim() ? 'Save this chart as a template' : 'Name the template first'}
                    style={{
                      padding: '3px 10px', fontSize: 12, lineHeight: 1.5, borderRadius: 2,
                      border: '1px solid var(--edge)', background: 'var(--active)',
                      color: 'var(--text)', cursor: tplName.trim() ? 'pointer' : 'default',
                      opacity: tplName.trim() ? 1 : 0.5,
                    }}
                    onClick={saveTemplate}
                  >Save</button>
                </div>
              ) : (
                <button
                  className="w-full text-left"
                  style={{ ...ctxRow, paddingLeft: 20, color: 'var(--dim)' }}
                  onMouseEnter={onCtxRowIn} onMouseLeave={onCtxRowOut}
                  onClick={(e) => {
                    e.stopPropagation();
                    setTplName((window as any).__lseShell?.layoutDefaultName?.() || '');
                    setTplErr('');
                    setTplSaving(true);
                  }}
                >+ Save current as template…</button>
              )}
              {tplErr && (
                <div style={{ ...ctxRow, paddingLeft: 20, color: '#e05d5d' }}>{tplErr}</div>
              )}
            </div>
          )}
          <button
            className="w-full text-left" style={ctxRow}
            onMouseEnter={onCtxRowIn} onMouseLeave={onCtxRowOut}
            onClick={() => {
              chartAreaRef.current?.querySelector<HTMLButtonElement>('button[title="Reset view"]')?.click();
              setCtxMenu(null);
            }}
          >Reset chart view</button>
          <button
            className="w-full text-left" style={ctxRow}
            onMouseEnter={onCtxRowIn} onMouseLeave={onCtxRowOut}
            onClick={() => { setFlipped((f) => !f); setCtxMenu(null); }}
          >{flipped ? 'Unflip chart' : 'Flip chart'}</button>
          {drawings.length > 0 && (
            <button
              className="w-full text-left" style={ctxRow}
              onMouseEnter={onCtxRowIn} onMouseLeave={onCtxRowOut}
              onClick={() => { clearAllDrawings(); setCtxMenu(null); }}
            >Remove drawings ({drawings.length})</button>
          )}
          <div style={{ margin: '3px 0', borderTop: '1px solid var(--edge)' }} />
          <button
            className="w-full text-left" style={ctxRow}
            onMouseEnter={onCtxRowIn} onMouseLeave={onCtxRowOut}
            onClick={() => { setAppearanceView('appearance'); setAppearanceOpen(true); setCtxMenu(null); }}
          >Settings...</button>
        </div>
      )}
    </div>
  );
}

// ── imperative shell API ────────────────────────────────────────────────────

// ── multi-pane charts (screen layout, up to 8) ──────────────────────────────
// Each secondary pane is a self-contained light chart: ProChart only, no
// drawing rail/overlay (drawings stay a primary-pane feature), own root and
// props. The shell owns the grid, symbols and data; this is just the renderer.
function PaneChart({ symbol, timeframe, candles, quote, provider }: {
  symbol: string; timeframe: string; candles: Candle[];
  quote?: { bid: number; ask: number } | null;
  // the source the pane shows, whose declared digits it prints with
  provider?: string | null;
}) {
  const chartSettings = useChartSettings();
  const colors = useMemo(() => getDefaultColors(), []);
  if (!symbol || !candles.length) {
    return <div className="h-full w-full" />;
  }
  return (
    <ProChart
      candles={candles}
      symbol={symbol}
      priceSource={provider}
      timeframe={timeframe}
      chartType="candlestick"
      livePrice={candles[candles.length - 1]?.close ?? null}
      rightOffset={6}
      colors={colors}
      indicators={DEFAULT_INDICATOR_CONFIG}
      // Same timezone wiring as the primary chart: without the prop ProChart
      // defaults to 'UTC' and ignores the user's Timezone setting.
      timezone={chartSettings?.data?.timezone || 'local'}
      showBidAskSpread={!!quote}
      brokerBid={quote?.bid ?? null}
      brokerAsk={quote?.ask ?? null}
    />
  );
}

const PANES = new Map<HTMLElement, { root: Root; props: any }>();

function renderPane(el: HTMLElement) {
  const inst = PANES.get(el);
  if (!inst) return;
  inst.root.render(
    <MemoryRouter>
      <ChartSettingsProvider>
        <PaneChart {...inst.props} />
      </ChartSettingsProvider>
    </MemoryRouter>
  );
}

const LSEChartPanes = {
  mount(el: HTMLElement, initial: any = {}) {
    if (!PANES.has(el)) PANES.set(el, { root: createRoot(el), props: {} });
    const inst = PANES.get(el)!;
    inst.props = { ...inst.props, ...normalise(initial) };
    renderPane(el);
  },
  update(el: HTMLElement, next: any) {
    const inst = PANES.get(el);
    if (!inst) return;
    inst.props = { ...inst.props, ...normalise(next) };
    renderPane(el);
  },
  unmount(el: HTMLElement) {
    const inst = PANES.get(el);
    if (!inst) return;
    inst.root.unmount();
    PANES.delete(el);
  },
};

// The top-bar Layout trigger (the site's grid-preset + sync-toggle picker),
// mounted by the shell into #sl-slot via LSEChart.mountLayoutButton. It talks
// to the chart root only through layoutStore.
function LayoutButton() {
  const s = useLayoutState();
  return (
    <MultiTimeframeLayoutSelector
      selectedLayout={s.layout}
      onLayoutChange={(l) => layoutStore.setLayout(l)}
      syncSettings={s.sync}
      onSyncSettingsChange={(x) => layoutStore.setSync(x)}
      isMultiPanelActive={s.layout !== '1x1'}
      onExitMultiPanel={() => layoutStore.setLayout('1x1')}
    />
  );
}

let root: Root | null = null;
// Registered by the mounted TerminalChart; lets the shell's gear button open
// the appearance dialog without owning any React state.
let openAppearanceFn: ((view?: 'appearance' | 'chart') => void) | null = null;
// Indicator overrides pushed in imperatively via LSEChart.setIndicators().
// Kept outside props because indicators are otherwise owned per-symbol by the
// component (loaded from, and saved to, the workspace file).
let indicatorPatch: Record<string, any> | null = null;
let props: ChartProps = {
  provider: 'demo', symbol: '', timeframe: '1h', candles: [],
  chartType: 'candlestick', trades: [], engineIndicators: undefined,
};

function render() {
  if (!root) return;
  // ChartSettingsProvider is required by ProChart and its settings dialogs; it
  // is the single source of truth for the chart's appearance settings and is
  // backed by the workspace file via lib/api.
  // MemoryRouter: some chart components (the sign-in modal reached from the
  // tool rail) call useNavigate, which throws without a Router ancestor. The
  // terminal has no routes of its own, so an in-memory router satisfies them
  // without touching the shell's URL.
  root.render(
    <MemoryRouter>
      <ChartSettingsProvider>
        <TerminalChart {...props} indicatorPatch={indicatorPatch} />
      </ChartSettingsProvider>
    </MemoryRouter>
  );
}

// The shell and the engine name chart types differently: the shell
// offers candles/bars/line/area, the engine takes candlestick/line/area/renko.
// Normalise here so the shell's existing <select> keeps working unchanged.
const CHART_TYPE_ALIASES: Record<string, ChartType> = {
  candles: 'candlestick',
  bars: 'candlestick',
  candlestick: 'candlestick',
  line: 'line',
  area: 'area',
  renko: 'renko',
};

// Any timestamp below this is far too small to be milliseconds (it would be
// 1970), so it is epoch seconds and needs scaling. Using a threshold rather
// than a flag keeps the bridge correct whichever unit a provider hands back.
const MS_THRESHOLD = 1e12;

function normalise(next: Partial<ChartProps>): Partial<ChartProps> {
  const out: Partial<ChartProps> = { ...next };
  if (next.chartType) out.chartType = CHART_TYPE_ALIASES[next.chartType] ?? 'candlestick';
  // Null symbols come from the shell before an instrument is selected. Only
  // touch the key when the caller actually supplied it: update() is used for
  // partial pushes (chart type alone, trades alone), and coercing an absent
  // symbol to '' would blank the chart on every one of them.
  if ('symbol' in next && !next.symbol) out.symbol = '';
  // The engine emits epoch SECONDS; the chart does `new Date(candle.time)`
  // throughout, which is milliseconds. Without this every bar lands in Jan 1970.
  if (next.candles?.length && next.candles[0].time < MS_THRESHOLD) {
    out.candles = next.candles.map((c) => ({ ...c, time: c.time * 1000 }));
  }
  // Trade markers arrive on the same clock as the candles.
  if (next.trades?.length && next.trades[0].time < MS_THRESHOLD) {
    out.trades = next.trades.map((t) => ({ ...t, time: t.time * 1000 }));
  }
  // A source's declared decimals go to the price formatter, kept by that
  // source, not to props.
  if ('priceDigits' in next) {
    setPriceDigits(next.priceDigits, 'priceSource' in next ? next.priceSource : next.provider);
    delete out.priceDigits;
  }
  delete out.priceSource;
  return out;
}

const LSEChart = {
  async mount(el: HTMLElement, initial: Partial<ChartProps> = {}) {
    props = { ...props, ...normalise(initial) };
    if (!root) root = createRoot(el);
    // Preferences must be hydrated BEFORE the first render, or the components
    // read empty defaults and immediately overwrite what the user had saved.
    await initWorkspaceBridge();
    render();
  },
  // Partial update so the shell can push just a symbol or just new candles
  // without having to restate the whole prop set.
  update(next: Partial<ChartProps>) {
    props = { ...props, ...normalise(next) };
    render();
  },
  unmount() {
    root?.unmount();
    root = null;
  },
  // Opens the chart colours/settings dialog (shell toolbar buttons).
  // view picks the tab: 'appearance' (colours) or 'chart' (timezone, zoom);
  // omitted keeps the old open-on-appearance behaviour.
  openAppearance(view?: 'appearance' | 'chart') {
    openAppearanceFn?.(view);
  },
  // Drop a cached workspace section after the shell writes it directly over
  // HTTP (layout apply restores chart settings), so a remount re-reads the
  // file instead of the stale in-memory copy.
  invalidateWorkspaceSection(section: string) {
    invalidateSection(section as any);
  },
  // Indicator control for the shell (and for automated checks). Merges over
  // the current config so callers can flip one indicator without restating
  // the whole registry.
  setIndicators(patch: Record<string, any>) {
    indicatorPatch = { ...(indicatorPatch || {}), ...patch };
    render();
  },
  // The indicator keys this chart understands, so a caller can enumerate them
  // rather than hardcoding a list that drifts from the registry.
  indicatorKeys(): string[] {
    return Object.keys(DEFAULT_INDICATOR_CONFIG);
  },
  // The registry's default parameters. Callers enabling an indicator should
  // start from these: several indicators carry required arrays/periods, and
  // an `{enabled:true}` with no parameters is not a valid config.
  indicatorDefaults(): Record<string, any> {
    return JSON.parse(JSON.stringify(DEFAULT_INDICATOR_CONFIG));
  },
};

// -- manual backtesting (bar replay) ----------------------------------------
//
// A second imperative surface on the same bundle: the shell's BACKTEST mode
// chooser mounts this when the user picks Manual. It reproduces the website's
// /backtest flow verbatim: the setup dialog (symbol, timeframe, start
// date/time, timezone, capital, spread) navigates to /backtest/:pair inside a
// MemoryRouter, where the Backtesting page runs the replay. Keeping the
// router contract identical is what lets both page components stay unmodified.

import { Routes, Route, useLocation, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster as SonnerToaster } from 'sonner';
import Backtesting from '@/pages/Backtesting';
import BacktestingSetupDialog from '@/components/backtesting/BacktestingSetupDialog';

// Some chart components reach for react-query hooks; upstream the whole app
// sits under one QueryClientProvider, so the backtest mount provides its own.
const btQueryClient = new QueryClient();

// Whether the replay route is currently mounted. The setup dialog closes
// itself both on cancel AND right after a successful start (navigate() then
// onOpenChange(false)), and by the time the close settles the setup component
// has unmounted, so it cannot ask the router which of the two happened. The
// replay route flips this flag on mount instead.
const btNav = { inReplay: false };

function ManualBacktestSetup({ onExit }: { onExit: () => void }) {
  const [open, setOpen] = useState(true);
  const location = useLocation();

  // Re-arm the dialog whenever the router returns here (back button from the
  // replay, report completion navigating to '/' or '/backtests').
  useEffect(() => { setOpen(true); }, [location.key]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      // Give a successful start's navigation a beat to mount the replay
      // route; only a close that did NOT navigate means "user backed out".
      setTimeout(() => {
        if (!btNav.inReplay) onExit();
      }, 150);
    }
  };

  return (
    <div className="h-full w-full bg-[#0b0d12]">
      <BacktestingSetupDialog open={open} onOpenChange={handleOpenChange} />
    </div>
  );
}

// Pins the data layer's engine context to the replayed instrument before the
// page mounts: the engine's fetch layer resolves candles from the mount context,
// and the URL's slashless pair ("EURUSD") is not reversible to the provider's
// native symbol ("EUR/USD"), so the native form rides in the `sym` param.
function ManualBacktestRoute({ provider }: { provider: string }) {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const sym = searchParams.get('sym');
  const pair = location.pathname.split('/').pop() || '';
  // The setup dialog can pick a source other than the shell's active provider
  // (its Data Source selector), so the chosen provider rides in the URL and
  // wins over the mount default; the fetch layer must read candles from the
  // same source the pair was chosen from.
  const replayProvider = searchParams.get('provider') || provider;
  setEngineContext({ provider: replayProvider, symbol: sym || pair });
  useEffect(() => {
    btNav.inReplay = true;
    return () => { btNav.inReplay = false; };
  }, []);
  return <Backtesting />;
}

let btRoot: Root | null = null;

const LSEManualBacktest = {
  async mount(el: HTMLElement, opts: { provider?: string; onExit?: () => void } = {}) {
    const provider = opts.provider || 'demo';
    const onExit = opts.onExit || (() => {});
    if (!btRoot) btRoot = createRoot(el);
    // Pin the data adapter to the shell's active provider BEFORE anything
    // renders: the setup dialog's symbol search reads the engine context, and
    // a stale context would offer one provider's universe and then replay
    // against another's.
    setEngineContext({ provider, symbol: '' });
    // Same hydration rule as the chart mount: preferences must load before
    // first render or defaults overwrite the saved workspace.
    await initWorkspaceBridge();
    btRoot.render(
      <QueryClientProvider client={btQueryClient}>
        <MemoryRouter initialEntries={['/']}>
          <ChartSettingsProvider>
            <Routes>
              <Route path="/backtest/:pair" element={<ManualBacktestRoute provider={provider} />} />
              {/* '/', '/backtests' (report exit) and anything unknown re-open setup. */}
              <Route path="*" element={<ManualBacktestSetup onExit={onExit} />} />
            </Routes>
            <SonnerToaster theme="dark" position="bottom-right" />
          </ChartSettingsProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
  },
  unmount() {
    btRoot?.unmount();
    btRoot = null;
  },
};

// The economic calendar is a self-contained page (own fetches, no chart
// settings context), so its mount is the thin one: render, and re-render with
// a fresh onBack if the shell remounts it.
import EconomicCalendarPage from '@/pages/EconomicCalendar';

let ecRoot: Root | null = null;

const LSEEconCalendar = {
  // `view` is how the ECONOMIC sub-tabs (Calendar / News / Indicators / Bond
  // yields / Central banks) open the island straight into one of its views;
  // omitted, the page restores whichever view was last used.
  mount(el: HTMLElement, opts: { onBack?: () => void; view?: string } = {}) {
    if (!ecRoot) ecRoot = createRoot(el);
    ecRoot.render(<EconomicCalendarPage onBack={opts.onBack} initialView={opts.view as any} />);
  },
  unmount() {
    ecRoot?.unmount();
    ecRoot = null;
  },
};

// Data Visualisation (WORKSPACE sub-view) is self-contained like the
// calendar: own fetches, no chart settings context, so the thin mount.
import DataVizPage from '@/pages/DataViz';

let dvRoot: Root | null = null;

const LSEDataViz = {
  mount(el: HTMLElement) {
    if (!dvRoot) dvRoot = createRoot(el);
    dvRoot.render(<DataVizPage />);
  },
  unmount() {
    dvRoot?.unmount();
    dvRoot = null;
  },
};

// RESEARCH > QUANT MODELS is self-contained like DataViz: own state, so the
// same thin mount. Its host div never leaves the DOM (the shell only
// toggles .hidden), so the root is created once and re-rendered on revisit.
// (The old knowledge-archive island was removed.)
import QuantModelsPage from '@/pages/QuantModels';

let qmRoot: Root | null = null;

const LSEQuantModels = {
  mount(el: HTMLElement) {
    if (!qmRoot) qmRoot = createRoot(el);
    qmRoot.render(<QuantModelsPage />);
  },
  unmount() {
    qmRoot?.unmount();
    qmRoot = null;
  },
};

// WORKSPACE > NOTEBOOKS: the infinite research canvas. Same thin mount as
// DataViz; it owns its rail, its canvas and its own fetches, so the shell only
// has to reveal the host div and call mount once.
import NotebooksPage from '@/pages/Notebooks';

let nbRoot: Root | null = null;

const LSENotebooks = {
  mount(el: HTMLElement) {
    if (!nbRoot) nbRoot = createRoot(el);
    nbRoot.render(<NotebooksPage />);
  },
  unmount() {
    nbRoot?.unmount();
    nbRoot = null;
  },
};

declare global {
  interface Window {
    LSEChart: typeof LSEChart;
    LSEChartPanes: typeof LSEChartPanes;
    LSEManualBacktest: typeof LSEManualBacktest;
    LSEEconCalendar: typeof LSEEconCalendar;
    LSEDataViz: typeof LSEDataViz;
    LSEQuantModels: typeof LSEQuantModels;
    LSENotebooks: typeof LSENotebooks;
  }
}
// Shell entry points for the top-bar Layout button. Attached as PROPERTIES of
// the API object, never as module exports: this file must keep exactly one
// runtime export (the default). The Vite IIFE wrapper assigns this module's
// exports to window.LSEChart, and a second runtime export turns that global
// into a {default, ...} namespace with no .mount, blanking every chart
// (shipped broken once, commit e71477c). tools/chart_smoke.mjs guards
// this; run it before committing any bundle.
(LSEChart as any).mountLayoutButton = (el: HTMLElement) => {
  createRoot(el).render(<LayoutButton />);
};
(LSEChart as any).layoutStore = layoutStore;
window.LSEChart = LSEChart;
window.LSEChartPanes = LSEChartPanes;
window.LSEManualBacktest = LSEManualBacktest;
window.LSEEconCalendar = LSEEconCalendar;
window.LSEDataViz = LSEDataViz;
window.LSEQuantModels = LSEQuantModels;
window.LSENotebooks = LSENotebooks;

export default LSEChart;
