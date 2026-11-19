// TerminalMultiGrid - the site's MultiPanelChartGrid, terminal edition.
//
// Same behavior contract as the website's multi-chart layout:
// grid presets from MultiTimeframeLayoutSelector (2x1 .. 4x2),
// per-panel timeframe (staggered sensible defaults), per-panel symbol when
// symbol-sync is off, active-panel highlight, and the four sync modes:
//   syncSymbol   - every panel follows the shell's charted pair
//   syncInterval - panels share the primary timeframe
//   syncCrosshair- crosshair time mirrors across panels (ProChart's
//                  syncedCrosshairTime prop, same as the site)
//   syncTime     - viewport scroll position mirrors (syncedViewportTime)
//
// Data: the site's panels fetch through ProCandlestickChart; here each panel
// fetches through the terminal's local engine (fetchLocalCandles) and
// refreshes its tail on a short timer, so panes stay live without the shell
// having to fan ticks into React.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ProChart from '@/components/chart/ProChart';
import { DEFAULT_INDICATOR_CONFIG } from '@/components/chart/IndicatorSettings';
import { getDefaultColors, type Candle } from '@/components/chart/core/types';
import { type LayoutType, type SyncSettings } from '@/components/chart/MultiTimeframeLayoutSelector';
import { fetchLocalCandles } from '@/lib/localEngine';
import { layoutStore, useLayoutState } from '@/lib/layoutStore';
import { useChartSettings } from '@/contexts/ChartSettingsContext';

const LAYOUTS: Record<LayoutType, { count: number; cols: number; rows: number }> = {
  '1x1': { count: 1, cols: 1, rows: 1 },
  '2x1': { count: 2, cols: 2, rows: 1 },
  '1x2': { count: 2, cols: 1, rows: 2 },
  '2x2': { count: 4, cols: 2, rows: 2 },
  '3x1': { count: 3, cols: 3, rows: 1 },
  '1x3': { count: 3, cols: 1, rows: 3 },
  '4x1': { count: 4, cols: 4, rows: 1 },
  '3x2': { count: 6, cols: 3, rows: 2 },
  '2x3': { count: 6, cols: 2, rows: 3 },
  '4x2': { count: 8, cols: 4, rows: 2 },
};

// The site staggers panel timeframes so a fresh multi-layout is instantly
// useful (same idea as createInitialPanelStates upstream).
const STAGGER = ['1h', '4h', '1d', '15m', '5m', '1w', '30m', '1m'];

function Panel({
  symbol, timeframe, colors, active, onActivate,
  syncedCrosshairTime, onCrosshairMove, syncedViewportTime, onViewportTimeChange,
  quote, priceSource,
}: {
  symbol: string; timeframe: string; colors: any; active: boolean;
  onActivate: () => void;
  syncedCrosshairTime: number | null;
  onCrosshairMove: (t: number | null) => void;
  syncedViewportTime: number | null;
  onViewportTimeChange: (t: number | null) => void;
  quote?: { bid: number; ask: number } | null;
  // the shell's source, whose declared price digits the panel prints with
  priceSource?: string | null;
}) {
  const [candles, setCandles] = useState<Candle[]>([]);
  // Timezone must be forwarded to ProChart: its prop default is 'UTC', which
  // ignores the user's Timezone setting (data.timezone, default "local").
  const chartSettings = useChartSettings();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    let cancelled = false;
    setCandles([]);
    const load = async () => {
      try {
        // fetchLocalCandles(tableName, options): the explicit symbol/timeframe
        // overrides bypass table-name resolution entirely; rows arrive as
        // {timestamp: ISO, o,h,l,c,v} and ProChart wants {time: ms, ...}.
        const rows = await fetchLocalCandles('multi_panel', {
          symbol, timeframe, limit: 500,
        });
        if (!cancelled && rows?.length) {
          setCandles(rows.map((r: any) => ({
            time: Date.parse(r.timestamp),
            open: r.open, high: r.high, low: r.low, close: r.close,
            volume: r.volume,
          })));
        }
      } catch { /* panel stays empty; next timer retries */ }
    };
    load();
    const t = setInterval(load, 10_000);   // live-ish tail refresh
    return () => { cancelled = true; clearInterval(t); };
  }, [symbol, timeframe]);

  return (
    <div
      onMouseDown={onActivate}
      style={{
        position: 'relative', minWidth: 0, minHeight: 0, overflow: 'hidden',
        // Selected pane: the shell's own selected-element color (--accent-bar:
        // charcoal on light, light gray on dark), same as active tabs and rows.
        // The old var(--accent) fallback resolved to a blue no shell rule allows.
        border: active ? '1px solid var(--accent-bar, #888)' : '1px solid var(--edge, #2a2e39)',
      }}
    >
      {/* No symbol/timeframe overlay on the pane: it sat on top of the
          OHLC legend and looked wrong. The SELECTED pane's name
          shows in the window title instead, and a sidebar/search pick
          retargets the selected pane; ProChart's own legend covers values. */}
      {candles.length > 0 && (
        <ProChart
          candles={candles}
          symbol={symbol}
          priceSource={priceSource}
          timeframe={timeframe}
          chartType="candlestick"
          livePrice={candles[candles.length - 1]?.close ?? null}
          rightOffset={6}
          colors={colors}
          indicators={DEFAULT_INDICATOR_CONFIG}
          timezone={chartSettings?.data?.timezone || 'local'}
          syncedCrosshairTime={syncedCrosshairTime ?? undefined}
          onCrosshairMove={onCrosshairMove}
          syncedViewportTime={syncedViewportTime ?? undefined}
          onViewportTimeChange={onViewportTimeChange}
          showBidAskSpread={!!quote}
          brokerBid={quote?.bid ?? null}
          brokerAsk={quote?.ask ?? null}
        />
      )}
    </div>
  );
}

