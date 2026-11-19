// ============================================================================
// core/types.ts - Shared type definitions and constants for the ProChart system
// Extracted from ProChart.tsx so that multiple chart components (ProChart,
// ProCandlestickChart, ChartDrawingOverlay, etc.) can import the same types
// without circular dependencies or duplication.
// ============================================================================

import type { IndicatorConfig } from '../IndicatorSettings';
import type { Drawing } from '../ChartDrawingOverlay';
import type { EconomicEvent } from '../ChartLeftSidebar';

// Core candle data structure used throughout the charting pipeline.
// Matches the shape returned by the candle API and consumed by the renderer.
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

// Supported chart visualization types
export type ChartType = 'candlestick' | 'line' | 'area' | 'renko';

// Ratio of gap between candles relative to candle width.
// A value of 0.2 means the gap is 20% of the candle body width, so total
// spacing per candle = candleWidth * (1 + CANDLE_GAP_RATIO).
// This constant is used in scroll calculations, coordinate conversions,
// and rendering to keep spacing consistent across all chart interactions.
export const CANDLE_GAP_RATIO = 0.2;

// Full props interface for ProChart. Exported so that wrapper components
// like ProCandlestickChart can type-check the props they forward.
export interface ProChartProps {
  candles: Candle[];
  livePrice?: number | null;
  symbol?: string;
  // The source this chart shows (the shell's provider): its declared price
  // digits are read by source and symbol (setPriceDigits). None: none read.
  priceSource?: string | null;
  timezone?: string;
  countdown?: string;
  onCrosshairMove?: (price: number | null, time: number | null) => void;
  syncedCrosshairTime?: number | null; // For crosshair sync across panels
  drawings?: Drawing[]; // Passed from parent for native badge rendering
  selectedDrawingId?: string | null; // Currently selected drawing id
  // Ref-based drawing cursor signal from ChartDrawingOverlay. When the user is
  // actively drawing (tool active, mouse moving), the overlay writes cursor
  // price/time here. The chart reads it during drawChart() to render the same
  // blue axis badges used for selected drawings, giving WYSIWYG preview feedback.
  // x is included so the canvas can position the time badge without re-converting
  // time to pixel coordinates (avoids duplicating the scroll-state-aware conversion).
  // Array supports multiple badge points: element 0 is the anchor (first click),
  // element 1 is the live cursor. Before the first click, only element 0 (cursor)
  // is present. After the first click, both anchor and cursor are included.
  drawingCursorRef?: React.MutableRefObject<Array<{ price: number | null; time: number | null; x: number | null }>>;
  colors?: {
    background: string;
    backgroundOpacity?: number; // 0-100
    grid: string;
    gridOpacity?: number; // 0-100
    text: string;
    textDim: string;
    bullish: string;
    bearish: string;
    bullishBorder: string;
    bearishBorder: string;
    bullishWick: string;
    bearishWick: string;
    crosshair: string;
    priceLine: string;
    priceTickerBullish?: string;
    priceTickerBearish?: string;
    slColor?: string;
    slOpacity?: number;
    tpColor?: string;
    tpOpacity?: number;
    crosshairStyle?: string;
    crosshairLabelBg?: string;
    axisLabel?: string;
    axisLine?: string;
  };
  indicators?: IndicatorConfig;
  onIndicatorsChange?: (config: IndicatorConfig) => void;
  /**
   * Per-Brue-plot delete handler from the legend toolbar. Wired all the way
   * up to ChartPage which routes the action to the right backing store
   * (clear editor render data when the editor is open, otherwise disable
   * the named script in customBrueScripts). Optional so consumers that
   * don't render Brue plots can omit it.
   */
  onRemoveBruePlot?: (scriptId?: string) => void;
  /**
   * Delete handler for an ENGINE-computed indicator (one that arrived already
   * calculated and carries a `local:` expression), given the engine's label
   * for it. Such an entry cannot be removed by editing customIndicators: that
   * array is regenerated from the engine payload on every render, so a local
   * filter is undone immediately. Whoever owns the payload has to drop it.
   * Optional so consumers with no engine indicators can omit it.
   */
  onRemoveEngineIndicator?: (label: string) => void;
  /**
   * Open the owning side's parameter editor for an engine-computed indicator. Same
   * reason as onRemoveEngineIndicator: the chart holds no editable config for
   * these, only the precomputed series, so editing has to go back to whoever
   * asked the engine for them. Omit and the menu shows no Settings entry.
   */
  onEditEngineIndicator?: (label: string) => void;
  onConverterReady?: (converter: {
    timeToX: (time: number) => number | null;
    xToTime: (x: number) => number | null;
    priceToY: (price: number) => number;
    yToPrice: (y: number) => number;
    priceAxisWidth: number;
  }) => void;
  onVisibleRangeChange?: (range: { startIndex: number; endIndex: number; totalCandles: number }) => void;
  onViewportTimeChange?: (centerTime: number) => void; // For time sync across panels
  syncedViewportTime?: number | null; // Synced time to scroll to
  disableAutoFollow?: boolean;
  scrollToIndex?: number; // When set, scroll so this index is visible (near right edge)
  chartType?: ChartType;
  onScrollingChange?: (isScrolling: boolean) => void; // Notify parent when scroll state changes
  onScrollSync?: () => void; // Called on each scroll frame for drawing sync (ref-based, no state updates)
  scrollOffsetRef?: React.MutableRefObject<number>; // Scroll offset in pixels for CSS transform sync
  optionsPdfEnabled?: boolean; // Whether to show the Options PDF probability cloud
  heatmapEnabled?: boolean; // Whether to show the Order Book L2 Heatmap
  externalDimensions?: { width: number; height: number }; // Override internal ResizeObserver with explicit dimensions
  economicEvents?: EconomicEvent[]; // Economic events to display as vertical markers
  positionLines?: Array<{ id: string; price: number; side: 'buy' | 'sell'; quantity: number; symbol: string; pnl?: number; stopLoss?: number; takeProfit?: number }>;
  onPositionModify?: (positionId: string, stopLoss?: number, takeProfit?: number) => void;
  onPositionClose?: (positionId: string) => void;
  autoSelectPositionId?: string | null;
  l2DepthData?: { bids: { price: number; size: number }[]; asks: { price: number; size: number }[] } | null;
  onOpenSettings?: (tab?: string) => void;
  onOpenCustomEditor?: () => void;
  showBidAskSpread?: boolean; // Show MT5-style bid/ask spread lines
  /**
   * When the chart is in broker mode and the broker's live quote is
   * available, pass the broker's actual bid/ask here. The bid/ask
   * lines will be drawn at these exact prices so what the user sees
   * on screen equals what the broker fills at; eliminates the 4-pip
   * gap between "synthetic spread line" and "real EODHD ask".
   * When omitted, the chart falls back to liveLinePrice + synthetic
   * spread (the central / view-only path).
   */
  brokerBid?: number | null;
  brokerAsk?: number | null;
  showSessions?: boolean; // Show trading session background boxes (Tokyo, London, NY)
  timeframe?: string; // Current timeframe string for session renderer (skips 1D/1W/1M)
  rightOffset?: number; // Override right offset (default RIGHT_TOOLBAR_WIDTH on desktop)
  onLoadMore?: () => void; // Called when user scrolls to the left edge, triggers loading older candles
  isLoadingMore?: boolean; // True while older candles are being fetched (shows loading indicator at left edge)
  prependShift?: number; // Cumulative count of candles prepended by infinite scrollback. When this increases, ProChart shifts viewState.startIndex by the delta so the view does not jump.
  // Ref that TestChart populates with its drawChart function. External components
  // (like ChartDrawingOverlay) can call requestRedrawRef.current() to trigger a
  // canvas repaint, e.g. to update drawing cursor badges on every pointer move.
  requestRedrawRef?: React.MutableRefObject<(() => void) | null>;
  // Used to pause expensive canvas render loops during high frequency drawing drag events
  isDrawingDragging?: boolean;
}