export default function TerminalMultiGrid({
  layout, syncSettings, pair, timeframe, colors, quote, priceSource,
}: {
  layout: LayoutType;
  syncSettings: SyncSettings;
  pair: string;
  timeframe: string;
  colors: any;
  quote?: { bid: number; ask: number } | null;
  // the shell's source, which every panel charts
  priceSource?: string | null;
}) {
  const cfg = LAYOUTS[layout] || LAYOUTS['2x2'];
  // Selection and per-panel symbols live in layoutStore, not local state: the
  // shell reads them to name the window title and to retarget symbol picks.
  const { activePanel, panelSymbols } = useLayoutState();
  const active = Math.min(activePanel, cfg.count - 1);
  const [panelTfs, setPanelTfs] = useState<string[]>([]);
  const [crossT, setCrossT] = useState<number | null>(null);
  const [viewT, setViewT] = useState<number | null>(null);
  const base = useMemo(() => colors || getDefaultColors(), [colors]);

  useEffect(() => {
    setPanelTfs((prev) => {
      const next = [...prev];
      for (let i = next.length; i < cfg.count; i++) {
        next.push(i === 0 ? timeframe : STAGGER[i % STAGGER.length]);
      }
      return next.slice(0, cfg.count);
    });
  }, [cfg.count, timeframe]);

  const onCross = useCallback((t: number | null) => {
    if (syncSettings.syncCrosshair) setCrossT(t);
  }, [syncSettings.syncCrosshair]);
  const onView = useCallback((t: number | null) => {
    if (syncSettings.syncTime) setViewT(t);
  }, [syncSettings.syncTime]);

  return (
    <div style={{
      display: 'grid', width: '100%', height: '100%', gap: 2,
      gridTemplateColumns: `repeat(${cfg.cols}, 1fr)`,
      gridTemplateRows: `repeat(${cfg.rows}, 1fr)`,
    }}>
      {Array.from({ length: cfg.count }, (_, i) => (
        <Panel
          key={i}
          symbol={syncSettings.syncSymbol ? pair : (panelSymbols[i] || pair)}
          timeframe={syncSettings.syncInterval ? timeframe : (panelTfs[i] || timeframe)}
          colors={base}
          active={i === active}
          onActivate={() => layoutStore.setActivePanel(i)}
          syncedCrosshairTime={syncSettings.syncCrosshair ? crossT : null}
          onCrosshairMove={onCross}
          syncedViewportTime={syncSettings.syncTime ? viewT : null}
          onViewportTimeChange={onView}
          quote={quote}
          priceSource={priceSource}
        />
      ))}
    </div>
  );
}