// Returns default chart colors based on the current theme (dark/light).
// Reads the <html> element's class list at call time to detect dark mode.
// Used as fallback when no explicit colors prop is provided.
// Default fill for the last-price tag on the price axis. The tag was a
// green/red box (TradingView style) and read as a neon accent; it must
// look like the grey crosshair price label that
// normally sits on the same axis. So both directional defaults resolve to
// the crosshair label's background (crosshairRenderer labelBg fallback and
// ChartSettingsDialog crosshairLabelBg default are this same value); the
// user can still recolour them in Appearance, the change is only the default.
export const PRICE_TAG_NEUTRAL = '#131722';

export const getDefaultColors = () => {
  const isDark = typeof document !== 'undefined'
    ? document.documentElement.classList.contains('dark')
    : true;

  return {
    // Neutral charcoal matching the shell's --bg (no deep blacks anywhere,
    // superseding the earlier pixel-sampled #0d0d0d), so
    // chart and chrome sit on one continuous surface. Neutral grid, no blue.
    // Keep in step with style.css :root --bg and the compiled chart.js copy:
    // the shipped bundle was hand-patched with these same values.
    background: isDark ? '#212121' : '#ffffff',
    grid: isDark ? '#343434' : '#e0e3eb',
    text: isDark ? '#ffffff' : '#000000',
    textDim: isDark ? '#666666' : '#999999',
    bullish: '#22c55e',
    bearish: '#ef4444',
    bullishBorder: '#16a34a',
    bearishBorder: '#dc2626',
    bullishWick: '#22c55e',
    bearishWick: '#ef4444',
    crosshair: isDark ? '#ffffff40' : '#00000040',
    priceLine: '#3b82f6',
    priceTickerBullish: PRICE_TAG_NEUTRAL,
    priceTickerBearish: PRICE_TAG_NEUTRAL,
    axisLabel: isDark ? '#b2b5be' : '#000000',
    axisLine: isDark ? '#2a2e39' : '#e0e3eb',
  };
};
