/**
 * ==============================================================================
 * CRITICAL AI AGENT INSTRUCTION - DO NOT MODIFY RENDER PIPELINE
 * ==============================================================================
 * This charting engine is hyper-optimized for 60FPS rendering on 100k+ datasets.
 * 
 * 1. DO NOT add O(N) linear loops or nested map/filter logic inside drawChart(). 
 * 2. DO NOT introduce new React state triggers that cause cascading frame drops. 
 * 3. ALL mathematical indicators MUST use flattened O(N) primitive math arrays.
 * 4. NEVER remove `draggable={false}` or the canvas native-drag block.
 * 5. ALWAYS read src/components/chart/CHART_ARCHITECTURE_RULES.md before editing.
 * ==============================================================================
 */
import React, { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react';
import { useUserPref } from '@/hooks/useUserPref';
import { getAssetType, isMarketOpenForPair, isUSEarlyClose, isCommodityEarlyClose, getExchangeFromSymbol, getExchangeInfo, getUKTime } from '@/lib/marketHours';
import ReactDOM from 'react-dom';
import { calculateEMA, calculateSMA, calculateSMMA, calculateBollingerBands, calculateRSI, calculateMACD, calculateATR, calculateStochastic, calculateWilliamsR, calculateCCI, calculateADX, calculateROC, calculateVWAP, calculateIchimoku, calculateParabolicSAR, calculateKeltnerChannels, calculateDailyPivots, calculateSupertrend, calculateDonchian, calculateAroon, calculateEnvelopes, calculateDEMA, calculateTEMA, calculateHMA, calculateMomentum, calculateAwesomeOscillator, calculateMFI, calculateTSI, calculateTRIX, calculateUltimateOscillator, calculateDPO, calculateKST, calculateStochRSI, calculateBBPercent, calculateBBWidth, calculateHistoricalVolatility, calculateChaikinVolatility, calculateStdDev, calculateOBV, calculateCMF, calculateADL, calculateForceIndex, calculateEOM, calculateVolumeSMA, calculateFibRetracement, calculateDailyCamarilla, calculateDailyWoodie, calculateCorrelation, calculateLinearRegression, calculateCoppock, calculateALMA, calculateKAMA, calculateZLEMA, calculateT3, calculateLSMA, calculateMcGinley, calculateVortex, calculateChoppiness, calculateElderRay, calculateMassIndex, calculateChandeKrollStop, calculateLinRegSlope, calculateWMA, calculatePriceChannel, calculateAlligator, calculatePPO, calculatePVO, calculateCMO, calculateFisherTransform, calculateSTC, calculateRVI, calculateKlingerOscillator, calculateConnorsRSI, calculateAPO, calculateQStick, calculateBOP, calculatePsychologicalLine, calculatePFE, calculateUlcerIndex, calculateNATR, calculateTrueRange, calculateSqueeze, calculateChandelierExit, calculateRelativeVolIndex, calculateVHF, calculateAccBands, calculateVWMA, calculateVolumeOsc, calculateNVI, calculatePVI, calculatePVT, calculateVROC, calculateNetVolume, calculateTwiggsMF, calculateLinRegRSquared, calculateMedianPrice, calculateTypicalPrice, calculateWeightedClose, calculateDeMarkPivots, calculateZigZag, calculateFractals, calculateGator, calculateSMI } from '@/lib/indicators';
import { evaluateFormula, type CustomIndicator } from '@/lib/formulaEngine';
import { MAType, IndicatorConfig } from './IndicatorSettings';
import IndicatorPanelSettings, { IndicatorType } from './IndicatorPanelSettings';
// Registry-driven legend metadata. Same migration ProChart got in Phase 3:
// the two charts used to hold identical 40+64 hand-typed indicator arrays,
// which drifted whenever a new indicator was added to only one. Now both
// read from INDICATOR_DISPLAY in indicatorRegistry.ts.
import {
  getOverlayIndicatorIds,
  getSubplotIndicatorIds,
  getLegendTitle,
} from './indicatorRegistry';
import { Settings, Eye, EyeOff, X, Trash2, MoreHorizontal } from 'lucide-react';
import { calculatePriceAxisWidth, formatPriceForSymbol } from '@/lib/utils';
import { getChartDeviceConfig, getDeviceFlags } from './deviceConfig';
import { RIGHT_TOOLBAR_WIDTH } from './RightToolbar';
import { EconomicEvent } from './ChartLeftSidebar';
import { getEventImpact } from '@/lib/eventImpact';
import { getFlagImage, preloadFlags } from './utils/flagImageCache';
import { apiGet } from '@/lib/api';
import type { Drawing } from './ChartDrawingOverlay';
// Core chart types, constants, and default colors extracted to core/types.ts
// to avoid duplication and enable sharing across chart components
import { type Candle, type ChartType, type ProChartProps, getDefaultColors, CANDLE_GAP_RATIO } from './core/types';
import { renderGenericSubplots, renderPhase2Overlays, renderSubplotSelectionDots, type SubplotRenderContext } from "./renderers/subplotRenderer";
import { renderOptionsPdfHeatmap, renderOrderBookHeatmap, renderL2DepthOverlay, type HeatmapRenderContext } from "./renderers/heatmapRenderer";
import { renderPositionLines, renderSelectedPositionSLTP, type PositionRenderContext } from "./renderers/positionRenderer";
import { renderCrosshair, type CrosshairContext } from "./renderers/crosshairRenderer";
import { renderSessions, type SessionRenderContext } from "./renderers/sessionRenderer";
import { useChartNavigation } from "./interaction/useChartNavigation";
import { useChartSettings } from '@/contexts/ChartSettingsContext';


// Re-export ChartType so existing imports from this file continue to work
export type { ChartType } from './core/types';

const ProChart: React.FC<ProChartProps> = ({
  candles,
  livePrice,
  symbol = '',
  timezone = 'UTC',
  countdown,
  onCrosshairMove,
  syncedCrosshairTime,
  colors: customColors,
  indicators,
  onIndicatorsChange,
  onConverterReady,
  onVisibleRangeChange,
  onViewportTimeChange,
  syncedViewportTime,
  disableAutoFollow = false,
  scrollToIndex,
  chartType = 'candlestick',
  onScrollingChange,
  onScrollSync,
  scrollOffsetRef,
  optionsPdfEnabled = false,
  heatmapEnabled = false,
  externalDimensions,
  economicEvents,
  positionLines,
  onPositionModify,
  onPositionClose,
  autoSelectPositionId,
  l2DepthData,
  onOpenSettings,
  onOpenCustomEditor,
  showBidAskSpread = false,
  showSessions = false,
  timeframe = '5m',
  rightOffset,
  onLoadMore,
  isLoadingMore = false,
  prependShift = 0,
  drawings,
  selectedDrawingId,
  drawingCursorRef,
  requestRedrawRef,
  isDrawingDragging = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);

  // Offscreen canvas for double-buffering: all drawing happens here first,
  // then gets blitted to the visible canvas in a single drawImage() call.
  // This eliminates "ghost chart" flicker caused by the visible canvas being
  // cleared before the new frame finishes drawing (which takes >16ms with
  // large datasets + many indicators, causing the browser to composite a
  // partially-drawn or blank canvas).
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Flag to prevent calling onCrosshairMove during synced crosshair updates
  const isSyncedUpdateRef = useRef(false);

  // Store syncedCrosshairTime in a ref so drawCrosshair always has the latest value
  const syncedCrosshairTimeRef = useRef<number | null | undefined>(syncedCrosshairTime ?? null);

  // Flag to prevent viewport time feedback loops
  const isSyncedViewportScrollRef = useRef(false);
  const lastReportedViewportTimeRef = useRef<number | null>(null);

  // Cap DPR at 2, not 3. iPhone 12 Pro Max (A14 GPU) can't rasterize 9x
  // pixel-count canvases within a 16.67ms frame during pinch rescales; the
  // Safari Web Inspector trace shows a uniform 60-80ms "Other" (GPU wait)
  // baseline per frame. At dpr=2 the backing store drops from 9x to 4x CSS
  // pixels (~55% less GPU fill work), fitting the A14's budget. iPhone 17
  // and Samsung show no perceptible quality loss at 2x; TradingView itself
  // caps at 2 for the same reason.
  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;

  // Initialize with fallback dimensions for iPhone Safari - prevents black screen
  // ResizeObserver will update to actual dimensions once container is laid out
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>({ width: 300, height: 300 });
  const [viewState, setViewState] = useState({
    startIndex: 0,
    candleWidth: 3, // Zoomed out default - shows more candles on first load
    // Backtest/replay: 10 candles of right margin so the current price badge and
    // last candle are not jammed against the y-axis. Live charts use 35 for event flags.
    futureSpace: disableAutoFollow ? 10 : 35,
    autoFollowLatest: !disableAutoFollow, // Start disabled if in replay mode
  });

  // Use refs for scroll state to avoid React re-renders during scrolling
  const scrollStateRef = useRef({
    startIndex: 0,
    candleWidth: 3,
  });
  const isScrollingRef = useRef(false);
  const lastScrollingNotifyRef = useRef(false);

  // SL/TP interactive drag state (refs for performance, no re-renders during drag)
  const selectedPositionRef = useRef<string | null>(null); // ID of selected position
  const slDraftRef = useRef<number | null>(null); // Draft SL price while dragging
  const tpDraftRef = useRef<number | null>(null); // Draft TP price while dragging
  const draggingHandleRef = useRef<'sl' | 'tp' | null>(null); // Which handle is being dragged
  const hoveredSLTPRef = useRef<'sl' | 'tp' | null>(null); // Which line cursor is hovering
  const lastTouchInteractionRef = useRef(0); // Timestamp of last touch-based SL/TP interaction
  const [, forceRender] = useState(0); // Force re-render when selection changes

  // Auto-select position from external trigger (e.g. after placing a trade on mobile)
  const lastAutoSelectIdRef = useRef<string | null>(null);
  useEffect(() => {
    // Only process each autoSelectPositionId ONCE; don't re-fire on positionLines polls
    if (autoSelectPositionId && autoSelectPositionId !== lastAutoSelectIdRef.current && positionLines) {
      const pos = positionLines.find(p => p.id === autoSelectPositionId);
      if (pos) {
        lastAutoSelectIdRef.current = autoSelectPositionId;
        selectedPositionRef.current = pos.id;
        slDraftRef.current = pos.stopLoss ?? null;
        tpDraftRef.current = pos.takeProfit ?? null;
        forceRender(n => n + 1);
      }
    }
  }, [autoSelectPositionId, positionLines]);

  // Track base scroll position for CSS transform offset calculation
  const baseScrollIndexRef = useRef(0);

  // Helper to update scrolling state and notify parent
  const setScrolling = useCallback((scrolling: boolean) => {
    isScrollingRef.current = scrolling;
    if (lastScrollingNotifyRef.current !== scrolling) {
      lastScrollingNotifyRef.current = scrolling;
      onScrollingChange?.(scrolling);

      // When scroll stops, reset the base position and clear offset
      if (!scrolling) {
        baseScrollIndexRef.current = scrollStateRef.current.startIndex;
        if (scrollOffsetRef) {
          scrollOffsetRef.current = 0;
        }
      }
    }
  }, [onScrollingChange, scrollOffsetRef]);

  // Scroll sync callback - called on each scroll frame to trigger drawing overlay CSS transform
  const notifyScrollSync = useCallback(() => {
    // Calculate pixel offset from base position
    if (scrollOffsetRef) {
      const currentIndex = scrollStateRef.current.startIndex;
      const candleSpacing = scrollStateRef.current.candleWidth * (1 + CANDLE_GAP_RATIO);
      const indexDelta = currentIndex - baseScrollIndexRef.current;
      scrollOffsetRef.current = indexDelta * candleSpacing;
    }
    onScrollSync?.();
  }, [onScrollSync, scrollOffsetRef]);

  // Ref to store the draw function for stable access during scroll
  const drawChartRef = useRef<((fastMode?: boolean) => void) | null>(null);
  const drawCrosshairRef = useRef<(() => void) | null>(null);

  // Ref to store the converter update function for calling during scroll
  const updateConverterRef = useRef<(() => void) | null>(null);

  const prevCandlesLengthRef = useRef<number>(0);
  const prevDimensionWidthRef = useRef<number>(0);
  const replayUserScrolledRef = useRef<boolean>(false);
  // Reliable timeframe-switch detection for the replay refit. Comparing candle
  // counts alone is asymmetric (a switch to a FINER timeframe grows the array,
  // so "count shrank" misses it), which left 5m looking zoomed in after a hop
  // up to 1W. The prop flag catches the switch in both directions; the refit
  // effect consumes and clears it.
  const prevReplayTfRef = useRef<string>(timeframe);
  const pendingTfRefitRef = useRef<boolean>(false);
  // Last bar's timestamp on the previous replay follow pass: tells appends
  // (feed advanced) apart from prepends (scrollback history loaded).
  const prevReplayLastTsRef = useRef<any>(null);
  // Previous replay candle array (reference retained one generation): the
  // view anchor bar is re-found in the new array by timestamp, which stays
  // exact through prepends, evictions and partial-bucket rewrites.
  const prevReplayCandlesRef = useRef<CandleData[] | null>(null);
  // Tracks the last-seen prependShift value. When the parent increments prependShift
  // (after loadMoreHistory prepends candles), we shift viewState.startIndex by the delta
  // so the user's visible view stays on the same candles (no visual jump).
  const prevPrependShiftRef = useRef(0);
  // Debounce ref for onLoadMore calls to prevent rapid-fire requests when user
  // continuously scrolls at the left edge of the chart
  const loadMoreDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrolledIndexRef = useRef<number | undefined>(undefined);
  const crosshairRef = useRef<{ x: number; y: number } | null>(null);

  // Heatmap State
  const [heatmapData, setHeatmapData] = useState<any[]>([]);
  const hoveredCandleIndexRef = useRef<number | null>(null);
  const crosshairRAFRef = useRef<number | null>(null);
  // Economic event marker hover + click-to-pin tracking
  const eventMarkerPositionsRef = useRef<Array<{ x: number; y: number; event: any; impact: string; ts: number; groupEvents?: Array<{ event: any; impact: string; ts: number }> }>>([]);
  const hoveredEventRef = useRef<{ event: any; impact: string; x: number; y: number; ts: number; groupEvents?: Array<{ event: any; impact: string; ts: number }> } | null>(null);
  const pinnedEventRef = useRef<{ event: any; impact: string; x: number; y: number; ts: number; groupEvents?: Array<{ event: any; impact: string; ts: number }> } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0, startIndex: 0, priceOffset: 0 });
  const [pulsePhase, setPulsePhase] = useState(0);
  const [livePriceOpacity, setLivePriceOpacity] = useState(1);
  const wheelRAFRef = useRef<number | null>(null);
  const scrollDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const macZoomAccumulatorRef = useRef(0); // Accumulate Mac trackpad zoom deltas
  const macZoomResetRef = useRef<NodeJS.Timeout | null>(null);

  // Long-press crosshair state for mobile (TradingView-style)
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [isCrosshairMode, setIsCrosshairMode] = useState(false);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const lastTapTimeRef = useRef<number>(0); // For double-tap detection
  const touchIdRef = useRef<number>(0); // Unique ID for each touch to prevent race conditions
  const isTouchDownRef = useRef<boolean>(false); // Track if finger is currently touching screen
  const recentTapCountRef = useRef<number>(0); // Count of recent rapid taps
  const tapCooldownRef = useRef<number>(0); // Block crosshair until this timestamp

  // Throttle refs for mobile panning performance
  const touchPanRAFRef = useRef<number | null>(null);
  const mouseDragRAFRef = useRef<number | null>(null);
  const sltpDragRAFRef = useRef<number | null>(null);
  const pendingStartIndexRef = useRef<number | null>(null);

  // SL/TP line cursor styles: ns-resize communicates vertical drag intent
  const sltpGrabCursor = 'ns-resize';
  const sltpDraggingCursor = 'ns-resize';

  // Zoom level tracking ref (discrete zoom steps - no animation)
  const currentZoomLevelRef = useRef<number>(12);

  // Counter for Mac trackpad zoom events (skip some to reduce sensitivity)
  const zoomEventCounterRef = useRef<number>(0);
  const zoomDeltaAccumulatorRef = useRef<number>(0);

  // Resizable indicator panel height (percentage of total height for indicators)
  const [indicatorHeightRatio, setIndicatorHeightRatio] = useState(0.15); // 15% for indicators initially
  const [isResizingIndicator, setIsResizingIndicator] = useState(false);
  const resizeStartRef = useRef({ y: 0, ratio: 0 });
  const livePriceLineRef = useRef<number | null>(null);

  // Y-axis drag-to-scale state
  const [priceScale, setPriceScale] = useState(1.0); // 1.0 = normal, <1 = compressed, >1 = expanded
  const [priceOffset, setPriceOffset] = useState(0); // Free panning offset for Y-axis
  const [fixedPriceCenter, setFixedPriceCenter] = useState<number | null>(null); // Locked center when in free mode
  const [fixedPriceRange, setFixedPriceRange] = useState<number | null>(null); // Locked range when in free mode
  const [isScalingYAxis, setIsScalingYAxis] = useState(false);
  const [isPanningYAxis, setIsPanningYAxis] = useState(false);
  const yAxisScaleStartRef = useRef({ y: 0, scale: 1.0, offset: 0 });
  const isYAxisFreeMode = fixedPriceCenter !== null; // User has entered free mode

  // Refs for smooth Y-axis panning/scaling (avoid React re-renders during interaction)
  const priceScaleRef = useRef(1.0);
  const priceOffsetRef = useRef(0);
  const yAxisDebounceRef = useRef<NodeJS.Timeout | null>(null);

  // CRITICAL: Store the EXACT price range used during chart rendering
  // The converter MUST use this same range to prevent drawings from drifting during scroll
  const renderedPriceRangeRef = useRef<{ min: number; max: number; range: number } | null>(null);
  const mainChartHeightRef = useRef<number>(0);
  // Track which indicator line the mouse is hovering near (for cursor changes)
  const hoveredIndicatorLineRef = useRef<string | null>(null);

  // OHLC visibility toggle
  // Persisted in chart_settings.settings.preferences.chartShowOHLC for
  // signed-in users; in-memory for anon. See useUserPref.
  const [showOHLC, setShowOHLC] = useUserPref<boolean>('preferences.chartShowOHLC', true);
  const [ohlcTextWidth, setOhlcTextWidth] = useState(0);
  const [sessionInfoOpen, setSessionInfoOpen] = useState(false);
  const [sessionTick, setSessionTick] = useState(0); // force re-render every minute
  const sessionInfoRef = useRef<HTMLDivElement>(null);
  const sessionControlHoveredRef = useRef(false); // prevents ohlcTextWidth flicker

  // Tick the session clock every 30 seconds so countdown stays live
  useEffect(() => {
    if (!sessionInfoOpen) return;
    const iv = setInterval(() => setSessionTick(t => t + 1), 30_000);
    return () => clearInterval(iv);
  }, [sessionInfoOpen]);

  // Pre-load flag images when economic events arrive
  useEffect(() => {
    if (economicEvents && economicEvents.length > 0) {
      preloadFlags(economicEvents.map(e => e.region_code));
    }
  }, [economicEvents]);

  // Close session popover on outside click
  useEffect(() => {
    if (!sessionInfoOpen) return;
    const handler = (e: MouseEvent) => {
      if (sessionInfoRef.current && !sessionInfoRef.current.contains(e.target as Node)) {
        setSessionInfoOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [sessionInfoOpen]);
  const [bbTextEndX, setBbTextEndX] = useState(0);
  const [maTextEndX, setMaTextEndX] = useState(0);
  const [vwapTextEndX, setVwapTextEndX] = useState(0);
  const [vpTextEndX, setVpTextEndX] = useState(0);
  const [volTextEndX, setVolTextEndX] = useState(0);
  const overlayLabelEndXRef = useRef<Record<string, number>>({});
  const [overlayLabelEndX, setOverlayLabelEndX] = useState<Record<string, number>>({});
  const subplotLabelEndXRef = useRef<Record<string, number>>({});
  const [subplotLabelEndX, setSubplotLabelEndX] = useState<Record<string, number>>({});

  // Options predicted price heatmap data (for all 55 tracked stocks)
  const [optionsPdfData, setOptionsPdfData] = useState<{
    currentPrice: number;
    predictedPrice: number;
    modePrice: number;
    direction: string;
    distancePct: number;
    probAbove: number;
    probBelow: number;
    confidence: number;
    densityCurve: { p: number; d: number }[];
  } | null>(null);

  // Selected indicator panel for settings
  const [selectedIndicator, setSelectedIndicator] = useState<{
    type: IndicatorType;
    position: { x: number; y: number };
  } | null>(null);

  // Track indicator panel boundaries for click detection
  const indicatorBoundsRef = useRef<Record<IndicatorType, { top: number; bottom: number }>>({} as any);

  // Track settings gear icon bounds for click detection (bottom-right corner)
  const settingsGearBoundsRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const isHoveringGearRef = useRef(false);

  // Track if hovering over indicator settings buttons (to preserve crosshair)
  const isHoveringSettingsRef = useRef(false);
  const mouseLeaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // TradingView-style hover toolbar: which indicator label row is hovered
  const [hoveredIndicatorKey, setHoveredIndicatorKey] = useState<string | null>(null);

  // TradingView-style click-to-select: which indicator label is clicked/highlighted
  const [clickedIndicatorKey, setClickedIndicatorKey] = useState<string | null>(null);

  // Right-click context menu for indicator labels
  const [indicatorContextMenu, setIndicatorContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    key: string;
    title: string;
  } | null>(null);

  // Scroll sensitivity (read from localStorage)
  // Default: Mac = 8, Windows = 2
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const [scrollSensitivity, setScrollSensitivity] = useState(isMac ? 8 : 2);

  // Detect if user is on MacBook/trackpad (high precision scrolling)
  const isMacRef = useRef(isMac);

  // Scroll sensitivity, grid density and other chart-appearance settings
  // come from ChartSettingsContext. The ref keeps the latest value
  // accessible from draw functions that aren't re-bound per render.
  const chartSettingsCtx = useChartSettings();
  const chartSettingsRef = useRef(chartSettingsCtx);
  chartSettingsRef.current = chartSettingsCtx;
  useEffect(() => {
    if (chartSettingsCtx.chart?.scrollSensitivity !== undefined) {
      setScrollSensitivity(chartSettingsCtx.chart.scrollSensitivity);
    }
  }, [chartSettingsCtx.chart?.scrollSensitivity]);

  const colors = { ...getDefaultColors(), ...customColors };
  // Detect dark mode for conditional rendering (session labels, etc.)
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  // Sync scrollStateRef when viewState changes (from non-wheel interactions)
  useEffect(() => {
    if (!isScrollingRef.current) {
      scrollStateRef.current = {
        startIndex: viewState.startIndex,
        candleWidth: viewState.candleWidth,
      };
    }
  }, [viewState.startIndex, viewState.candleWidth]);

  // Sync priceScale/priceOffset refs when state changes (from non-interaction sources)
  useEffect(() => {
    priceScaleRef.current = priceScale;
    priceOffsetRef.current = priceOffset;
  }, [priceScale, priceOffset]);

  // Reduced pulse frequency - only run when autoFollowLatest is true (live mode)
  useEffect(() => {
    if (!viewState.autoFollowLatest) return; // Skip animation when scrolled back
    const interval = setInterval(() => {
      setPulsePhase((prev) => (prev + 0.1) % (Math.PI * 2));
      setLivePriceOpacity(0.85 + Math.sin(Date.now() / 1000) * 0.15);
    }, 150); // Reduced frequency further
    return () => clearInterval(interval);
  }, [viewState.autoFollowLatest]);

  // Fetch predicted price data for heatmap overlay (all 55 tracked US stocks)
  useEffect(() => {
    // Map chart symbols to options underlying (handle forex/crypto/index -> stock proxies)
    const getUnderlying = (sym: string): string | null => {
      const upper = sym.toUpperCase().replace('_', '').replace('/', '');
      // Direct stock matches
      const stocks = ['SPY', 'QQQ', 'IWM', 'DIA', 'XLF', 'XLE', 'GLD', 'EEM', 'TLT', 'ARKK',
        'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA', 'NFLX', 'CRM', 'ORCL',
        'ADBE', 'AVGO', 'AMD', 'INTC', 'MU', 'QCOM', 'MRVL', 'ARM',
        'JPM', 'GS', 'BAC', 'C', 'V', 'MA', 'COIN', 'SOFI',
        'COST', 'WMT', 'NKE', 'SBUX', 'DIS', 'BA', 'CAT', 'XOM', 'CVX',
        'UNH', 'JNJ', 'PFE', 'LLY', 'ABBV', 'PLTR', 'SNAP', 'UBER', 'SQ', 'SHOP', 'RIOT', 'MARA'];
      for (const s of stocks) {
        if (upper === s || upper.startsWith(s)) return s;
      }
      // Proxy mappings for non-stock chart symbols
      if (upper.includes('XAU') || upper.includes('GOLD')) return 'GLD';
      if (upper.includes('SPX500') || upper.includes('SPX')) return 'SPY';
      if (upper.includes('NAS100') || upper.includes('NDX')) return 'QQQ';
      if (upper.includes('US30') || upper.includes('DJI')) return 'DIA';
      return null;
    };

    const underlying = getUnderlying(symbol);
    if (!underlying || !optionsPdfEnabled) {
      setOptionsPdfData(null);
      return;
    }

    const fetchPrediction = async () => {
      try {
        const API_BASE = 'https://api.londonstrategicedge.com';
        const API_KEY = '71f880e1d2ef471664f3b6c04c6dc1e618f94e51f68c87522bc6dcbc0ca173a5';

        const res = await fetch(
          `${API_BASE}/options_predicted_price?underlying=eq.${underlying}&limit=1`,
          { headers: { 'x-api-key': API_KEY } }
        );
        const data = await res.json();
        if (!data || data.length === 0) { setOptionsPdfData(null); return; }

        const pred = data[0];
        const chartPrice = candles[candles.length - 1]?.close || parseFloat(pred.current_price);
        // Scale factor for proxy symbols (e.g., GLD -> XAU/USD)
        const scaleFactor = underlying === 'GLD' ? chartPrice / parseFloat(pred.current_price) : 1;

        let densityCurve: { p: number; d: number }[] = [];
        if (pred.density_curve && Array.isArray(pred.density_curve)) {
          densityCurve = pred.density_curve.map((pt: { p: number; d: number }) => ({
            p: pt.p * scaleFactor, d: pt.d,
          }));
        }

        setOptionsPdfData({
          currentPrice: parseFloat(pred.current_price) * scaleFactor,
          predictedPrice: parseFloat(pred.predicted_price) * scaleFactor,
          modePrice: pred.mode_price ? parseFloat(pred.mode_price) * scaleFactor : parseFloat(pred.predicted_price) * scaleFactor,
          direction: pred.direction,
          distancePct: parseFloat(pred.distance_pct),
          probAbove: parseFloat(pred.prob_above || '0.5'),
          probBelow: parseFloat(pred.prob_below || '0.5'),
          confidence: parseFloat(pred.confidence || '0.5'),
          densityCurve,
        });
      } catch (err) {
        console.error('Failed to fetch predicted price:', err);
      }
    };

    fetchPrediction();
    const interval = setInterval(fetchPrediction, 60000);
    return () => clearInterval(interval);
  }, [symbol, optionsPdfEnabled]);

  // Fetch Order Book Heatmap data
  useEffect(() => {
    if (!heatmapEnabled || !symbol) {
      setHeatmapData([]);
      return;
    }

    const fetchHeatmap = async () => {
      try {
        const fullSymbol = symbol.includes('/') ? symbol : 
             (symbol.length === 6 ? `${symbol.substring(0,3)}/${symbol.substring(3)}` : symbol);
        
        // Fetch last 300 snapshots (5 mins of history if 1 snapshot/sec)
        const res = await apiGet<any[]>('l2_heatmap_snapshots', {
          params: { symbol: `eq.${fullSymbol}`, order: 'timestamp.desc', limit: '300' }
        });
        
        if (res && res.length > 0) {
          // Reverse so oldest is first
          setHeatmapData(res.reverse());
        }
      } catch (err) {
        console.error('Failed to fetch heatmap data:', err);
      }
    };

    fetchHeatmap();
    const interval = setInterval(fetchHeatmap, 5000); // Polling every 5s for now
    return () => clearInterval(interval);
  }, [symbol, heatmapEnabled]);

  // Cleanup RAFs on unmount
  useEffect(() => {
    return () => {
      if (wheelRAFRef.current !== null) {
        cancelAnimationFrame(wheelRAFRef.current);
      }
      if (crosshairRAFRef.current !== null) {
        cancelAnimationFrame(crosshairRAFRef.current);
      }
      if (touchPanRAFRef.current !== null) {
        cancelAnimationFrame(touchPanRAFRef.current);
      }
      if (mouseDragRAFRef.current !== null) {
        cancelAnimationFrame(mouseDragRAFRef.current);
      }
      if (sltpDragRAFRef.current !== null) {
        cancelAnimationFrame(sltpDragRAFRef.current);
      }
      if (scrollDebounceRef.current !== null) {
        clearTimeout(scrollDebounceRef.current);
      }
      if (yAxisDebounceRef.current !== null) {
        clearTimeout(yAxisDebounceRef.current);
      }
    };
  }, []);

  // Device flags + per-device layout config come from chart/deviceConfig.ts.
  // Same source of truth as ProChart, so the BT chain inherits any phone /
  // tablet / desktop tuning automatically.
  const { isPhone, isTablet, isDesktop } = getDeviceFlags(dimensions.width);
  const cfg = useMemo(() => getChartDeviceConfig(dimensions.width), [dimensions.width]);
  const isMobile = isPhone;

  // Calculate dynamic Y-axis width based on symbol's price format
  const samplePrice = livePrice || (candles.length > 0 ? candles[candles.length - 1]?.close : 100);
  const PRICE_AXIS_WIDTH = useMemo(() => {
    // Desktop gets larger axis for better readability with bigger fonts.
    // If rightOffset === 0, the RightToolbar is not overlaying the axis
    // (e.g. trading panel open pushes it away), so we collapse the toolbar gap.
    return calculatePriceAxisWidth(isMobile, symbol, samplePrice || 100, rightOffset);
  }, [isMobile, isDesktop, symbol, samplePrice, rightOffset]);

  // Axis chrome reads from the active device config block.
  const TIME_AXIS_HEIGHT = cfg.timeAxisHeight;
  const PRICE_LABEL_FONT = cfg.priceLabelFont;
  const TIME_LABEL_FONT = cfg.timeLabelFont;
  const SUBPLOT_LABEL_FONT = cfg.subplotLabelFont;

  const MIN_CANDLE_WIDTH = 1;
  const MAX_CANDLE_WIDTH = 50;

  // TradingView-style discrete zoom levels (~40 steps from min to max)
  // Using exponential scale for natural feel: each step is ~10% change
  const ZOOM_LEVELS = useMemo(() => {
    const levels: number[] = [];
    const steps = 40;
    const ratio = Math.pow(MAX_CANDLE_WIDTH / MIN_CANDLE_WIDTH, 1 / steps);
    for (let i = 0; i <= steps; i++) {
      levels.push(MIN_CANDLE_WIDTH * Math.pow(ratio, i));
    }
    return levels;
  }, []);

  // Get visible candles - use scrollStateRef when scrolling for instant updates
  const getVisibleCandles = useCallback((useScrollRef: boolean = false) => {
    const chartWidth = dimensions.width - PRICE_AXIS_WIDTH;
    const scrollState = useScrollRef && isScrollingRef.current ? scrollStateRef.current : viewState;
    const candleSpacing = scrollState.candleWidth * (1 + CANDLE_GAP_RATIO);
    const visibleCount = Math.floor(chartWidth / candleSpacing);

    const start = Math.max(0, Math.floor(scrollState.startIndex));
    const end = Math.min(candles.length, start + visibleCount);

    return {
      candles: candles.slice(start, end),
      startIndex: start,
      endIndex: end,
      visibleCount,
      totalWithFuture: visibleCount + viewState.futureSpace,
      candleWidth: scrollState.candleWidth,
    };
  }, [candles, dimensions.width, viewState]);

  // Notify parent of visible range changes for replay positioning
  useEffect(() => {
    if (candles.length > 0) {
      const chartWidth = dimensions.width - PRICE_AXIS_WIDTH;
      const candleSpacing = viewState.candleWidth * (1 + CANDLE_GAP_RATIO);
      const visibleCount = Math.floor(chartWidth / candleSpacing);
      const start = Math.max(0, Math.floor(viewState.startIndex));
      const end = Math.min(candles.length, start + visibleCount);
      if (onVisibleRangeChange) {
        onVisibleRangeChange({ startIndex: start, endIndex: end, totalCandles: candles.length });
      }

      // INFINITE SCROLLBACK: Prefetch 5k older candles when user scrolls within
      // 2500 candles of the left edge. This ensures the next batch is already loaded
      // by the time the user reaches it, so they never hit a wall or see lag.
      // Previously triggered at startIndex < 50 which caused a visible pause.
      // Debounce reduced to 100ms (from 500ms) since the fetch itself takes time
      // and we want to start it as early as possible.
      if (onLoadMore && start < 2500 && !isLoadingMore) {
        if (loadMoreDebounceRef.current) clearTimeout(loadMoreDebounceRef.current);
        loadMoreDebounceRef.current = setTimeout(() => {
          onLoadMore();
        }, 100);
      }
    }
  }, [onVisibleRangeChange, onLoadMore, isLoadingMore, candles.length, viewState.startIndex, viewState.candleWidth, dimensions.width]);

  // Report viewport center time when scrolling (for time sync across panels)
  useEffect(() => {
    if (!onViewportTimeChange || candles.length === 0) return;

    // Don't report if this scroll was triggered by sync from another panel
    if (isSyncedViewportScrollRef.current) {
      isSyncedViewportScrollRef.current = false;
      return;
    }

    const chartWidth = dimensions.width - PRICE_AXIS_WIDTH;
    const candleSpacing = viewState.candleWidth * (1 + CANDLE_GAP_RATIO);
    const visibleCount = Math.floor(chartWidth / candleSpacing);
    const start = Math.max(0, Math.floor(viewState.startIndex));
    const end = Math.min(candles.length, start + visibleCount);
    const visibleCandles = candles.slice(start, end);

    if (visibleCandles.length === 0) return;

    // Get the center candle's time
    const centerIndex = Math.floor(visibleCandles.length / 2);
    const centerCandle = visibleCandles[centerIndex];
    if (centerCandle && centerCandle.time !== lastReportedViewportTimeRef.current) {
      lastReportedViewportTimeRef.current = centerCandle.time;
      onViewportTimeChange(centerCandle.time);
    }
  }, [onViewportTimeChange, candles, viewState.startIndex, viewState.candleWidth, dimensions.width]);

  // Handle synced viewport time - scroll to show the synced time
  useEffect(() => {
    if (!syncedViewportTime || candles.length === 0) return;

    // Ignore if this is the same time we just reported
    if (syncedViewportTime === lastReportedViewportTimeRef.current) return;

    // Find the candle closest to the synced time
    let closestIndex = -1;
    let closestDiff = Infinity;

    for (let i = 0; i < candles.length; i++) {
      const diff = Math.abs(candles[i].time - syncedViewportTime);
      if (diff < closestDiff) {
        closestDiff = diff;
        closestIndex = i;
      }
    }

    if (closestIndex === -1) return;

    // Calculate visible count directly to avoid getVisibleCandles dependency
    const chartWidth = dimensions.width - PRICE_AXIS_WIDTH;
    const candleSpacing = viewState.candleWidth * (1 + CANDLE_GAP_RATIO);
    const visibleCount = Math.floor(chartWidth / candleSpacing);
    const currentStart = Math.max(0, Math.floor(viewState.startIndex));
    const currentEnd = Math.min(candles.length, currentStart + visibleCount);

    const halfVisible = Math.floor(visibleCount / 2);
    const targetStartIndex = Math.max(0, closestIndex - halfVisible);

    // Only scroll if the target candle is not already visible or needs repositioning
    const isCurrentlyVisible = closestIndex >= currentStart && closestIndex < currentEnd;
    const centerOfCurrent = currentStart + Math.floor(visibleCount / 2);
    const needsScroll = !isCurrentlyVisible || Math.abs(closestIndex - centerOfCurrent) > halfVisible / 2;

    if (needsScroll) {
      // Mark that this scroll is from sync to prevent feedback loop
      isSyncedViewportScrollRef.current = true;

      // Update the view state to scroll to the target
      setViewState(prev => ({
        ...prev,
        startIndex: targetStartIndex,
        autoFollowLatest: false,
      }));

      scrollStateRef.current.startIndex = targetStartIndex;
    }
  }, [syncedViewportTime, candles, dimensions.width, viewState.candleWidth, viewState.startIndex]);

  const getPriceRange = useCallback((visibleCandles: Candle[], includeCurrentPrice: boolean = true) => {
    // If in free mode, use the fixed center and range - allows unlimited panning
    // Use refs for smooth updates during interaction (avoids needing React state)
    if (fixedPriceCenter !== null && fixedPriceRange !== null) {
      const currentScale = priceScaleRef.current;
      const currentOffset = priceOffsetRef.current;
      const scaledRange = fixedPriceRange / currentScale;
      const offsetCenter = fixedPriceCenter + currentOffset;

      return {
        min: offsetCenter - scaledRange / 2,
        max: offsetCenter + scaledRange / 2,
        range: scaledRange,
      };
    }

    // Auto mode: calculate from visible candles
    if (visibleCandles.length === 0) {
      return { min: 0, max: 100, range: 100 };
    }

    let min = Infinity;
    let max = -Infinity;

    for (const c of visibleCandles) {
      if (c.low < min) min = c.low;
      if (c.high > max) max = c.high;
    }

    // DEBUG: Log when range is suspiciously wide (more than 5x the median candle range)
    // This helps identify data spikes or bad candle values stretching the y-axis
    if (visibleCandles.length > 5) {
      const ranges = visibleCandles.map(c => c.high - c.low).sort((a, b) => a - b);
      const median = ranges[Math.floor(ranges.length / 2)];
      if (median > 0 && (max - min) > median * 50) {
        const outliers = visibleCandles.filter(c => c.high > min + (max - min) * 0.8 || c.low < min + (max - min) * 0.2);
        console.warn('[BTChart] Y-axis range suspiciously wide:', { min, max, range: max - min, median, visibleCount: visibleCandles.length, outlierSample: outliers.slice(0, 3).map(c => ({ o: c.open, h: c.high, l: c.low, c: c.close, t: c.time })) });
      }
    }

    // Only include live price in range when following latest (not scrolled back)
    if (includeCurrentPrice && livePrice) {
      if (livePrice < min) min = livePrice;
      if (livePrice > max) max = livePrice;
    }

    const range = max - min;
    const padding = range * 0.05;
    const midpoint = (max + min) / 2;
    const paddedRange = range + padding * 2;

    return {
      min: midpoint - paddedRange / 2,
      max: midpoint + paddedRange / 2,
      range: paddedRange,
    };
  }, [livePrice, fixedPriceCenter, fixedPriceRange]);

  const priceToY = useCallback((price: number, priceRange: { min: number; max: number; range: number }) => {
    // Calculate main chart height accounting for ALL indicator subplot panels
    // All indicator keys that render as subplots (below the main chart).
    // Phase 2 keys MUST be included here or the chart won't allocate height for them.
    const subplotKeys = [
      'rsi', 'macd', 'atr', 'stochastic', 'williamsR', 'cci', 'adx', 'roc',
      'aroon', 'momentum', 'ao', 'mfi', 'tsi', 'trix', 'ultimateOsc', 'dpo', 'kst', 'stochRsi',
      'bbPercent', 'bbWidth', 'histVol', 'chaikinVol', 'stdDev',
      'obv', 'cmf', 'adl', 'forceIndex', 'eom', 'correlation', 'coppock',
      // Phase 2 subplots
      'vortex', 'choppiness', 'elderRay', 'massIndex', 'linRegSlope',
      'ppo', 'pvo', 'cmo', 'fisher', 'stc', 'rviOsc', 'klinger', 'connorsRsi',
      'apo', 'qstick', 'bop', 'psychLine', 'pfe', 'smi',
      'ulcerIndex', 'natr', 'trueRange', 'squeeze', 'relVolIndex', 'vhf',
      'volumeOsc', 'nvi', 'pvi', 'pvt', 'vroc', 'netVolume', 'twiggsMF',
      'linRegRSquared', 'gator',
    ] as const;
    const numSubplots = subplotKeys.filter(k => (indicators as any)?.[k]?.enabled).length;
    const availableHeight = dimensions.height - TIME_AXIS_HEIGHT;
    const totalIndicatorHeight = numSubplots > 0
      ? Math.max(60 * numSubplots, availableHeight * indicatorHeightRatio)
      : 0;
    const mainChartHeight = availableHeight - totalIndicatorHeight;

    return mainChartHeight - ((price - priceRange.min) / priceRange.range) * mainChartHeight;
  }, [dimensions.height, indicators, candles, indicatorHeightRatio]);

  const yToPrice = useCallback((y: number, priceRange: { min: number; max: number; range: number }) => {
    // Calculate main chart height accounting for ALL indicator subplot panels
    const subplotKeys = [
      'rsi', 'macd', 'atr', 'stochastic', 'williamsR', 'cci', 'adx', 'roc',
      'aroon', 'momentum', 'ao', 'mfi', 'tsi', 'trix', 'ultimateOsc', 'dpo', 'kst', 'stochRsi',
      'bbPercent', 'bbWidth', 'histVol', 'chaikinVol', 'stdDev',
      'obv', 'cmf', 'adl', 'forceIndex', 'eom', 'correlation', 'coppock',
      'vortex', 'choppiness', 'elderRay', 'massIndex', 'linRegSlope',
      'ppo', 'pvo', 'cmo', 'fisher', 'stc', 'rviOsc', 'klinger', 'connorsRsi',
      'apo', 'qstick', 'bop', 'psychLine', 'pfe', 'smi',
      'ulcerIndex', 'natr', 'trueRange', 'squeeze', 'relVolIndex', 'vhf',
      'volumeOsc', 'nvi', 'pvi', 'pvt', 'vroc', 'netVolume', 'twiggsMF',
      'linRegRSquared', 'gator',
    ] as const;
    const numSubplots = subplotKeys.filter(k => (indicators as any)?.[k]?.enabled).length;
    const availableHeight = dimensions.height - TIME_AXIS_HEIGHT;
    const totalIndicatorHeight = numSubplots > 0
      ? Math.max(60 * numSubplots, availableHeight * indicatorHeightRatio)
      : 0;
    const mainChartHeight = availableHeight - totalIndicatorHeight;

    return priceRange.max - (y / mainChartHeight) * priceRange.range;
  }, [dimensions.height, indicators, candles, indicatorHeightRatio]);

  const indexToX = useCallback((index: number, startIndex: number) => {
    const candleSpacing = viewState.candleWidth * (1 + CANDLE_GAP_RATIO);
    return (index - startIndex) * candleSpacing + candleSpacing / 2;
  }, [viewState.candleWidth]);

  const xToIndex = useCallback((x: number, startIndex: number) => {
    const candleSpacing = viewState.candleWidth * (1 + CANDLE_GAP_RATIO);
    return Math.floor(x / candleSpacing) + startIndex;
  }, [viewState.candleWidth]);

  // Delegate to the shared formatting function in utils.ts so that the
  // axis-width calculation and label rendering always agree on string length.
  const formatPrice = useCallback((price: number) => {
    return formatPriceForSymbol(price, symbol);
    // No source named: this chart replays a source that declares no digits
    // (the manual backtest's), so it reads none (setPriceDigits).
  }, [symbol]);

  const formatTime = useCallback((timestamp: number) => {
    const date = new Date(timestamp);
    if (timezone === 'local') {
      const hours = date.getHours().toString().padStart(2, '0');
      const minutes = date.getMinutes().toString().padStart(2, '0');
      return `${hours}:${minutes}`;
    } else if (timezone === 'UTC') {
      const hours = date.getUTCHours().toString().padStart(2, '0');
      const minutes = date.getUTCMinutes().toString().padStart(2, '0');
      return `${hours}:${minutes}`;
    } else {
      // Use Intl.DateTimeFormat for named timezones
      try {
        return date.toLocaleTimeString('en-GB', {
          timeZone: timezone,
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        });
      } catch {
        const hours = date.getUTCHours().toString().padStart(2, '0');
        const minutes = date.getUTCMinutes().toString().padStart(2, '0');
        return `${hours}:${minutes}`;
      }
    }
  }, [timezone]);

  const formatDate = useCallback((timestamp: number, includeYear: boolean = false) => {
    const date = new Date(timestamp);
    if (timezone === 'local') {
      const day = date.getDate();
      const month = date.toLocaleString('en', { month: 'short' });
      const year = String(date.getFullYear()).slice(-2); // '24 format
      return includeYear ? `${day} ${month} '${year}` : `${day} ${month}`;
    } else if (timezone === 'UTC') {
      const day = date.getUTCDate();
      const month = date.toLocaleString('en', { month: 'short', timeZone: 'UTC' });
      const year = String(date.getUTCFullYear()).slice(-2); // '24 format
      return includeYear ? `${day} ${month} '${year}` : `${day} ${month}`;
    } else {
      try {
        const day = date.toLocaleDateString('en-GB', { timeZone: timezone, day: 'numeric' });
        const month = date.toLocaleDateString('en-GB', { timeZone: timezone, month: 'short' });
        const year = date.toLocaleDateString('en-GB', { timeZone: timezone, year: '2-digit' });
        return includeYear ? `${day} ${month} '${year}` : `${day} ${month}`;
      } catch {
        const day = date.getUTCDate();
        const month = date.toLocaleString('en', { month: 'short', timeZone: 'UTC' });
        const year = String(date.getUTCFullYear()).slice(-2);
        return includeYear ? `${day} ${month} '${year}` : `${day} ${month}`;
      }
    }
  }, [timezone]);

  const calculateNiceStep = (range: number, targetSteps: number) => {
    const roughStep = range / targetSteps;
    const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
    const normalized = roughStep / magnitude;

    let niceStep;
    if (normalized <= 1) niceStep = 1;
    else if (normalized <= 2) niceStep = 2;
    else if (normalized <= 5) niceStep = 5;
    else niceStep = 10;

    return niceStep * magnitude;
  };

  // Cached price arrays: stored in refs so we can reuse them across useMemo
  // invocations. When candles change, we compare lengths and first/last timestamps
  // to decide whether to do a full rebuild or an incremental append. This avoids
  // creating 6 x N temporary arrays (2.4 MB for 50K candles) on every tick,
  // which otherwise causes heavy GC pressure and frame drops.
  const priceArrayCacheRef = useRef<{
    candles: typeof candles;
    closes: number[];
    highs: number[];
    lows: number[];
    opens: number[];
    volumes: number[];
    timestamps: number[];
  } | null>(null);

  // Stores the last successfully computed indicator data. Used to skip expensive
  // recomputation during active scrolling (when isScrollingRef.current is true).
  // History prepends create a new candles array which triggers this useMemo, but
  // recomputing 50+ indicators on 50K+ candles takes 30-50ms, blocking the scroll
  // RAF and causing stutter. By returning the cached result during scroll, we keep
  // scroll at 60fps. The indicators catch up when scrolling stops (debounce fires
  // setViewState -> re-render -> useMemo runs with isScrollingRef.current = false).
  const indicatorDataCacheRef = useRef<any>(null);
  // Track which candles array the cached indicators were computed from, so we know
  // when a real recompute is needed (symbol switch vs. history append during scroll)
  const indicatorCandlesIdRef = useRef<number>(0);

  // Calculate indicator data once
  const indicatorData = useMemo(() => {
    if (!indicators || candles.length === 0) return null;

    // DEFER during active scroll: recomputing indicators on a 50K+ candle array
    // takes 30-50ms which blocks the scroll RAF and causes visible stutter.
    // Return the cached result instead; indicators will recompute when scrolling
    // stops and the 150ms debounce fires setViewState -> re-render.
    // BUT: never return stale cache after a symbol switch. Use first candle's
    // close price as a fingerprint: if it changed, the data is for a different
    // symbol and the cache is stale. Without this check, switching from BTC to
    // GBP while mid-scroll would render BTC's EMA (price ~70K) on GBP's chart
    // (price ~1.35), making the indicator invisible (drawn off-screen).
    const candleFingerprint = candles.length > 0 ? candles[0].close : 0;
    if (isScrollingRef.current && indicatorDataCacheRef.current
        && indicatorCandlesIdRef.current === candleFingerprint) {
      return indicatorDataCacheRef.current;
    }

    // Reuse cached price arrays when possible. Full rebuild only when the candles
    // array is a completely different dataset (symbol switch, history prepend).
    // When just a few new ticks arrive (same base, larger length), we append
    // only the new values to the existing arrays, avoiding O(n) .map() calls.
    const cache = priceArrayCacheRef.current;
    let closes: number[];
    let highs: number[];
    let lows: number[];
    let opens: number[];
    let volumes: number[];
    let timestamps: number[];

    const canAppend = cache
      && cache.candles !== candles                        // reference changed (new data arrived)
      && candles.length >= cache.closes.length            // dataset grew (not shrunk/replaced)
      && candles.length > 0 && cache.closes.length > 0
      && candles[0].time === cache.timestamps[0]          // same starting point (no prepend/symbol switch)
      && cache.closes.length > 10;                        // enough data to make append worthwhile

    if (canAppend) {
      // Incremental append: only extract the new tail candles
      const prevLen = cache!.closes.length;
      // Re-copy the last candle too in case it was updated in-place (live tick)
      const startIdx = Math.max(0, prevLen - 1);
      closes = cache!.closes;
      highs = cache!.highs;
      lows = cache!.lows;
      opens = cache!.opens;
      volumes = cache!.volumes;
      timestamps = cache!.timestamps;
      // Trim to startIdx and append new values
      closes.length = startIdx;
      highs.length = startIdx;
      lows.length = startIdx;
      opens.length = startIdx;
      volumes.length = startIdx;
      timestamps.length = startIdx;
      for (let i = startIdx; i < candles.length; i++) {
        const c = candles[i];
        closes.push(c.close);
        highs.push(c.high);
        lows.push(c.low);
        opens.push(c.open);
        volumes.push(c.volume || 0);
        timestamps.push(c.time);
      }
    } else {
      // Full rebuild: new symbol, history prepend, or first load
      closes = candles.map(c => c.close);
      highs = candles.map(c => c.high);
      lows = candles.map(c => c.low);
      opens = candles.map(c => c.open);
      volumes = candles.map(c => c.volume || 0);
      timestamps = candles.map(c => c.time);
    }

    // Store in cache for next invocation
    priceArrayCacheRef.current = { candles, closes, highs, lows, opens, volumes, timestamps };

    // Calculate moving averages from new combined config
    let maLines: { data: number[]; color: string; name: string }[] | null = null;
    if (indicators.movingAverages?.enabled && indicators.movingAverages.lines?.length > 0) {
      maLines = indicators.movingAverages.lines.map((line: { type: MAType; period: number; color: string }) => {
        let data: number[];
        switch (line.type) {
          case 'SMA':
            data = calculateSMA(closes, line.period);
            break;
          case 'SMMA':
            data = calculateSMMA(closes, line.period);
            break;
          case 'EMA':
          default:
            data = calculateEMA(closes, line.period);
            break;
        }
        return { data, color: line.color, name: `${line.type} ${line.period}` };
      });
    }

    const result = {
      rsi: indicators.rsi?.enabled ? calculateRSI(closes, indicators.rsi.period) : null,
      macd: indicators.macd?.enabled ? calculateMACD(closes, indicators.macd.fast, indicators.macd.slow, indicators.macd.signal) : null,
      ema: indicators.ema?.enabled ? indicators.ema.periods.map((p: number) => calculateEMA(closes, p)) : null,
      bollinger: indicators.bollinger?.enabled ? calculateBollingerBands(closes, indicators.bollinger.period, indicators.bollinger.stdDev) : null,
      movingAverages: maLines,
      atr: indicators.atr?.enabled ? calculateATR(highs, lows, closes, indicators.atr.period) : null,
      stochastic: indicators.stochastic?.enabled ? calculateStochastic(highs, lows, closes, indicators.stochastic.kPeriod, indicators.stochastic.dPeriod, indicators.stochastic.smooth) : null,
      williamsR: indicators.williamsR?.enabled ? calculateWilliamsR(highs, lows, closes, indicators.williamsR.period) : null,
      cci: indicators.cci?.enabled ? calculateCCI(highs, lows, closes, indicators.cci.period) : null,
      adx: indicators.adx?.enabled ? calculateADX(highs, lows, closes, indicators.adx.period) : null,
      roc: indicators.roc?.enabled ? calculateROC(closes, indicators.roc.period) : null,
      vwap: indicators.vwap?.enabled ? calculateVWAP(highs, lows, closes, volumes, timestamps) : null,
      ichimoku: indicators.ichimoku?.enabled ? calculateIchimoku(highs, lows, closes, indicators.ichimoku.tenkanPeriod, indicators.ichimoku.kijunPeriod, indicators.ichimoku.senkouBPeriod, indicators.ichimoku.displacement) : null,
      parabolicSAR: indicators.parabolicSAR?.enabled ? calculateParabolicSAR(highs, lows, indicators.parabolicSAR.afStart, indicators.parabolicSAR.afStep, indicators.parabolicSAR.afMax) : null,
      keltner: indicators.keltner?.enabled ? calculateKeltnerChannels(highs, lows, closes, indicators.keltner.emaPeriod, indicators.keltner.atrPeriod, indicators.keltner.multiplier) : null,
      pivotPoints: indicators.pivotPoints?.enabled ? calculateDailyPivots(timestamps, highs, lows, closes) : null,
      // ── Expanded indicators ──
      supertrend: indicators.supertrend?.enabled ? calculateSupertrend(highs, lows, closes, indicators.supertrend.period, indicators.supertrend.multiplier) : null,
      donchian: indicators.donchian?.enabled ? calculateDonchian(highs, lows, indicators.donchian.period) : null,
      aroon: indicators.aroon?.enabled ? calculateAroon(highs, lows, indicators.aroon.period) : null,
      envelopes: indicators.envelopes?.enabled ? calculateEnvelopes(closes, indicators.envelopes.period, indicators.envelopes.percent) : null,
      dema: indicators.dema?.enabled ? calculateDEMA(closes, indicators.dema.period) : null,
      tema: indicators.tema?.enabled ? calculateTEMA(closes, indicators.tema.period) : null,
      hma: indicators.hma?.enabled ? calculateHMA(closes, indicators.hma.period) : null,
      momentum: indicators.momentum?.enabled ? calculateMomentum(closes, indicators.momentum.period) : null,
      ao: indicators.ao?.enabled ? calculateAwesomeOscillator(highs, lows) : null,
      mfi: indicators.mfi?.enabled ? calculateMFI(highs, lows, closes, volumes, indicators.mfi.period) : null,
      tsi: indicators.tsi?.enabled ? calculateTSI(closes, indicators.tsi.longPeriod, indicators.tsi.shortPeriod, indicators.tsi.signalPeriod) : null,
      trix: indicators.trix?.enabled ? calculateTRIX(closes, indicators.trix.period, indicators.trix.signalPeriod) : null,
      ultimateOsc: indicators.ultimateOsc?.enabled ? calculateUltimateOscillator(highs, lows, closes, indicators.ultimateOsc.fast, indicators.ultimateOsc.med, indicators.ultimateOsc.slow) : null,
      dpo: indicators.dpo?.enabled ? calculateDPO(closes, indicators.dpo.period) : null,
      kst: indicators.kst?.enabled ? calculateKST(closes) : null,
      stochRsi: indicators.stochRsi?.enabled ? calculateStochRSI(closes, indicators.stochRsi.rsiPeriod, indicators.stochRsi.kPeriod, indicators.stochRsi.dPeriod) : null,
      bbPercent: indicators.bbPercent?.enabled ? calculateBBPercent(closes, indicators.bbPercent.period, indicators.bbPercent.stdDev) : null,
      bbWidth: indicators.bbWidth?.enabled ? calculateBBWidth(closes, indicators.bbWidth.period, indicators.bbWidth.stdDev) : null,
      histVol: indicators.histVol?.enabled ? calculateHistoricalVolatility(closes, indicators.histVol.period) : null,
      chaikinVol: indicators.chaikinVol?.enabled ? calculateChaikinVolatility(highs, lows, indicators.chaikinVol.emaPeriod, indicators.chaikinVol.rocPeriod) : null,
      stdDev: indicators.stdDev?.enabled ? calculateStdDev(closes, indicators.stdDev.period) : null,
      obv: indicators.obv?.enabled ? calculateOBV(closes, volumes) : null,
      cmf: indicators.cmf?.enabled ? calculateCMF(highs, lows, closes, volumes, indicators.cmf.period) : null,
      adl: indicators.adl?.enabled ? calculateADL(highs, lows, closes, volumes) : null,
      forceIndex: indicators.forceIndex?.enabled ? calculateForceIndex(closes, volumes, indicators.forceIndex.period) : null,
      eom: indicators.eom?.enabled ? calculateEOM(highs, lows, volumes, indicators.eom.period) : null,
      volumeSma: indicators.volumeSma?.enabled ? calculateVolumeSMA(volumes, indicators.volumeSma.period) : null,
      fibRetracement: indicators.fibRetracement?.enabled ? calculateFibRetracement(highs, lows, indicators.fibRetracement.lookback) : null,
      camarillaPivots: indicators.camarillaPivots?.enabled ? calculateDailyCamarilla(timestamps, highs, lows, closes) : null,
      woodiePivots: indicators.woodiePivots?.enabled ? calculateDailyWoodie(timestamps, highs, lows, closes) : null,
      correlation: indicators.correlation?.enabled ? calculateCorrelation(closes, volumes, indicators.correlation.period) : null,
      linearReg: indicators.linearReg?.enabled ? calculateLinearRegression(closes, indicators.linearReg.period, indicators.linearReg.deviations) : null,
      coppock: indicators.coppock?.enabled ? calculateCoppock(closes, indicators.coppock.longROC, indicators.coppock.shortROC, indicators.coppock.wmaPeriod) : null,
      // ── Phase 2: New Indicator Computations ──
      // Trend overlays
      alma: indicators.alma?.enabled ? calculateALMA(closes, indicators.alma.period, indicators.alma.offset, indicators.alma.sigma) : null,
      kama: indicators.kama?.enabled ? calculateKAMA(closes, indicators.kama.period, indicators.kama.fastPeriod, indicators.kama.slowPeriod) : null,
      zlema: indicators.zlema?.enabled ? calculateZLEMA(closes, indicators.zlema.period) : null,
      t3: indicators.t3?.enabled ? calculateT3(closes, indicators.t3.period, indicators.t3.vFactor) : null,
      lsma: indicators.lsma?.enabled ? calculateLSMA(closes, indicators.lsma.period) : null,
      mcginley: indicators.mcginley?.enabled ? calculateMcGinley(closes, indicators.mcginley.period) : null,
      wma: indicators.wma?.enabled ? calculateWMA(closes, indicators.wma.period) : null,
      smmaOverlay: indicators.smmaOverlay?.enabled ? calculateSMMA(closes, indicators.smmaOverlay.period) : null,
      alligator: indicators.alligator?.enabled ? calculateAlligator(closes) : null,
      priceChannel: indicators.priceChannel?.enabled ? calculatePriceChannel(highs, lows, indicators.priceChannel.period) : null,
      chandeKroll: indicators.chandeKroll?.enabled ? calculateChandeKrollStop(highs, lows, closes, indicators.chandeKroll.p, indicators.chandeKroll.q, indicators.chandeKroll.x) : null,
      chandelierExit: indicators.chandelierExit?.enabled ? calculateChandelierExit(highs, lows, closes, indicators.chandelierExit.period, indicators.chandelierExit.multiplier) : null,
      accBands: indicators.accBands?.enabled ? calculateAccBands(highs, lows, closes, indicators.accBands.period) : null,
      // Trend subplots
      vortex: indicators.vortex?.enabled ? calculateVortex(highs, lows, closes, indicators.vortex.period) : null,
      choppiness: indicators.choppiness?.enabled ? calculateChoppiness(highs, lows, closes, indicators.choppiness.period) : null,
      elderRay: indicators.elderRay?.enabled ? calculateElderRay(highs, lows, closes, indicators.elderRay.period) : null,
      massIndex: indicators.massIndex?.enabled ? calculateMassIndex(highs, lows, indicators.massIndex.period) : null,
      linRegSlope: indicators.linRegSlope?.enabled ? calculateLinRegSlope(closes, indicators.linRegSlope.period) : null,
      // Oscillators
      ppo: indicators.ppo?.enabled ? calculatePPO(closes, indicators.ppo.fast, indicators.ppo.slow, indicators.ppo.signal) : null,
      pvo: indicators.pvo?.enabled ? calculatePVO(volumes, indicators.pvo.fast, indicators.pvo.slow, indicators.pvo.signal) : null,
      cmo: indicators.cmo?.enabled ? calculateCMO(closes, indicators.cmo.period) : null,
      fisher: indicators.fisher?.enabled ? calculateFisherTransform(highs, lows, indicators.fisher.period) : null,
      stc: indicators.stc?.enabled ? calculateSTC(closes, indicators.stc.fast, indicators.stc.slow, indicators.stc.cycle) : null,
      rviOsc: indicators.rviOsc?.enabled ? calculateRVI(opens, highs, lows, closes, indicators.rviOsc.period) : null,
      klinger: indicators.klinger?.enabled ? calculateKlingerOscillator(highs, lows, closes, volumes, indicators.klinger.fast, indicators.klinger.slow, indicators.klinger.signal) : null,
      connorsRsi: indicators.connorsRsi?.enabled ? calculateConnorsRSI(closes, indicators.connorsRsi.rsiPeriod, indicators.connorsRsi.streakPeriod, indicators.connorsRsi.rankPeriod) : null,
      apo: indicators.apo?.enabled ? calculateAPO(closes, indicators.apo.fast, indicators.apo.slow) : null,
      qstick: indicators.qstick?.enabled ? calculateQStick(opens, closes, indicators.qstick.period) : null,
      bop: indicators.bop?.enabled ? calculateBOP(opens, highs, lows, closes, indicators.bop.period) : null,
      psychLine: indicators.psychLine?.enabled ? calculatePsychologicalLine(closes, indicators.psychLine.period) : null,
      pfe: indicators.pfe?.enabled ? calculatePFE(closes, indicators.pfe.period, indicators.pfe.smoothing) : null,
      smi: indicators.smi?.enabled ? calculateSMI(highs, lows, closes, indicators.smi.period, indicators.smi.smoothK, indicators.smi.smoothD) : null,
      // Volatility
      ulcerIndex: indicators.ulcerIndex?.enabled ? calculateUlcerIndex(closes, indicators.ulcerIndex.period) : null,
      natr: indicators.natr?.enabled ? calculateNATR(highs, lows, closes, indicators.natr.period) : null,
      trueRange: indicators.trueRange?.enabled ? calculateTrueRange(highs, lows, closes) : null,
      squeeze: indicators.squeeze?.enabled ? calculateSqueeze(highs, lows, closes, indicators.squeeze.bbPeriod, indicators.squeeze.bbMult, indicators.squeeze.kcPeriod, indicators.squeeze.kcMult) : null,
      relVolIndex: indicators.relVolIndex?.enabled ? calculateRelativeVolIndex(closes, indicators.relVolIndex.period, indicators.relVolIndex.smoothing) : null,
      vhf: indicators.vhf?.enabled ? calculateVHF(closes, indicators.vhf.period) : null,
      // Volume
      vwma: indicators.vwma?.enabled ? calculateVWMA(closes, volumes, indicators.vwma.period) : null,
      volumeOsc: indicators.volumeOsc?.enabled ? calculateVolumeOsc(volumes, indicators.volumeOsc.fast, indicators.volumeOsc.slow) : null,
      nvi: indicators.nvi?.enabled ? calculateNVI(closes, volumes) : null,
      pvi: indicators.pvi?.enabled ? calculatePVI(closes, volumes) : null,
      pvt: indicators.pvt?.enabled ? calculatePVT(closes, volumes) : null,
      vroc: indicators.vroc?.enabled ? calculateVROC(volumes, indicators.vroc.period) : null,
      netVolume: indicators.netVolume?.enabled ? calculateNetVolume(closes, volumes, indicators.netVolume.period) : null,
      twiggsMF: indicators.twiggsMF?.enabled ? calculateTwiggsMF(highs, lows, closes, volumes, indicators.twiggsMF.period) : null,
      // Statistics
      linRegRSquared: indicators.linRegRSquared?.enabled ? calculateLinRegRSquared(closes, indicators.linRegRSquared.period) : null,
      medianPrice: indicators.medianPrice?.enabled ? calculateMedianPrice(highs, lows) : null,
      typicalPrice: indicators.typicalPrice?.enabled ? calculateTypicalPrice(highs, lows, closes) : null,
      weightedClose: indicators.weightedClose?.enabled ? calculateWeightedClose(highs, lows, closes) : null,
      demarkPivots: indicators.demarkPivots?.enabled ? calculateDeMarkPivots(timestamps, highs, lows, opens, closes) : null,
      zigzag: indicators.zigzag?.enabled ? calculateZigZag(highs, lows, closes, indicators.zigzag.deviation) : null,
      fractals: indicators.fractals?.enabled ? calculateFractals(highs, lows) : null,
      gator: indicators.gator?.enabled ? calculateGator(closes) : null,
      // ── Custom formula indicators ──
      customIndicators: (indicators.customIndicators || []).filter(ci => ci.enabled).map(ci => {
        const ctx = { closes, highs, lows, opens, volumes, timestamps };
        const result = evaluateFormula(ci.expression, ctx);
        return { ...ci, data: result.errors.length === 0 ? result.data : new Array(closes.length).fill(NaN) };
      }),
    };

    // Cache the computed result so scroll-deferred frames can reuse it.
    // Also store the candle fingerprint so we can detect symbol switches
    // and invalidate the cache instead of returning stale indicator data.
    indicatorDataCacheRef.current = result;
    indicatorCandlesIdRef.current = candles.length > 0 ? candles[0].close : 0;
    return result;
  }, [candles, indicators]);

  const drawChart = useCallback((fastMode: boolean = false) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { width, height } = dimensions;

    // Double-buffering: draw to an offscreen canvas first, then blit to visible
    // canvas in one atomic drawImage() call. Without this, the visible canvas is
    // cleared (fillRect background) before the new frame is fully drawn. When the
    // draw takes >16ms (large datasets, many indicators), the browser composites
    // the half-drawn canvas, causing a "ghost chart" flash. Drawing offscreen
    // ensures the user only ever sees complete frames.
    if (!offscreenCanvasRef.current) {
      offscreenCanvasRef.current = document.createElement('canvas');
    }
    const offCanvas = offscreenCanvasRef.current;
    // Match the offscreen canvas buffer size to the visible canvas
    if (offCanvas.width !== canvas.width || offCanvas.height !== canvas.height) {
      offCanvas.width = canvas.width;
      offCanvas.height = canvas.height;
    }
    const ctx = offCanvas.getContext('2d');
    if (!ctx) return;

    // Always draw indicators - skipping during scroll causes visible disappear
    const skipIndicators = false;

    // Reset transform and scale for HiDPI
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Calculate layout heights based on active indicators
    // IMPORTANT: Use Boolean() to properly check - when indicatorData is null, indicatorData?.rsi is undefined
    // and undefined !== null is TRUE (bug!), so we need to check for truthiness instead
    const hasRSI = Boolean(indicatorData?.rsi);
    const hasMACD = Boolean(indicatorData?.macd);
    const hasATR = Boolean(indicatorData?.atr);
    const hasStochastic = Boolean(indicatorData?.stochastic);
    const hasVolume = indicators?.volume?.enabled && candles.some(c => c.volume !== undefined && c.volume > 0);
    const hasWilliamsR = Boolean(indicatorData?.williamsR);
    const hasCCI = Boolean(indicatorData?.cci);
    const hasADX = Boolean(indicatorData?.adx);
    const hasROC = Boolean(indicatorData?.roc);
    // New subplot indicators
    const hasAroon = Boolean(indicatorData?.aroon);
    const hasMomentum = Boolean(indicatorData?.momentum);
    const hasAO = Boolean(indicatorData?.ao);
    const hasMFI = Boolean(indicatorData?.mfi);
    const hasTSI = Boolean(indicatorData?.tsi);
    const hasTRIX = Boolean(indicatorData?.trix);
    const hasUltOsc = Boolean(indicatorData?.ultimateOsc);
    const hasDPO = Boolean(indicatorData?.dpo);
    const hasKST = Boolean(indicatorData?.kst);
    const hasStochRSI = Boolean(indicatorData?.stochRsi);
    const hasBBPercent = Boolean(indicatorData?.bbPercent);
    const hasBBWidth = Boolean(indicatorData?.bbWidth);
    const hasHistVol = Boolean(indicatorData?.histVol);
    const hasChaikinVol = Boolean(indicatorData?.chaikinVol);
    const hasStdDev = Boolean(indicatorData?.stdDev);
    const hasOBV = Boolean(indicatorData?.obv);
    const hasCMF = Boolean(indicatorData?.cmf);
    const hasADL = Boolean(indicatorData?.adl);
    const hasForceIndex = Boolean(indicatorData?.forceIndex);
    const hasEOM = Boolean(indicatorData?.eom);
    const hasCorrelation = Boolean(indicatorData?.correlation);
    const hasCoppock = Boolean(indicatorData?.coppock);
    // Phase 2 subplot indicators
    const hasVortex = Boolean(indicatorData?.vortex);
    const hasChoppiness = Boolean(indicatorData?.choppiness);
    const hasElderRay = Boolean(indicatorData?.elderRay);
    const hasMassIndex = Boolean(indicatorData?.massIndex);
    const hasLinRegSlope = Boolean(indicatorData?.linRegSlope);
    const hasPPO = Boolean(indicatorData?.ppo);
    const hasPVO = Boolean(indicatorData?.pvo);
    const hasCMO = Boolean(indicatorData?.cmo);
    const hasFisher = Boolean(indicatorData?.fisher);
    const hasSTC = Boolean(indicatorData?.stc);
    const hasRVIOsc = Boolean(indicatorData?.rviOsc);
    const hasKlinger = Boolean(indicatorData?.klinger);
    const hasConnorsRsi = Boolean(indicatorData?.connorsRsi);
    const hasAPO = Boolean(indicatorData?.apo);
    const hasQstick = Boolean(indicatorData?.qstick);
    const hasBOP = Boolean(indicatorData?.bop);
    const hasPsychLine = Boolean(indicatorData?.psychLine);
    const hasPFE = Boolean(indicatorData?.pfe);
    const hasSMI = Boolean(indicatorData?.smi);
    const hasUlcerIndex = Boolean(indicatorData?.ulcerIndex);
    const hasNATR = Boolean(indicatorData?.natr);
    const hasTrueRange = Boolean(indicatorData?.trueRange);
    const hasSqueeze = Boolean(indicatorData?.squeeze);
    const hasRelVolIndex = Boolean(indicatorData?.relVolIndex);
    const hasVHF = Boolean(indicatorData?.vhf);
    const hasVolumeOsc = Boolean(indicatorData?.volumeOsc);
    const hasNVI = Boolean(indicatorData?.nvi);
    const hasPVI = Boolean(indicatorData?.pvi);
    const hasPVT = Boolean(indicatorData?.pvt);
    const hasVROC = Boolean(indicatorData?.vroc);
    const hasNetVolume = Boolean(indicatorData?.netVolume);
    const hasTwiggsMF = Boolean(indicatorData?.twiggsMF);
    const hasLinRegRSquared = Boolean(indicatorData?.linRegRSquared);
    const hasGator = Boolean(indicatorData?.gator);
    // Volume is overlaid on the main chart (TradingView style) so it doesn't count as a subplot
    const numSubplots = [hasRSI, hasMACD, hasATR, hasStochastic, hasWilliamsR, hasCCI, hasADX, hasROC,
      hasAroon, hasMomentum, hasAO, hasMFI, hasTSI, hasTRIX, hasUltOsc, hasDPO, hasKST, hasStochRSI,
      hasBBPercent, hasBBWidth, hasHistVol, hasChaikinVol, hasStdDev,
      hasOBV, hasCMF, hasADL, hasForceIndex, hasEOM,
      hasCorrelation, hasCoppock,
      // Phase 2
      hasVortex, hasChoppiness, hasElderRay, hasMassIndex, hasLinRegSlope,
      hasPPO, hasPVO, hasCMO, hasFisher, hasSTC, hasRVIOsc, hasKlinger, hasConnorsRsi,
      hasAPO, hasQstick, hasBOP, hasPsychLine, hasPFE, hasSMI,
      hasUlcerIndex, hasNATR, hasTrueRange, hasSqueeze, hasRelVolIndex, hasVHF,
      hasVolumeOsc, hasNVI, hasPVI, hasPVT, hasVROC, hasNetVolume, hasTwiggsMF,
      hasLinRegRSquared, hasGator].filter(Boolean).length
      + (indicatorData?.customIndicators?.filter((ci: any) => ci.display === 'subplot').length || 0);

    // Allocate space for subplots - use dynamic ratio when indicators are present
    const availableHeight = height - TIME_AXIS_HEIGHT;
    const totalIndicatorHeight = numSubplots > 0
      ? Math.max(60 * numSubplots, availableHeight * indicatorHeightRatio)
      : 0;
    const subplotHeight = numSubplots > 0 ? totalIndicatorHeight / numSubplots : 0;
    const mainChartHeight = availableHeight - totalIndicatorHeight;
    const chartWidth = width - PRICE_AXIS_WIDTH;

    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);

    // Use scroll ref when actively scrolling for smooth updates
    const visible = getVisibleCandles(true);
    const currentCandleWidth = isScrollingRef.current ? scrollStateRef.current.candleWidth : viewState.candleWidth;
    const priceRange = getPriceRange(visible.candles, viewState.autoFollowLatest);

    // CRITICAL: Store the exact price range used for this frame
    // The drawing overlay converter MUST use this exact same range to stay synchronized
    renderedPriceRangeRef.current = priceRange;
    mainChartHeightRef.current = mainChartHeight;

    // Get raw startIndex for smooth sub-pixel scrolling (Rolex-style continuous motion)
    const rawStartIndex = isScrollingRef.current ? scrollStateRef.current.startIndex : viewState.startIndex;
    const fractionalOffset = (rawStartIndex - visible.startIndex) * (currentCandleWidth * (1 + CANDLE_GAP_RATIO));

    // Shadow indexToX with a local version that applies fractional offset for butter-smooth scrolling
    const indexToX = (index: number, startIndex: number) => {
      const spacing = currentCandleWidth * (1 + CANDLE_GAP_RATIO);
      // Apply fractional offset to shift all candles smoothly
      return (index - startIndex) * spacing + spacing / 2 - fractionalOffset;
    };

    // Helper to convert price to Y coordinate in main chart area
    const mainPriceToY = (price: number) => {
      const ratio = (price - priceRange.min) / priceRange.range;
      return mainChartHeight - (ratio * mainChartHeight);
    };

    // Draw grid for main chart - apply grid opacity setting
    const gridOpacity = (colors.gridOpacity ?? 100) / 100;
    ctx.globalAlpha = gridOpacity;
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 0.5;
    ctx.setLineDash([]); // Solid lines like TradingView

    // Grid density: read user setting from localStorage, fall back to defaults.
    // Users can customise these in Settings > Chart Appearance.
    const savedGridH = chartSettingsRef.current?.chart?.gridHorizontalLines;
    const savedGridV = chartSettingsRef.current?.chart?.gridVerticalLines;
    // Target label count: higher = denser, tighter-packed Y-axis labels.
    // These produce ~25-30px gaps between labels, matching TradingView density.
    const priceTargetLabels = isDesktop ? (savedGridH ?? cfg.priceTargetLabels) : cfg.priceTargetLabels;
    const priceStep = calculateNiceStep(priceRange.range, priceTargetLabels);
    const startPrice = Math.ceil(priceRange.min / priceStep) * priceStep;

    // TradingView horizontal grid line right edge:
    // - If the last candle in the dataset is on-screen or to the left (live/auto mode):
    //   extend to full chartWidth (covers the empty future timestamp space)
    // - If scrolled back in history (last candle is off-screen to the right):
    //   stop at the last visible candle on screen
    const lastVisibleGlobalIndex = visible.startIndex + visible.candles.length - 1;
    const lastDatasetCandleX = indexToX(candles.length - 1, visible.startIndex);
    const isAtLiveEdge = lastDatasetCandleX <= chartWidth; // last candle is visible on screen
    const gridRightEdge = isAtLiveEdge
      ? chartWidth
      : Math.max(0, Math.min(chartWidth, indexToX(lastVisibleGlobalIndex, visible.startIndex) + currentCandleWidth / 2));

    // Minimum pixel gap between grid lines: prevents overcrowding in
    // vertically-stacked multi-panel layouts (2x2, 1x2, etc.)
    const MIN_GRID_GAP = 25;
    ctx.beginPath();
    let lastGridY = -Infinity;
    for (let price = startPrice; price <= priceRange.max; price += priceStep) {
      const y = mainPriceToY(price);
      if (Math.abs(y - lastGridY) < MIN_GRID_GAP) continue;
      lastGridY = y;
      ctx.moveTo(0, y);
      ctx.lineTo(gridRightEdge, y);
    }
    ctx.stroke();
    ctx.setLineDash([]); // Reset to solid
    ctx.globalAlpha = 1; // Reset alpha

    // TradingView-style vertical grid with multi-tier smooth appearance/disappearance
    // Target: ~8-12 vertical lines across chart when fully zoomed out (like TradingView)
    // Lines fade in smoothly as you zoom in, more lines appear
    // Grid extends into the future timestamps area (empty space right of live price)
    const candleSpacing = currentCandleWidth * (1 + CANDLE_GAP_RATIO);

    // Calculate how many candle slots fit in the chart width - use this for interval calculation
    // This ensures consistent grid density regardless of where candles are positioned
    const candlesFitInWidth = Math.ceil(chartWidth / candleSpacing);
    // Vertical grid lines extend through the full visible width including empty future space.
    // Do NOT cap at candles.length - 1; that would stop lines before the right edge of the chart.
    const gridEndIndex = visible.startIndex + candlesFitInWidth;

    // Dynamic base interval: aim for fewer lines on mobile/tablet for cleaner look
    // Use candlesFitInWidth (not visibleCandles) to keep density consistent
    // This prevents too many lines when viewing live data with future space
    const targetLinesOnScreen = isDesktop ? (savedGridV ?? cfg.targetLinesOnScreen) : cfg.targetLinesOnScreen;
    const rawInterval = Math.max(1, Math.round(candlesFitInWidth / targetLinesOnScreen));

    // Use raw interval directly (no snapping to "nice" numbers).
    // This keeps a consistent number of lines at every zoom level
    // instead of lines appearing/disappearing during zoom transitions.
    const baseInterval = Math.max(1, rawInterval);

    // Secondary interval is half of base (for smooth fade-in of intermediate lines when zooming IN)
    const halfInterval = baseInterval / 2;

    // Calculate opacity for secondary lines based on where we are between intervals
    const linesWithBase = candlesFitInWidth / baseInterval;

    // Fade in secondary lines when we have room for more (zooming in)
    const secondaryOpacity = Math.max(0, Math.min(1,
      (linesWithBase - 8) / 6
    ));

    // Tertiary lines: appear when FULLY zoomed out (add one line between each base line)
    // These give more density at max zoom out like the reference image
    // Disable tertiary lines on mobile/tablet for cleaner look
    const tertiaryInterval = baseInterval / 2;
    // Show tertiary lines when candleSpacing is very small (zoomed out)
    // Fade in when candleSpacing < 3, fully visible at < 1.5
    // On mobile/tablet, disable tertiary lines completely
    const tertiaryOpacity = !cfg.tertiaryGridVisible ? 0 : Math.max(0, Math.min(0.5,
      (3 - candleSpacing) / 1.5
    ));

    // Draw primary lines (always visible) - extends into future area
    ctx.globalAlpha = gridOpacity;
    ctx.strokeStyle = colors.grid;
    ctx.beginPath();
    // Offset standard index by prepend shift before bucketing so the grid stays
    // perfectly anchored to its structural candles even when the array bounds expand dynamically.
    const effStart = visible.startIndex - (prependShift || 0);
    const firstPrimaryIndex = Math.ceil(effStart / baseInterval) * baseInterval + (prependShift || 0);
    for (let idx = firstPrimaryIndex; idx <= gridEndIndex; idx += baseInterval) {
      const x = indexToX(idx, visible.startIndex);
      if (x >= 0 && x <= chartWidth) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, mainChartHeight);
      }
      if (x > chartWidth) break; // Stop once we're past the visible area
    }
    ctx.stroke();

    // Draw secondary lines (fade in/out based on zoom IN) - extends into future area
    if (secondaryOpacity > 0.01 && halfInterval >= 1) {
      ctx.globalAlpha = secondaryOpacity * gridOpacity;
      ctx.strokeStyle = colors.grid;
      ctx.beginPath();
      // Offset by prependShift to stabilize visual grid anchors
      const effStart = visible.startIndex - (prependShift || 0);
      const firstSecondaryIndex = Math.ceil(effStart / halfInterval) * halfInterval + (prependShift || 0);
      for (let idx = firstSecondaryIndex; idx <= gridEndIndex; idx += halfInterval) {
        if ((idx - (prependShift || 0)) % baseInterval === 0) continue;
        const x = indexToX(idx, visible.startIndex);
        if (x >= 0 && x <= chartWidth) {
          ctx.moveTo(x, 0);
          ctx.lineTo(x, mainChartHeight);
        }
        if (x > chartWidth) break;
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Draw tertiary lines (appear when FULLY zoomed out - adds density) - extends into future area
    if (tertiaryOpacity > 0.01 && tertiaryInterval >= 1) {
      ctx.globalAlpha = tertiaryOpacity * gridOpacity;
      ctx.strokeStyle = colors.grid;
      ctx.beginPath();
      // Offset by prependShift to stabilize visual grid anchors
      const effStart = visible.startIndex - (prependShift || 0);
      const firstTertiaryIndex = Math.ceil(effStart / tertiaryInterval) * tertiaryInterval + (prependShift || 0);
      for (let idx = firstTertiaryIndex; idx <= gridEndIndex; idx += tertiaryInterval) {
        if ((idx - (prependShift || 0)) % baseInterval === 0) continue; // Skip primary lines
        const x = indexToX(idx, visible.startIndex);
        if (x >= 0 && x <= chartWidth) {
          ctx.moveTo(x, 0);
          ctx.lineTo(x, mainChartHeight);
        }
        if (x > chartWidth) break;
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Reset globalAlpha to 1 before drawing any non-grid elements
    ctx.globalAlpha = 1;

    // Draw Y-axis line: extends full height including through time axis
    ctx.strokeStyle = colors.axisLine || colors.textDim;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(chartWidth, 0);
    ctx.lineTo(chartWidth, height);
    ctx.stroke();

    // Draw price data based on chart type
    // Clip to main chart area to prevent candles from drawing into indicator panels
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, chartWidth, mainChartHeight);
    ctx.clip();

    // ── Heatmap visualizations (extracted to renderers/heatmapRenderer.ts) ──
    // Three layers rendered behind candles: probability cloud, order book
    // history, and live L2 depth bars. All are pure functions receiving
    // canvas context and data via the HeatmapRenderContext interface.
    const heatmapCtx: HeatmapRenderContext = {
      ctx, chartWidth, mainChartHeight, candles, visible, indexToX,
      mainPriceToY, currentCandleWidth,
    };

    // Options probability density cloud (SVI-derived or Gaussian fallback)
    if (optionsPdfEnabled && optionsPdfData) {
      renderOptionsPdfHeatmap(heatmapCtx, optionsPdfData);
    }

    // Historical order book liquidity heatmap (Bookmap-style)
    if (heatmapEnabled && heatmapData.length > 0) {
      renderOrderBookHeatmap(heatmapCtx, heatmapData);
    }

    // Live L2 depth overlay (horizontal bid/ask bars)
    if (l2DepthData && (l2DepthData.bids.length > 0 || l2DepthData.asks.length > 0)) {
      renderL2DepthOverlay(heatmapCtx, l2DepthData);
    }

    // ── Trading session boxes (Tokyo, London, New York) ──
    // Rendered behind candles so the semi-transparent colored rectangles
    // provide context without obscuring price action. Only shown when
    // the user has enabled the session toggle and the timeframe is intraday.
    if (showSessions) {
      const sessionCtx: SessionRenderContext = {
        ctx, chartWidth, mainChartHeight, candles,
        visibleStartIndex: visible.startIndex,
        visibleEndIndex: visible.startIndex + visible.candles.length,
        candleWidth: currentCandleWidth,
        indexToX, isDark, timeframe,
      };
      renderSessions(sessionCtx);
    }
    const candleBodyWidth = Math.max(currentCandleWidth * 0.7, 3);
    const wickWidth = Math.max(1, candleBodyWidth * 0.15);

    if (chartType === 'candlestick') {
      // Draw candlesticks
      visible.candles.forEach((candle, i) => {
        const x = indexToX(visible.startIndex + i, visible.startIndex);
        const isBullish = candle.close >= candle.open;

        const openY = mainPriceToY(candle.open);
        const closeY = mainPriceToY(candle.close);
        const highY = mainPriceToY(candle.high);
        const lowY = mainPriceToY(candle.low);

        // Draw wick: rounded caps for a modern premium feel
        ctx.strokeStyle = isBullish ? colors.bullishWick : colors.bearishWick;
        ctx.lineWidth = wickWidth;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x, highY);
        ctx.lineTo(x, lowY);
        ctx.stroke();
        ctx.lineCap = 'butt'; // Reset

        // Draw body
        const bodyTop = Math.min(openY, closeY);
        const bodyHeight = Math.max(1, Math.abs(closeY - openY));

        ctx.fillStyle = isBullish ? colors.bullish : colors.bearish;
        ctx.fillRect(x - candleBodyWidth / 2, bodyTop, candleBodyWidth, bodyHeight);

        ctx.strokeStyle = isBullish ? colors.bullishBorder : colors.bearishBorder;
        ctx.lineWidth = 1;
        ctx.strokeRect(x - candleBodyWidth / 2, bodyTop, candleBodyWidth, bodyHeight);
      });
    } else if (chartType === 'line') {
      // Draw line chart
      ctx.strokeStyle = colors.bullish;
      ctx.lineWidth = 2;
      ctx.beginPath();

      visible.candles.forEach((candle, i) => {
        const x = indexToX(visible.startIndex + i, visible.startIndex);
        const y = mainPriceToY(candle.close);

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();
    } else if (chartType === 'area') {
      // Draw area chart with gradient fill
      const gradient = ctx.createLinearGradient(0, 0, 0, mainChartHeight);
      gradient.addColorStop(0, 'rgba(34, 197, 94, 0.4)');
      gradient.addColorStop(1, 'rgba(34, 197, 94, 0.02)');

      // First draw the filled area
      ctx.beginPath();
      visible.candles.forEach((candle, i) => {
        const x = indexToX(visible.startIndex + i, visible.startIndex);
        const y = mainPriceToY(candle.close);

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });

      // Close the path along the bottom
      if (visible.candles.length > 0) {
        const lastX = indexToX(visible.startIndex + visible.candles.length - 1, visible.startIndex);
        const firstX = indexToX(visible.startIndex, visible.startIndex);
        ctx.lineTo(lastX, mainChartHeight);
        ctx.lineTo(firstX, mainChartHeight);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();
      }

      // Then draw the line on top
      ctx.strokeStyle = colors.bullish;
      ctx.lineWidth = 2;
      ctx.beginPath();
      visible.candles.forEach((candle, i) => {
        const x = indexToX(visible.startIndex + i, visible.startIndex);
        const y = mainPriceToY(candle.close);

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();
    } else if (chartType === 'renko') {
      // Calculate Renko bricks
      const renkoSize = priceRange.range * 0.02; // 2% of visible range as brick size
      const renkoBricks: Array<{ x: number; isBullish: boolean; top: number; bottom: number }> = [];
      let lastBrickPrice = visible.candles[0]?.close || 0;
      let brickIndex = 0;

      visible.candles.forEach((candle) => {
        const diff = candle.close - lastBrickPrice;
        const bricksToAdd = Math.floor(Math.abs(diff) / renkoSize);

        for (let j = 0; j < bricksToAdd; j++) {
          const isBullish = diff > 0;
          const brickBottom = lastBrickPrice;
          const brickTop = isBullish ? lastBrickPrice + renkoSize : lastBrickPrice - renkoSize;

          renkoBricks.push({
            x: brickIndex * candleBodyWidth * 1.2,
            isBullish,
            top: mainPriceToY(Math.max(brickBottom, brickTop)),
            bottom: mainPriceToY(Math.min(brickBottom, brickTop)),
          });

          lastBrickPrice = brickTop;
          brickIndex++;
        }
      });

      // Draw Renko bricks
      renkoBricks.forEach((brick) => {
        const brickHeight = Math.abs(brick.bottom - brick.top);

        ctx.fillStyle = brick.isBullish ? colors.bullish : colors.bearish;
        ctx.fillRect(brick.x, brick.top, candleBodyWidth, brickHeight);

        ctx.strokeStyle = brick.isBullish ? colors.bullishBorder : colors.bearishBorder;
        ctx.lineWidth = 1;
        ctx.strokeRect(brick.x, brick.top, candleBodyWidth, brickHeight);
      });
    }

    // ═══════════ Volume overlay (TradingView style) ═══════════
    // Draw volume bars overlaid at the bottom of the main chart area
    // No separator line, semi-transparent, behind candles
    if (!skipIndicators && hasVolume) {
      const volOverlayHeight = mainChartHeight * 0.2; // 20% of main chart height
      const volBottom = mainChartHeight;
      const volTop = volBottom - volOverlayHeight;

      // Find volume range for visible candles
      const visibleVolumes = visible.candles
        .map(c => c.volume ?? 0)
        .filter(v => v > 0);
      const volMax = visibleVolumes.length > 0 ? Math.max(...visibleVolumes) : 1;

      // Draw volume bars
      const barWidth = Math.max(2, currentCandleWidth * 0.7);
      visible.candles.forEach((candle, i) => {
        const volume = candle.volume ?? 0;
        if (volume > 0) {
          const globalIdx = visible.startIndex + i;
          const x = indexToX(globalIdx, visible.startIndex);
          const ratio = volume / volMax;
          const barHeight = ratio * volOverlayHeight * 0.95;
          const y = volBottom - barHeight;

          // Color based on candle direction, semi-transparent like TradingView
          const isBullish = candle.close >= candle.open;
          const volUpColor = indicators?.volume?.upColor || '#26a69a';
          const volDownColor = indicators?.volume?.downColor || '#ef5350';
          const hexColor = isBullish ? volUpColor : volDownColor;
          // Convert hex to rgba with 0.45 opacity (increased for better visibility)
          const r = parseInt(hexColor.slice(1, 3), 16);
          const g = parseInt(hexColor.slice(3, 5), 16);
          const b = parseInt(hexColor.slice(5, 7), 16);
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.45)`;
          ctx.fillRect(x - barWidth / 2, y, barWidth, barHeight);

          // Thin top-edge line for sharper definition
          ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.7)`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x - barWidth / 2, y);
          ctx.lineTo(x + barWidth / 2, y);
          ctx.stroke();
        }
      });

      // TradingView-style selection: when volume is selected, draw small
      // circles at the top of each bar. Only placed at local volume peaks
      // (bars taller than both neighbours) so the dots sit neatly on the
      // skyline instead of scattering across every bar height.
      if (clickedIndicatorKey === 'volume') {
        const SEL_R = 2.5;
        ctx.save();
        visible.candles.forEach((candle, i) => {
          const volume = candle.volume ?? 0;
          if (volume <= 0) return;
          // Only place dots on local peaks: volume >= both adjacent bars
          const prevVol = (visible.candles[i - 1]?.volume ?? 0);
          const nextVol = (visible.candles[i + 1]?.volume ?? 0);
          if (volume < prevVol || volume < nextVol) return;
          const globalIdx = visible.startIndex + i;
          const x = indexToX(globalIdx, visible.startIndex);
          const ratio = volume / volMax;
          const barHeight = ratio * volOverlayHeight * 0.95;
          const dotY = volBottom - barHeight;
          // Dark border then coloured fill
          ctx.beginPath();
          ctx.arc(x, dotY, SEL_R + 1, 0, Math.PI * 2);
          ctx.fillStyle = '#131722';
          ctx.fill();
          ctx.beginPath();
          ctx.arc(x, dotY, SEL_R, 0, Math.PI * 2);
          const isBull = candle.close >= candle.open;
          ctx.fillStyle = isBull ? (indicators?.volume?.upColor || '#26a69a') : (indicators?.volume?.downColor || '#ef5350');
          ctx.fill();
        });
        ctx.restore();
      }

      // Format volume helper
      const formatVolume = (vol: number) => {
        if (vol >= 1e9) return (vol / 1e9).toFixed(2) + 'B';
        if (vol >= 1e6) return (vol / 1e6).toFixed(2) + 'M';
        if (vol >= 1e3) return (vol / 1e3).toFixed(2) + 'K';
        return vol.toFixed(0);
      };

      // Store Volume bounds for click detection (mapped to main chart overlay area)
      indicatorBoundsRef.current.volume = { top: volTop, bottom: volBottom };


    }

    // Restore context after drawing price data (removes main chart clipping)
    ctx.restore();

    // Draw indicators overlaid on main chart (skip during fast scroll)
    if (!skipIndicators && indicators) {

      // Draw EMA lines using pre-computed indicatorData (with clipping to main chart area).
      // Previously this called calculateEMA(candles.map(c=>c.close), period) on ALL candles
      // every single frame, which is O(n * num_periods) redundant work since indicatorData
      // already has these values cached in the useMemo.
      if (indicators.ema?.enabled && indicatorData?.ema && indicators.ema.periods?.length > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, chartWidth, mainChartHeight);
        ctx.clip();

        // Legacy EMA fallback colors: muted neutrals that adapt to theme
        const emaColors = isDark
          ? ['#D1D4DC', '#A0A4B0', '#B2B5BE', '#9598A1', '#787B86']
          : ['#363A45', '#5D606B', '#434651', '#787B86', '#9598A1'];
        indicators.ema.periods.forEach((period: number, idx: number) => {
          // Use pre-computed EMA from indicatorData instead of recalculating
          const emaValues = indicatorData.ema![idx];
          if (!emaValues) return;

          ctx.strokeStyle = emaColors[idx % emaColors.length];
          ctx.lineWidth = 1.5;
          ctx.beginPath();

          let started = false;
          visible.candles.forEach((candle, i) => {
            const globalIdx = visible.startIndex + i;
            const emaValue = emaValues[globalIdx];

            if (!isNaN(emaValue) && isFinite(emaValue)) {
              const x = indexToX(globalIdx, visible.startIndex);
              const y = priceToY(emaValue, priceRange);

              if (!started) {
                ctx.moveTo(x, y);
                started = true;
              } else {
                ctx.lineTo(x, y);
              }
            }
          });

          ctx.stroke();
        });

        ctx.restore();
      }

      // Draw Moving Averages (new combined config) - with clipping
      if (indicatorData?.movingAverages && indicatorData.movingAverages.length > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, chartWidth, mainChartHeight);
        ctx.clip();

        const maLineWidth = indicators?.movingAverages?.lineWidth ?? 1.5;
        indicatorData.movingAverages.forEach((ma: { data: number[]; color: string; name: string }) => {
          // Use the MA line color directly. #2962FF (blue) is the default and
          // works on both light and dark backgrounds without needing theme swaps.
          ctx.strokeStyle = ma.color;
          ctx.lineWidth = maLineWidth;
          ctx.beginPath();

          let started = false;
          visible.candles.forEach((candle, i) => {
            const globalIdx = visible.startIndex + i;
            const value = ma.data[globalIdx];

            if (!isNaN(value) && isFinite(value)) {
              const x = indexToX(globalIdx, visible.startIndex);
              const y = priceToY(value, priceRange);

              if (!started) {
                ctx.moveTo(x, y);
                started = true;
              } else {
                ctx.lineTo(x, y);
              }
            }
          });

          ctx.stroke();
        });

        ctx.restore();
      }
      if (indicators.bollinger?.enabled && indicatorData?.bollinger) {
        const bbData = indicatorData.bollinger;

        // Save context and clip to main chart area to prevent drawing into indicator panels
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, chartWidth, mainChartHeight);
        ctx.clip();

        const bbLineWidth = indicators.bollinger.lineWidth || 1;
        const upperColor = indicators.bollinger.upperColor || '#9B59B6';
        const middleColor = indicators.bollinger.middleColor || '#9B59B6';
        const lowerColor = indicators.bollinger.lowerColor || '#9B59B6';

        // Upper band
        ctx.strokeStyle = upperColor;
        ctx.lineWidth = bbLineWidth;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        let started = false;
        visible.candles.forEach((candle, i) => {
          const globalIdx = visible.startIndex + i;
          const value = bbData.upper[globalIdx];

          if (!isNaN(value) && isFinite(value)) {
            const x = indexToX(globalIdx, visible.startIndex);
            const y = priceToY(value, priceRange);

            if (!started) {
              ctx.moveTo(x, y);
              started = true;
            } else {
              ctx.lineTo(x, y);
            }
          }
        });
        ctx.stroke();

        // Middle band
        ctx.strokeStyle = middleColor;
        ctx.lineWidth = bbLineWidth;
        ctx.setLineDash([]);
        ctx.beginPath();
        started = false;
        visible.candles.forEach((candle, i) => {
          const globalIdx = visible.startIndex + i;
          const value = bbData.middle[globalIdx];

          if (!isNaN(value) && isFinite(value)) {
            const x = indexToX(globalIdx, visible.startIndex);
            const y = priceToY(value, priceRange);

            if (!started) {
              ctx.moveTo(x, y);
              started = true;
            } else {
              ctx.lineTo(x, y);
            }
          }
        });
        ctx.stroke();

        // Lower band
        ctx.strokeStyle = lowerColor;
        ctx.lineWidth = bbLineWidth;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        started = false;
        visible.candles.forEach((candle, i) => {
          const globalIdx = visible.startIndex + i;
          const value = bbData.lower[globalIdx];

          if (!isNaN(value) && isFinite(value)) {
            const x = indexToX(globalIdx, visible.startIndex);
            const y = priceToY(value, priceRange);

            if (!started) {
              ctx.moveTo(x, y);
              started = true;
            } else {
              ctx.lineTo(x, y);
            }
          }
        });
        ctx.stroke();
        ctx.setLineDash([]);

        // Restore context (removes clipping)
        ctx.restore();
      }

      // Draw VWAP if enabled
      if (indicatorData?.vwap) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, chartWidth, mainChartHeight);
        ctx.clip();

        ctx.strokeStyle = indicators?.vwap?.color || '#2196F3';
        ctx.lineWidth = 2;
        ctx.beginPath();
        let started = false;
        visible.candles.forEach((candle, i) => {
          const globalIdx = visible.startIndex + i;
          const value = indicatorData.vwap![globalIdx];
          if (!isNaN(value) && isFinite(value)) {
            const x = indexToX(globalIdx, visible.startIndex);
            const y = priceToY(value, priceRange);
            if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
          }
        });
        ctx.stroke();
        ctx.restore();
      }

      // Draw Ichimoku Cloud if enabled
      if (indicatorData?.ichimoku) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, chartWidth, mainChartHeight);
        ctx.clip();

        const ichi = indicatorData.ichimoku;
        const tenkanColor = indicators?.ichimoku?.tenkanColor || '#0496ff';
        const kijunColor = indicators?.ichimoku?.kijunColor || '#ff0000';
        const cloudUpColor = indicators?.ichimoku?.cloudUpColor || 'rgba(0, 255, 0, 0.2)';
        const cloudDownColor = indicators?.ichimoku?.cloudDownColor || 'rgba(255, 0, 0, 0.2)';

        // Draw cloud (Kumo) - fill between Senkou A and B
        for (let i = 0; i < visible.candles.length; i++) {
          const globalIdx = visible.startIndex + i;
          const senkouAVal = ichi.senkouA[globalIdx];
          const senkouBVal = ichi.senkouB[globalIdx];

          if (!isNaN(senkouAVal) && !isNaN(senkouBVal) && isFinite(senkouAVal) && isFinite(senkouBVal)) {
            const x = indexToX(globalIdx, visible.startIndex);
            const yA = priceToY(senkouAVal, priceRange);
            const yB = priceToY(senkouBVal, priceRange);

            ctx.fillStyle = senkouAVal >= senkouBVal ? cloudUpColor : cloudDownColor;
            const barWidth = currentCandleWidth * (1 + CANDLE_GAP_RATIO);
            ctx.fillRect(x - barWidth / 2, Math.min(yA, yB), barWidth, Math.abs(yA - yB));
          }
        }

        // Draw Tenkan-sen
        ctx.strokeStyle = tenkanColor;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let started = false;
        visible.candles.forEach((candle, i) => {
          const globalIdx = visible.startIndex + i;
          const value = ichi.tenkan[globalIdx];
          if (!isNaN(value) && isFinite(value)) {
            const x = indexToX(globalIdx, visible.startIndex);
            const y = priceToY(value, priceRange);
            if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
          }
        });
        ctx.stroke();

        // Draw Kijun-sen
        ctx.strokeStyle = kijunColor;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        started = false;
        visible.candles.forEach((candle, i) => {
          const globalIdx = visible.startIndex + i;
          const value = ichi.kijun[globalIdx];
          if (!isNaN(value) && isFinite(value)) {
            const x = indexToX(globalIdx, visible.startIndex);
            const y = priceToY(value, priceRange);
            if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
          }
        });
        ctx.stroke();

        ctx.restore();
      }

      // Draw Parabolic SAR if enabled
      if (indicatorData?.parabolicSAR) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, chartWidth, mainChartHeight);
        ctx.clip();

        const sar = indicatorData.parabolicSAR;
        const bullishColor = indicators?.parabolicSAR?.bullishColor || '#22c55e';
        const bearishColor = indicators?.parabolicSAR?.bearishColor || '#ef4444';

        visible.candles.forEach((candle, i) => {
          const globalIdx = visible.startIndex + i;
          const sarValue = sar.sar[globalIdx];
          const direction = sar.direction[globalIdx];

          if (!isNaN(sarValue) && isFinite(sarValue)) {
            const x = indexToX(globalIdx, visible.startIndex);
            const y = priceToY(sarValue, priceRange);

            ctx.fillStyle = direction > 0 ? bullishColor : bearishColor;
            ctx.beginPath();
            ctx.arc(x, y, 2.5, 0, Math.PI * 2);
            ctx.fill();
          }
        });

        ctx.restore();
      }

      // Draw Keltner Channels if enabled
      if (indicatorData?.keltner) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, chartWidth, mainChartHeight);
        ctx.clip();

        const kelt = indicatorData.keltner;
        const upperColor = indicators?.keltner?.upperColor || '#FF9800';
        const middleColor = indicators?.keltner?.middleColor || '#FF9800';
        const lowerColor = indicators?.keltner?.lowerColor || '#FF9800';

        // Upper band
        ctx.strokeStyle = upperColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        let started = false;
        visible.candles.forEach((candle, i) => {
          const globalIdx = visible.startIndex + i;
          const value = kelt.upper[globalIdx];
          if (!isNaN(value) && isFinite(value)) {
            const x = indexToX(globalIdx, visible.startIndex);
            const y = priceToY(value, priceRange);
            if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
          }
        });
        ctx.stroke();

        // Middle band
        ctx.strokeStyle = middleColor;
        ctx.setLineDash([]);
        ctx.beginPath();
        started = false;
        visible.candles.forEach((candle, i) => {
          const globalIdx = visible.startIndex + i;
          const value = kelt.middle[globalIdx];
          if (!isNaN(value) && isFinite(value)) {
            const x = indexToX(globalIdx, visible.startIndex);
            const y = priceToY(value, priceRange);
            if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
          }
        });
        ctx.stroke();

        // Lower band
        ctx.strokeStyle = lowerColor;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        started = false;
        visible.candles.forEach((candle, i) => {
          const globalIdx = visible.startIndex + i;
          const value = kelt.lower[globalIdx];
          if (!isNaN(value) && isFinite(value)) {
            const x = indexToX(globalIdx, visible.startIndex);
            const y = priceToY(value, priceRange);
            if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
          }
        });
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.restore();
      }

      // Draw Pivot Points if enabled
      if (indicatorData?.pivotPoints) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, chartWidth, mainChartHeight);
        ctx.clip();

        const pivots = indicatorData.pivotPoints;
        const pivotColor = indicators?.pivotPoints?.pivotColor || '#FFEB3B';
        const resistanceColor = indicators?.pivotPoints?.resistanceColor || '#ef4444';
        const supportColor = indicators?.pivotPoints?.supportColor || '#22c55e';

        // Draw horizontal lines for pivot levels
        const drawPivotLine = (data: number[], color: string, label: string, lineStyle: number[] = []) => {
          const lastValidValue = data.filter(v => !isNaN(v) && isFinite(v)).pop();
          if (lastValidValue !== undefined) {
            const y = priceToY(lastValidValue, priceRange);
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.setLineDash(lineStyle);
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(chartWidth, y);
            ctx.stroke();

            // Draw label
            ctx.fillStyle = color;
            ctx.font = SUBPLOT_LABEL_FONT;
            ctx.textAlign = 'left';
            ctx.fillText(label, 5, y - 3);
          }
        };

        ctx.setLineDash([]);
        drawPivotLine(pivots.pivot, pivotColor, 'P');
        drawPivotLine(pivots.r1, resistanceColor, 'R1', [2, 2]);
        drawPivotLine(pivots.r2, resistanceColor, 'R2', [4, 2]);
        drawPivotLine(pivots.r3, resistanceColor, 'R3', [6, 2]);
        drawPivotLine(pivots.s1, supportColor, 'S1', [2, 2]);
        drawPivotLine(pivots.s2, supportColor, 'S2', [4, 2]);
        drawPivotLine(pivots.s3, supportColor, 'S3', [6, 2]);
        ctx.setLineDash([]);

        ctx.restore();
      }

      // ── NEW OVERLAY INDICATORS ──────────────────────────────────────

      // Supertrend overlay
      if (indicatorData?.supertrend) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, chartWidth, mainChartHeight);
        ctx.clip();
        const st = indicatorData.supertrend;
        const bullColor = indicators?.supertrend?.bullishColor || '#22c55e';
        const bearColor = indicators?.supertrend?.bearishColor || '#ef4444';
        ctx.lineWidth = indicators?.supertrend?.lineWidth || 2;
        visible.candles.forEach((_, i) => {
          const globalIdx = visible.startIndex + i;
          const value = st.supertrend[globalIdx];
          if (isNaN(value) || !isFinite(value)) return;
          const x = indexToX(globalIdx, visible.startIndex);
          const y = priceToY(value, priceRange);
          const prevIdx = globalIdx - 1;
          if (prevIdx >= 0 && !isNaN(st.supertrend[prevIdx])) {
            ctx.strokeStyle = st.direction[globalIdx] === 1 ? bullColor : bearColor;
            ctx.beginPath();
            ctx.moveTo(indexToX(prevIdx, visible.startIndex), priceToY(st.supertrend[prevIdx], priceRange));
            ctx.lineTo(x, y);
            ctx.stroke();
          }
        });
        ctx.restore();
      }

      // Donchian Channels overlay
      if (indicatorData?.donchian) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, chartWidth, mainChartHeight);
        ctx.clip();
        const dc = indicatorData.donchian;
        const drawOverlayLine = (data: number[], color: string, dash: number[] = []) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = indicators?.donchian?.lineWidth || 1;
          ctx.setLineDash(dash);
          ctx.beginPath();
          let s = false;
          visible.candles.forEach((_, i) => {
            const gi = visible.startIndex + i;
            const v = data[gi];
            if (!isNaN(v) && isFinite(v)) {
              const x = indexToX(gi, visible.startIndex);
              const y = priceToY(v, priceRange);
              if (!s) { ctx.moveTo(x, y); s = true; } else { ctx.lineTo(x, y); }
            }
          });
          ctx.stroke();
          ctx.setLineDash([]);
        };
        drawOverlayLine(dc.upper, indicators?.donchian?.upperColor || '#2196F3');
        drawOverlayLine(dc.middle, indicators?.donchian?.middleColor || '#FFC107', [4, 4]);
        drawOverlayLine(dc.lower, indicators?.donchian?.lowerColor || '#2196F3');
        ctx.restore();
      }

      // Envelopes overlay
      if (indicatorData?.envelopes) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, chartWidth, mainChartHeight);
        ctx.clip();
        const env = indicatorData.envelopes;
        const drawLine = (data: number[], color: string, dash: number[] = []) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = indicators?.envelopes?.lineWidth || 1;
          ctx.setLineDash(dash);
          ctx.beginPath();
          let s = false;
          visible.candles.forEach((_, i) => {
            const gi = visible.startIndex + i;
            const v = data[gi];
            if (!isNaN(v) && isFinite(v)) {
              const x = indexToX(gi, visible.startIndex);
              if (!s) { ctx.moveTo(x, priceToY(v, priceRange)); s = true; } else { ctx.lineTo(x, priceToY(v, priceRange)); }
            }
          });
          ctx.stroke();
          ctx.setLineDash([]);
        };
        drawLine(env.upper, indicators?.envelopes?.upperColor || '#00BCD4');
        drawLine(env.middle, indicators?.envelopes?.middleColor || '#FFC107', [3, 3]);
        drawLine(env.lower, indicators?.envelopes?.lowerColor || '#00BCD4');
        ctx.restore();
      }

      // DEMA / TEMA / HMA overlays (single line each)
      const singleLineOverlays: { key: 'dema' | 'tema' | 'hma'; defaultColor: string; label: string }[] = [
        { key: 'dema', defaultColor: '#FF9800', label: 'DEMA' },
        { key: 'tema', defaultColor: '#E91E63', label: 'TEMA' },
        { key: 'hma', defaultColor: '#00E676', label: 'HMA' },
      ];
      singleLineOverlays.forEach(({ key, defaultColor }) => {
        const data = indicatorData?.[key] as number[] | null;
        if (!data) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, chartWidth, mainChartHeight);
        ctx.clip();
        ctx.strokeStyle = (indicators as any)?.[key]?.color || defaultColor;
        ctx.lineWidth = (indicators as any)?.[key]?.lineWidth || 2;
        ctx.beginPath();
        let s = false;
        visible.candles.forEach((_, i) => {
          const gi = visible.startIndex + i;
          const v = data[gi];
          if (!isNaN(v) && isFinite(v)) {
            const x = indexToX(gi, visible.startIndex);
            const y = priceToY(v, priceRange);
            if (!s) { ctx.moveTo(x, y); s = true; } else { ctx.lineTo(x, y); }
          }
        });
        ctx.stroke();
        ctx.restore();
      });

      // Linear Regression Channel overlay
      if (indicatorData?.linearReg) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, chartWidth, mainChartHeight);
        ctx.clip();
        const lr = indicatorData.linearReg;
        const drawLR = (data: number[], color: string, dash: number[] = []) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = indicators?.linearReg?.lineWidth || 1;
          ctx.setLineDash(dash);
          ctx.beginPath();
          let s = false;
          visible.candles.forEach((_, i) => {
            const gi = visible.startIndex + i;
            const v = data[gi];
            if (!isNaN(v) && isFinite(v)) {
              const x = indexToX(gi, visible.startIndex);
              if (!s) { ctx.moveTo(x, priceToY(v, priceRange)); s = true; } else { ctx.lineTo(x, priceToY(v, priceRange)); }
            }
          });
          ctx.stroke();
          ctx.setLineDash([]);
        };
        drawLR(lr.upper, indicators?.linearReg?.upperColor || '#81D4FA');
        drawLR(lr.middle, indicators?.linearReg?.middleColor || '#29B6F6', [4, 4]);
        drawLR(lr.lower, indicators?.linearReg?.lowerColor || '#81D4FA');
        ctx.restore();
      }

      // Fibonacci Retracement overlay
      if (indicatorData?.fibRetracement) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, chartWidth, mainChartHeight);
        ctx.clip();
        const fib = indicatorData.fibRetracement;
        const fibColor = indicators?.fibRetracement?.color || '#FFD54F';
        const ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
        fib.levels.forEach((level: number, idx: number) => {
          const y = priceToY(level, priceRange);
          ctx.strokeStyle = fibColor;
          ctx.lineWidth = indicators?.fibRetracement?.lineWidth || 1;
          ctx.setLineDash(idx === 0 || idx === 6 ? [] : [4, 3]);
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(chartWidth, y);
          ctx.stroke();
          ctx.fillStyle = fibColor;
          ctx.font = SUBPLOT_LABEL_FONT;
          ctx.textAlign = 'left';
          ctx.fillText(`${(ratios[idx] * 100).toFixed(1)}% (${level.toFixed(2)})`, 5, y - 3);
        });
        ctx.setLineDash([]);
        ctx.restore();
      }

      // Camarilla Pivots overlay
      if (indicatorData?.camarillaPivots) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, chartWidth, mainChartHeight);
        ctx.clip();
        const cam = indicatorData.camarillaPivots;
        const rColor = indicators?.camarillaPivots?.resistanceColor || '#ef4444';
        const sColor = indicators?.camarillaPivots?.supportColor || '#22c55e';
        const drawCamLine = (data: number[], color: string, label: string) => {
          const lastVal = data.filter((v: number) => !isNaN(v) && isFinite(v)).pop();
          if (lastVal !== undefined) {
            const y = priceToY(lastVal, priceRange);
            ctx.strokeStyle = color;
            ctx.lineWidth = indicators?.camarillaPivots?.lineWidth || 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(chartWidth, y);
            ctx.stroke();
            ctx.fillStyle = color;
            ctx.font = SUBPLOT_LABEL_FONT;
            ctx.textAlign = 'left';
            ctx.fillText(label, 5, y - 3);
          }
        };
        drawCamLine(cam.h4, rColor, 'H4');
        drawCamLine(cam.h3, rColor, 'H3');
        drawCamLine(cam.l3, sColor, 'L3');
        drawCamLine(cam.l4, sColor, 'L4');
        ctx.setLineDash([]);
        ctx.restore();
      }

      // Woodie's Pivots overlay
      if (indicatorData?.woodiePivots) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, chartWidth, mainChartHeight);
        ctx.clip();
        const wp = indicatorData.woodiePivots;
        const pColor = indicators?.woodiePivots?.pivotColor || '#FFEB3B';
        const wrColor = indicators?.woodiePivots?.resistanceColor || '#ef4444';
        const wsColor = indicators?.woodiePivots?.supportColor || '#22c55e';
        const drawWLine = (data: number[], color: string, label: string) => {
          const lastVal = data.filter((v: number) => !isNaN(v) && isFinite(v)).pop();
          if (lastVal !== undefined) {
            const y = priceToY(lastVal, priceRange);
            ctx.strokeStyle = color;
            ctx.lineWidth = indicators?.woodiePivots?.lineWidth || 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(chartWidth, y);
            ctx.stroke();
            ctx.fillStyle = color;
            ctx.font = SUBPLOT_LABEL_FONT;
            ctx.textAlign = 'left';
            ctx.fillText(label, 5, y - 3);
          }
        };
        drawWLine(wp.pivot, pColor, 'WP');
        drawWLine(wp.r1, wrColor, 'WR1');
        drawWLine(wp.r2, wrColor, 'WR2');
        drawWLine(wp.s1, wsColor, 'WS1');
        drawWLine(wp.s2, wsColor, 'WS2');
        ctx.setLineDash([]);
        ctx.restore();
      }

      // Volume SMA overlay (drawn on volume bars)
      if (indicatorData?.volumeSma && hasVolume) {
        ctx.save();
        const volSma = indicatorData.volumeSma;
        const volumeAreaHeight = mainChartHeight * 0.2;
        const volumeBottom = mainChartHeight;
        const visVolumes = visible.candles.map(c => c.volume || 0);
        const maxVol = Math.max(...visVolumes, 1);
        ctx.strokeStyle = indicators?.volumeSma?.color || '#FF9800';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let s = false;
        visible.candles.forEach((_, i) => {
          const gi = visible.startIndex + i;
          const v = volSma[gi];
          if (!isNaN(v) && isFinite(v)) {
            const x = indexToX(gi, visible.startIndex);
            const y = volumeBottom - (v / maxVol) * volumeAreaHeight;
            if (!s) { ctx.moveTo(x, y); s = true; } else { ctx.lineTo(x, y); }
          }
        });
        ctx.stroke();
        ctx.restore();
      }

      // Draw Volume Profile if enabled (skip during fast scroll because it is O(numRows * visibleCandles) and highly expensive)
      if (!skipIndicators && indicators?.volumeProfile?.enabled && visible.candles.length > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, chartWidth, mainChartHeight);
        ctx.clip();

        const numRows = indicators.volumeProfile.numberOfRows ?? 48;
        const maxBarWidth = chartWidth * ((indicators.volumeProfile.rowWidth ?? 15) / 100);
        const opacity = (indicators.volumeProfile.opacity ?? 60) / 100;
        const upColor = indicators.volumeProfile.upColor || '#D97706'; // Deep amber for bullish
        const downColor = indicators.volumeProfile.downColor || '#1E3A8A'; // Saturated navy blue for bearish
        const pocColor = indicators.volumeProfile.pocColor || '#10B981'; // Emerald for POC (Point of Control)
        const lookbackBars = indicators.volumeProfile.lookbackBars ?? 0; // 0 = all visible

        // Determine which candles to use based on lookback setting
        const candlesToUse = lookbackBars > 0
          ? visible.candles.slice(-lookbackBars)  // Last N candles
          : visible.candles;  // All visible candles

        // Calculate price range for the selected candles
        let profilePriceMin = Infinity;
        let profilePriceMax = -Infinity;
        candlesToUse.forEach(c => {
          profilePriceMin = Math.min(profilePriceMin, c.low);
          profilePriceMax = Math.max(profilePriceMax, c.high);
        });
        const profilePriceRange = profilePriceMax - profilePriceMin || 1;

        // Calculate volume at each price level
        const priceStep = profilePriceRange / numRows;
        const volumeBins: Array<{ priceLevel: number; upVolume: number; downVolume: number; totalVolume: number }> = [];

        for (let i = 0; i < numRows; i++) {
          volumeBins.push({
            priceLevel: profilePriceMin + (i + 0.5) * priceStep,
            upVolume: 0,
            downVolume: 0,
            totalVolume: 0,
          });
        }

        // Distribute volume from selected candles into bins
        candlesToUse.forEach((candle) => {
          if (!candle.volume || candle.volume <= 0) return;

          const candleLow = candle.low;
          const candleHigh = candle.high;
          const candleRange = candleHigh - candleLow;
          const isBullish = candle.close >= candle.open;

          // Find bins that this candle touches
          for (let i = 0; i < numRows; i++) {
            const binLow = profilePriceMin + i * priceStep;
            const binHigh = binLow + priceStep;

            // Check if candle overlaps with this bin
            if (candleHigh >= binLow && candleLow <= binHigh) {
              // Calculate overlap percentage
              const overlapLow = Math.max(candleLow, binLow);
              const overlapHigh = Math.min(candleHigh, binHigh);
              const overlapRatio = candleRange > 0 ? (overlapHigh - overlapLow) / candleRange : 1;

              const volumeContribution = candle.volume * overlapRatio;

              if (isBullish) {
                volumeBins[i].upVolume += volumeContribution;
              } else {
                volumeBins[i].downVolume += volumeContribution;
              }
              volumeBins[i].totalVolume += volumeContribution;
            }
          }
        });

        // Find max volume for normalization and POC
        let maxVolume = 0;
        let pocIndex = 0;
        volumeBins.forEach((bin, i) => {
          if (bin.totalVolume > maxVolume) {
            maxVolume = bin.totalVolume;
            pocIndex = i;
          }
        });

        if (maxVolume > 0) {
          const barHeight = (mainChartHeight / numRows) * 0.85; // Slightly shorter than full row

          // Draw volume bars from right side
          volumeBins.forEach((bin, i) => {
            if (bin.totalVolume <= 0) return;

            const y = mainPriceToY(bin.priceLevel) - barHeight / 2;
            const totalBarWidth = (bin.totalVolume / maxVolume) * maxBarWidth;
            const upBarWidth = bin.totalVolume > 0 ? (bin.upVolume / bin.totalVolume) * totalBarWidth : 0;
            const downBarWidth = totalBarWidth - upBarWidth;

            const isPOC = i === pocIndex;

            // Draw from right edge of chart
            const barStartX = chartWidth - totalBarWidth;

            // Draw up volume (bullish) on the left side of the bar
            if (upBarWidth > 0) {
              ctx.globalAlpha = isPOC ? Math.min(opacity + 0.2, 1) : opacity;
              ctx.fillStyle = upColor;
              ctx.fillRect(barStartX, y, upBarWidth, barHeight);
            }

            // Draw down volume (bearish) on the right side
            // Use higher opacity for dark navy so it doesn't look grey
            if (downBarWidth > 0) {
              ctx.globalAlpha = isPOC ? 0.95 : 0.85;
              ctx.fillStyle = downColor;
              ctx.fillRect(barStartX + upBarWidth, y, downBarWidth, barHeight);
            }

            // Highlight POC with border
            if (isPOC) {
              ctx.globalAlpha = 0.9;
              ctx.strokeStyle = pocColor;
              ctx.lineWidth = 1.5;
              ctx.strokeRect(barStartX, y, totalBarWidth, barHeight);
            }
          });

          ctx.globalAlpha = 1;

          // Selection dots: when volume profile is selected, draw small circles
          // at the left edge (tip) of each bar for a clean selection indicator.
          if (clickedIndicatorKey === 'volumeProfile') {
            const SEL_R = 2.5;
            volumeBins.forEach((bin, i) => {
              if (bin.totalVolume <= 0) return;
              const dotY = mainPriceToY(bin.priceLevel);
              const totalBarW = (bin.totalVolume / maxVolume) * maxBarWidth;
              const dotX = chartWidth - totalBarW;
              // Dark border then colored fill
              ctx.beginPath();
              ctx.arc(dotX, dotY, SEL_R + 1, 0, Math.PI * 2);
              ctx.fillStyle = '#131722';
              ctx.fill();
              ctx.beginPath();
              ctx.arc(dotX, dotY, SEL_R, 0, Math.PI * 2);
              // Color matches whether this row is mostly bullish or bearish
              ctx.fillStyle = bin.upVolume >= bin.downVolume ? upColor : downColor;
              ctx.fill();
            });
          }
        }

        ctx.restore();
        ctx.restore();
      }
    }

    // ========================================================================
    // Selected Drawing Highlight Projections
    // ========================================================================
    interface AxisHighlight {
      pos: number;
      text: string;
      bWidth: number;
      topOrigin: number;
    }
    const activeXHighlights: AxisHighlight[] = [];
    const activeYHighlights: AxisHighlight[] = [];
    let activeBadgeFont = '';
    let activeBadgeColor = '';
    let activeBRowHeight = 14;
    let activeBYTopTime = 0;
    let activeBX = 0;

    // Skip the selected drawing's static blue badges when a draw/drag preview is
    // active (drawingCursorRef has data). During drag, the cursor badges already
    // show the displaced positions; rendering the original-position badges too
    // creates a confusing "two sets of lines" effect. Only render the static
    // activeY/XHighlights when the drawing is selected but NOT being moved.
    const cursorBadgeActive = drawingCursorRef?.current && drawingCursorRef.current.length > 0;
    if (selectedDrawingId && !cursorBadgeActive && drawings) {
      const selected = drawings.find(d => d.id === selectedDrawingId);
      if (selected && selected.points && selected.points.length > 0) {
        ctx.save();
        const badgeFont = cfg.badgeFont;
        const badgeColor = '#2962ff'; // TradingView standard active blue
        const shadeColor = 'rgba(41, 98, 255, 0.2)'; // Faint blue for date range highlight
        const badgePadding = cfg.badgePadding;
        const bRowHeight = cfg.badgeRowHeight;
        
        // Setup Y-axis boundaries
        const maxBWidth = PRICE_AXIS_WIDTH - 6;
        const bX = chartWidth + 3;

        // Setup X-axis boundaries
        const timeAxisY = dimensions.height - TIME_AXIS_HEIGHT;
        const bYTopTime = timeAxisY + (TIME_AXIS_HEIGHT - bRowHeight) / 2;

        activeBadgeFont = badgeFont;
        activeBadgeColor = badgeColor;
        activeBRowHeight = bRowHeight;
        activeBYTopTime = bYTopTime;
        activeBX = bX;

        selected.points.forEach(pt => {
          let xPos: number | null = null;
          let yPos: number | null = null;

          if (pt.price !== undefined) {
            yPos = mainPriceToY(pt.price);
            if (yPos >= 0 && yPos <= mainChartHeight) {
              const priceTxt = formatPrice(pt.price);
              const priceTWidth = ctx.measureText(priceTxt).width;
              const priceBWidth = Math.min(priceTWidth + badgePadding * 2, maxBWidth);
              const priceBYTop = yPos - bRowHeight / 2;

              activeYHighlights.push({
                pos: yPos,
                text: priceTxt,
                bWidth: priceBWidth,
                topOrigin: priceBYTop
              });
            }
          }

          if (pt.time !== undefined) {
            let idx = -1;
            if (candles.length > 0) {
              const first = candles[0].time;
              const last = candles[candles.length - 1].time;
              const timeInterval = candles.length > 1 ? candles[1].time - candles[0].time : 60000;
              if (pt.time > last) idx = candles.length - 1 + (pt.time - last) / timeInterval;
              else if (pt.time < first) idx = (pt.time - first) / timeInterval;
              else {
                let l = 0, r = candles.length - 1;
                while (l <= r) {
                  const m = Math.floor((l + r) / 2);
                  if (candles[m].time === pt.time) { idx = m; break; }
                  if (candles[m].time < pt.time) l = m + 1;
                  else r = m - 1;
                }
                if (idx === -1) {
                  const right = l;
                  const left = right - 1;
                  if (left >= 0 && right < candles.length) {
                    const prevCandle = candles[left];
                    const nextCandle = candles[right];
                    const ratio = (pt.time - prevCandle.time) / (nextCandle.time - prevCandle.time);
                    idx = left + ratio;
                  } else {
                    idx = l;
                  }
                }
              }
            }
            
            if (idx !== -1) {
              const rawStartIndex = scrollStateRef.current.startIndex;
              const currentCandleWidth = scrollStateRef.current.candleWidth;
              const currentCandleSpacing = currentCandleWidth * (1 + CANDLE_GAP_RATIO);
              const flooredStartIndex = Math.floor(rawStartIndex);
              const fractionalOffset = (rawStartIndex - flooredStartIndex) * currentCandleSpacing;
              xPos = (idx - flooredStartIndex) * currentCandleSpacing + currentCandleSpacing / 2 - fractionalOffset;
            }

            if (xPos !== null && xPos >= 0 && xPos <= chartWidth) {
              const dt = new Date(pt.time);
              const day = dt.getDate().toString().padStart(2, '0');
              const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
              const month = months[dt.getMonth()];
              const yr = dt.getFullYear().toString().slice(2);
              const hr = dt.getHours().toString().padStart(2, '0');
              const mn = dt.getMinutes().toString().padStart(2, '0');
              // TradingView uses strict day string prefixes, we extract Ddd (e.g. Fri)
              const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
              const weekday = days[dt.getDay()];
              
              const timeTxt = `${weekday} ${day} ${month} '${yr}  ${hr}:${mn}`;
              const timeTWidth = ctx.measureText(timeTxt).width;
              const timeBWidth = timeTWidth + badgePadding * 2;
              let timeXTop = xPos - timeBWidth / 2;
              
              if (timeXTop < 0) timeXTop = 0;
              if (timeXTop + timeBWidth > chartWidth) timeXTop = chartWidth - timeBWidth;

              activeXHighlights.push({
                pos: xPos,
                text: timeTxt,
                bWidth: timeBWidth,
                topOrigin: timeXTop
              });
            }
          }
        });

        // Long/Short drawings store stopLoss separately from points[].
        // Add the SL price to activeYHighlights so the Y-axis gets a blue
        // highlight band covering the full range (entry to TP AND entry to SL),
        // not just entry to TP.
        if ((selected.type === 'long' || selected.type === 'short') && selected.stopLoss) {
          const slPrice = selected.stopLoss.price;
          const slY = mainPriceToY(slPrice);
          if (slY >= 0 && slY <= mainChartHeight) {
            ctx.font = activeBadgeFont || badgeFont;
            const slTxt = formatPrice(slPrice);
            const slTWidth = ctx.measureText(slTxt).width;
            const slBWidth = Math.min(slTWidth + badgePadding * 2, maxBWidth);
            const slBYTop = slY - bRowHeight / 2;
            activeYHighlights.push({
              pos: slY,
              text: slTxt,
              bWidth: slBWidth,
              topOrigin: slBYTop
            });
          }
        }

        // ----------------------------------------------------
        // Render X-Axis Time Highlights Background Shading
        // ----------------------------------------------------
        if (activeXHighlights.length >= 2) {
          const minX = Math.min(...activeXHighlights.map(h => h.pos));
          const maxX = Math.max(...activeXHighlights.map(h => h.pos));
          if (maxX > minX) {
            ctx.fillStyle = shadeColor;
            ctx.fillRect(minX, timeAxisY, maxX - minX, TIME_AXIS_HEIGHT);
          }
        }

        // ----------------------------------------------------
        // Render Y-Axis Price Highlights Background Shading
        // ----------------------------------------------------
        if (activeYHighlights.length >= 2) {
          const minY = Math.min(...activeYHighlights.map(h => h.pos));
          const maxY = Math.max(...activeYHighlights.map(h => h.pos));
          if (maxY > minY) {
            ctx.fillStyle = shadeColor;
            // Shaded region full width of the price axis between the two Y spots
            ctx.fillRect(bX - 3, minY, PRICE_AXIS_WIDTH, maxY - minY);
          }
        }

        ctx.restore();
      }
    }



    // Draw Y-axis price labels first (so live price badge can draw on top)
    // TradingView style: clean font, right-aligned with generous padding, plus ticks
    ctx.fillStyle = colors.axisLabel || '#787b86';
    ctx.font = PRICE_LABEL_FONT;
    ctx.textBaseline = 'middle';

    // Desktop right-aligns labels against the RightToolbar icons; phone/tablet
    // left-align with 2px gap (no toolbar overlay). cfg.priceLabelAlign drives both.
    ctx.textAlign = cfg.priceLabelAlign;
    const priceLabelX = cfg.priceLabelAlign === 'right'
      ? (width - (rightOffset !== undefined ? rightOffset : RIGHT_TOOLBAR_WIDTH) - 4)
      : (chartWidth + 2);

    // Mirror the MIN_GRID_GAP filter used for grid lines so labels
    // stay in sync and don't crowd in short panels.
    let lastLabelY = -Infinity;
    for (let price = startPrice; price <= priceRange.max; price += priceStep) {
      const y = mainPriceToY(price);
      // Only draw if within visible chart area with some margin
      if (y >= 10 && y <= mainChartHeight - 10) {
        if (Math.abs(y - lastLabelY) < MIN_GRID_GAP) continue;
        lastLabelY = y;
        ctx.fillText(formatPrice(price), priceLabelX, y);
      }
    }

    // TradingView-style horizontal live price line (drawn AFTER y-axis labels)
    const liveLinePrice =
      livePrice !== null && livePrice !== undefined && !Number.isNaN(livePrice)
        ? livePrice
        : (visible.candles.length ? visible.candles[visible.candles.length - 1].close : null);

    if (liveLinePrice !== null && liveLinePrice !== undefined && !Number.isNaN(liveLinePrice) && !showBidAskSpread) {
      const y = mainPriceToY(liveLinePrice);

      if (y >= 0 && y <= mainChartHeight) {
        ctx.save();

        // Determine live price color based on candle direction (TradingView style)
        // Compare live price to previous candle's close
        const prevCandle = visible.candles.length >= 2
          ? visible.candles[visible.candles.length - 2]
          : null;
        const lastCandle = visible.candles.length >= 1
          ? visible.candles[visible.candles.length - 1]
          : null;
        const refClose = prevCandle ? prevCandle.close : (lastCandle ? lastCandle.open : liveLinePrice);
        const isLiveBullish = liveLinePrice >= refClose;
        // Use dedicated price ticker colors (from settings), falling back to candle body colors
        const tickerBullColor = colors.priceTickerBullish || colors.bullish;
        const tickerBearColor = colors.priceTickerBearish || colors.bearish;
        const liveColor = isLiveBullish ? tickerBullColor : tickerBearColor;
        // The dashed last-price line is the neutral axis grey, NOT the badge
        // colour: the badge defaults to the dark crosshair-label fill
        // (deliberately no green/red tag) and a line derived from that fill is
        // darker than the chart background, i.e. invisible. textDim reads on
        // both themes; the two alphas keep the "faint behind the candles,
        // solid to the right of the last one" split.
        const hexToRgb = (hex: string): string => {
          const h = hex.replace('#', '');
          const r = parseInt(h.substring(0, 2), 16);
          const g = parseInt(h.substring(2, 4), 16);
          const b = parseInt(h.substring(4, 6), 16);
          return `${r}, ${g}, ${b}`;
        };
        const lineRgb = hexToRgb(colors.textDim || '#666666');
        const liveFaintColor = `rgba(${lineRgb}, 0.35)`;
        const liveBrightColor = `rgba(${lineRgb}, 0.9)`;
        // Badge text picks black/white off the badge fill (same rule as the
        // crosshair label) so a user-chosen light ticker colour stays legible.
        const badgeRgb = hexToRgb(liveColor).split(',').map(Number);
        const badgeLum = (0.299 * badgeRgb[0] + 0.587 * badgeRgb[1] + 0.114 * badgeRgb[2]) / 255;
        const badgeText = Number.isNaN(badgeLum) || badgeLum <= 0.55 ? '#ffffff' : '#000000';

        // Calculate the last candle's X position
        const lastCandleIndex = visible.candles.length - 1;
        const lastCandleX = visible.candles.length > 0
          ? indexToX(visible.startIndex + lastCandleIndex, visible.startIndex)
          : 0;

        // PART 1: Faint line behind the last candle (left side)
        if (lastCandleX > 0) {
          ctx.strokeStyle = liveFaintColor;
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(lastCandleX, y);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // PART 2: Bright line from candle to right edge
        ctx.strokeStyle = liveBrightColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(lastCandleX, y);
        ctx.lineTo(chartWidth, y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Y-axis price badge with countdown (TradingView style), single unified box
        const priceText = formatPrice(liveLinePrice);
        const livePriceFont = PRICE_LABEL_FONT;
        const liveCountdownFont = cfg.liveCountdownFont;
        ctx.font = livePriceFont;
        const textMetrics = ctx.measureText(priceText);
        const textWidth = textMetrics.width;
        const labelPadding = cfg.livePriceLabelPadding;
        const priceRowHeight = cfg.livePriceRowHeight;

        // Calculate countdown dimensions if present
        const hasCountdown = countdown && countdown.length > 0;
        const countdownRowHeight = hasCountdown ? cfg.countdownRowHeight : 0;
        const totalBoxHeight = priceRowHeight + countdownRowHeight;

        // Measure countdown width to determine badge width
        let countdownTextWidth = 0;
        if (hasCountdown) {
          ctx.font = liveCountdownFont;
          countdownTextWidth = ctx.measureText(countdown).width;
        }

        // Constrain badge to fit within the price axis area (no overflow)
        const maxBadgeWidth = PRICE_AXIS_WIDTH - 6;
        const naturalWidth = Math.max(textWidth, countdownTextWidth) + labelPadding * 2;
        const labelWidth = Math.min(naturalWidth, maxBadgeWidth);
        const labelX = chartWidth + 3;
        const labelY = y - priceRowHeight / 2;

        // Clear area behind badge
        ctx.fillStyle = colors.background;
        ctx.fillRect(labelX - 1, labelY - 1, labelWidth + 2, totalBoxHeight + 2);

        // Single unified box with rounded corners
        ctx.fillStyle = liveColor;
        ctx.beginPath();
        ctx.roundRect(labelX, labelY, labelWidth, totalBoxHeight, 3);
        ctx.fill();

        // Price text, centered in top row
        ctx.fillStyle = badgeText;
        ctx.font = livePriceFont;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(priceText, labelX + labelWidth / 2, labelY + priceRowHeight / 2);

        // Countdown in bottom row (if present)
        if (hasCountdown) {
          // Subtle separator line
          ctx.strokeStyle = badgeText === '#ffffff' ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)';
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(labelX + 3, labelY + priceRowHeight);
          ctx.lineTo(labelX + labelWidth - 3, labelY + priceRowHeight);
          ctx.stroke();

          ctx.fillStyle = badgeText === '#ffffff' ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.85)';
          ctx.font = liveCountdownFont;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(countdown, labelX + labelWidth / 2, labelY + priceRowHeight + countdownRowHeight / 2);
        }

        ctx.restore();
      }
    }

    // ========================================================================
    // Custom Price Badges (from drawings)
    // ========================================================================
    if (drawings && drawings.length > 0) {
      ctx.save();
      const badgeFont = PRICE_LABEL_FONT;
      ctx.font = badgeFont;
      const badgePadding = cfg.badgePadding;
      const bRowHeight = cfg.badgeRowHeight;

      const priceBadgesToDraw: { price: number; color: string; yPos: number }[] = [];
      const timeBadgesToDraw: { time: number; color: string; xPos: number }[] = [];

      drawings.forEach(d => {
        // (Selected drawing endpoints are handled separately below to render BEFORE live price badge)


        // Show price badge on Y-axis for both horizontal lines and horizontal rays,
        // so users can see the exact price level on the right-side price scale
        if ((d.type === 'horizontalRay' || d.type === 'horizontal') && d.points.length > 0) {
          const p = d.points[0].price;
          priceBadgesToDraw.push({ price: p, color: d.color || '#2196f3', yPos: mainPriceToY(p) });
        } else if ((d.type === 'long' || d.type === 'short') && d.points.length >= 2) {
          // Skip colored badges for the selected long/short drawing because
          // the blue activeYHighlights badges already render its entry, TP, and SL.
          // Drawing both causes a red SL badge overlapping the blue one.
          if (d.id === selectedDrawingId) return;
          const entryPrice = d.points[0].price;
          const targetPrice = d.points[1].price;

          priceBadgesToDraw.push({ price: entryPrice, color: '#4b5563', yPos: mainPriceToY(entryPrice) });
          priceBadgesToDraw.push({ price: targetPrice, color: '#22c55e', yPos: mainPriceToY(targetPrice) });

          if (d.stopLoss) {
            const slPrice = d.stopLoss.price;
            priceBadgesToDraw.push({ price: slPrice, color: '#ef4444', yPos: mainPriceToY(slPrice) });
          }
        }
      });

      // Avoid overlapping with livePrice badge if livePrice exists
      let liveBoxYTop = -9999;
      let liveBoxYBot = -9999;
      if (liveLinePrice !== null && liveLinePrice !== undefined && !Number.isNaN(liveLinePrice)) {
        const lpY = mainPriceToY(liveLinePrice);
        const lH = cfg.livePriceRowHeight + (countdown && countdown.length > 0 ? cfg.countdownRowHeight : 0);
        liveBoxYTop = lpY - cfg.livePriceRowHeight / 2;
        liveBoxYBot = liveBoxYTop + lH;
      }

      const MIN_SPACING = 2; // minimum pixels between badges
      const maxBWidth = PRICE_AXIS_WIDTH - 6;
      // Y-axis alignment: exactly matching live line badge X position
      const bX = chartWidth + 3;

      // Sort by Y-coordinate
      priceBadgesToDraw.sort((a, b) => a.yPos - b.yPos);

      // Simple collision resolution (shift down if overlapping)
      let currentY = -9999;
      priceBadgesToDraw.forEach(badge => {
        let bYTop = badge.yPos - bRowHeight / 2;
        let bYBot = bYTop + bRowHeight;

        // Push down if colliding with previous badge
        if (bYTop < currentY + MIN_SPACING) {
          bYTop = currentY + MIN_SPACING;
          bYBot = bYTop + bRowHeight;
        }

        // Push down if colliding with live price badge
        if (bYTop < liveBoxYBot + MIN_SPACING && bYBot > liveBoxYTop - MIN_SPACING) {
          bYTop = liveBoxYBot + MIN_SPACING;
          bYBot = bYTop + bRowHeight;
        }

        currentY = bYBot;

        // Draw it if it's within visible bounds
        if (bYTop >= 0 && bYBot <= mainChartHeight) {
          const txt = formatPrice(badge.price);
          const tWidth = ctx.measureText(txt).width;
          const bWidth = Math.min(tWidth + badgePadding * 2, maxBWidth);
          
          ctx.fillStyle = badge.color;
          ctx.beginPath();
          ctx.roundRect(bX, bYTop, bWidth, bRowHeight, 3);
          ctx.fill();

          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(txt, bX + bWidth / 2, bYTop + bRowHeight / 2);
        }
      });

      // Render Time Badges
      ctx.font = cfg.alertFlagFont;
      timeBadgesToDraw.forEach(badge => {
        if (badge.xPos >= 0 && badge.xPos <= chartWidth) {
           const timeStr = formatDate(badge.time, true) + ' ' + formatTime(badge.time); // Match crosshair style
           const tWidth = ctx.measureText(timeStr).width;
           const bWidth = tWidth + badgePadding * 2;
           
           // Render on bottom time axis
           // Time axis start is mainChartHeight + all subplot heights, basically it's dimensions.height - TIME_AXIS_HEIGHT
           const timeAxisY = dimensions.height - TIME_AXIS_HEIGHT;
           const bYTop = timeAxisY + (TIME_AXIS_HEIGHT - bRowHeight) / 2;
           let tXTop = badge.xPos - bWidth / 2;

           // Prevent spilling off edges
           if (tXTop < 0) tXTop = 0;
           if (tXTop + bWidth > chartWidth) tXTop = chartWidth - bWidth;

           ctx.fillStyle = badge.color;
           ctx.beginPath();
           ctx.roundRect(tXTop, bYTop, bWidth, bRowHeight, 3);
           ctx.fill();

           ctx.fillStyle = '#ffffff';
           ctx.textAlign = 'center';
           ctx.textBaseline = 'middle';
           ctx.fillText(timeStr, tXTop + bWidth / 2, bYTop + bRowHeight / 2);
        }
      });

      ctx.restore();
    }

    // ========================================================================
    // Bid/Ask Spread Lines (MT5-style), only on broker demo
    // ========================================================================
    if (showBidAskSpread && liveLinePrice !== null && liveLinePrice !== undefined && !Number.isNaN(liveLinePrice)) {
      // Calculate realistic spread per instrument type
      // On real brokers, the chart price IS the bid. Ask = bid + spread.
      const sym = (symbol || '').toUpperCase();
      let spread: number;
      if (sym.includes('XAU')) {
        spread = 0.50; // Gold: ~50 cent spread
      } else if (sym.includes('XAG')) {
        spread = 0.03; // Silver
      } else if (sym.includes('NAS100') || sym.includes('SPX500') || sym.includes('US30') || sym.includes('US2000')) {
        spread = 1.5; // Indices: ~1.5 point spread
      } else if (sym.includes('BCO') || sym.includes('WTICO')) {
        spread = 0.05; // Oil
      } else if (sym.includes('BTC')) {
        spread = 16; // Bitcoin
      } else if (sym.includes('ETH')) {
        spread = 3; // Ethereum
      } else if (sym.includes('JPY')) {
        spread = 0.015; // JPY pairs: ~1.5 pip spread
      } else if (/EUR|GBP|AUD|NZD|CAD|CHF/.test(sym)) {
        spread = 0.00015; // Forex majors: ~1.5 pip spread
      } else {
        spread = liveLinePrice * 0.0002; // Default: 0.02% of price
      }

      const bidPrice = liveLinePrice; // Chart price = bid
      const askPrice = liveLinePrice + spread; // Ask sits above
      const bidY = mainPriceToY(bidPrice);
      const askY = mainPriceToY(askPrice);

      // Only draw if within visible area
      ctx.save();

      // Bid line: solid blue (#1976d2), same color as the Buy button
      if (bidY >= 0 && bidY <= mainChartHeight) {
        ctx.strokeStyle = '#1976d2';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(0, bidY);
        ctx.lineTo(chartWidth, bidY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Bid price label on axis: solid blue background, white text
        const bidText = formatPrice(bidPrice);
        ctx.font = cfg.alertCountFont;
        const bidTw = ctx.measureText(bidText).width;
        const bidLabelW = bidTw + 22;
        const bidLabelH = 16;
        const bidLabelX = chartWidth + 2;

        ctx.fillStyle = '#1976d2';
        ctx.beginPath();
        ctx.roundRect(bidLabelX, bidY - bidLabelH / 2, Math.min(bidLabelW, PRICE_AXIS_WIDTH - 4), bidLabelH, 2);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('B', bidLabelX + 4, bidY);
        ctx.fillText(bidText, bidLabelX + 14, bidY);
      }

      // Ask line: solid red (#d32f2f), same color as the Sell button
      if (askY >= 0 && askY <= mainChartHeight) {
        ctx.strokeStyle = '#d32f2f';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(0, askY);
        ctx.lineTo(chartWidth, askY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Ask price label on axis: solid red background, white text
        const askText = formatPrice(askPrice);
        ctx.font = cfg.alertCountFont;
        const askTw = ctx.measureText(askText).width;
        const askLabelW = askTw + 22;
        const askLabelH = 16;
        const askLabelX = chartWidth + 2;

        ctx.fillStyle = '#d32f2f';
        ctx.beginPath();
        ctx.roundRect(askLabelX, askY - askLabelH / 2, Math.min(askLabelW, PRICE_AXIS_WIDTH - 4), askLabelH, 2);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('A', askLabelX + 4, askY);
        ctx.fillText(askText, askLabelX + 14, askY);
      }

      // Spread shading between bid and ask
      if (bidY >= 0 && askY >= 0 && bidY <= mainChartHeight && askY <= mainChartHeight) {
        ctx.fillStyle = 'rgba(148, 163, 184, 0.04)'; // very subtle fill
        ctx.fillRect(0, Math.min(askY, bidY), chartWidth, Math.abs(bidY - askY));
      }

      ctx.restore();
    }

    // ── Position lines and SL/TP rendering (extracted to renderers/positionRenderer.ts) ──
    // MT5-style entry lines for all positions, plus interactive SL/TP lines
    // and Place/Cancel/Close buttons for the selected position.
    if (positionLines && positionLines.length > 0) {
      const posCtx: PositionRenderContext = {
        ctx, chartWidth, mainChartHeight, mainPriceToY, formatPrice,
        colors: {
          slColor: (colors as any).slColor,
          slOpacity: (colors as any).slOpacity,
          tpColor: (colors as any).tpColor,
          tpOpacity: (colors as any).tpOpacity,
        },
        selectedPositionId: selectedPositionRef.current,
        slDraft: slDraftRef.current,
        tpDraft: tpDraftRef.current,
        hoveredSLTP: hoveredSLTPRef.current,
        draggingHandle: draggingHandleRef.current,
      };
      renderPositionLines(posCtx, positionLines);
      renderSelectedPositionSLTP(posCtx, positionLines);
    }


    // ─── TradingView-style selection dots on overlay indicator lines ─────
    // When an overlay indicator is selected (clicked), draw small filled
    // squares at regular intervals along the line. Drawn on the main canvas
    // (not overlay) so dots persist regardless of mouse position.
    if (clickedIndicatorKey && !clickedIndicatorKey.startsWith('sp-') && indicatorData) {
      const pr = priceRange;
      if (pr && mainChartHeight > 0) {
        // Small round dots every 8 candles, matching TradingView's minimal aesthetic.
        // Radius 2.5px with 1px dark stroke gives a clean, unobtrusive marker.
        const SEL_DOT_INTERVAL = 8;
        const SEL_DOT_R = 2.5;

        const drawSelDots = (data: number[], color: string) => {
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, chartWidth, mainChartHeight);
          ctx.clip();

          for (let i = 0; i < visible.candles.length; i += SEL_DOT_INTERVAL) {
            const gi = visible.startIndex + i;
            if (gi >= data.length) continue;
            const val = data[gi];
            if (isNaN(val) || !isFinite(val)) continue;
            const dx = indexToX(gi, visible.startIndex);
            const dy = mainChartHeight - ((val - pr.min) / pr.range) * mainChartHeight;

            // Thin dark ring for contrast, then filled circle in indicator colour
            ctx.beginPath();
            ctx.arc(dx, dy, SEL_DOT_R + 1, 0, Math.PI * 2);
            ctx.fillStyle = '#131722';
            ctx.fill();
            ctx.beginPath();
            ctx.arc(dx, dy, SEL_DOT_R, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
          }
          ctx.restore();
        };

        const key = clickedIndicatorKey;
        if (key === 'movingAverages' && indicatorData.movingAverages) {
          for (const ma of indicatorData.movingAverages) drawSelDots(ma.data, ma.color);
        } else if (key === 'bollinger' && indicatorData.bollinger) {
          const bb = indicatorData.bollinger;
          drawSelDots(bb.upper, indicators?.bollinger?.upperColor || '#9B59B6');
          drawSelDots(bb.middle, indicators?.bollinger?.middleColor || '#9B59B6');
          drawSelDots(bb.lower, indicators?.bollinger?.lowerColor || '#9B59B6');
        } else if (key === 'vwap' && indicatorData.vwap) {
          drawSelDots(indicatorData.vwap, '#ff9800');
        } else if (key === 'ichimoku' && indicatorData.ichimoku) {
          const ich = indicatorData.ichimoku;
          drawSelDots(ich.tenkan, '#0094FF');
          drawSelDots(ich.kijun, '#AD1457');
          drawSelDots(ich.senkouA, '#4CAF50');
          drawSelDots(ich.senkouB, '#FF5722');
        } else if (key === 'keltner' && indicatorData.keltner) {
          drawSelDots(indicatorData.keltner.upper, '#3b82f6');
          drawSelDots(indicatorData.keltner.middle, '#3b82f6');
          drawSelDots(indicatorData.keltner.lower, '#3b82f6');
        } else if (key === 'donchian' && indicatorData.donchian) {
          drawSelDots(indicatorData.donchian.upper, '#3b82f6');
          drawSelDots(indicatorData.donchian.middle, '#3b82f6');
          drawSelDots(indicatorData.donchian.lower, '#3b82f6');
        } else if (key === 'envelopes' && indicatorData.envelopes) {
          drawSelDots(indicatorData.envelopes.upper, '#3b82f6');
          drawSelDots((indicatorData.envelopes as any).basis, '#3b82f6');
          drawSelDots(indicatorData.envelopes.lower, '#3b82f6');
        } else if (key === 'supertrend' && indicatorData.supertrend) {
          const stData = (indicatorData.supertrend as any).map((s: any) => s?.value ?? NaN);
          drawSelDots(stData, '#3b82f6');
        } else if (['dema', 'tema', 'hma'].includes(key)) {
          const data = (indicatorData as any)[key];
          if (Array.isArray(data)) drawSelDots(data, '#3b82f6');
        }
      }
    }

    // Draw indicator subplots (skip during fast scroll for performance)
    let currentSubplotY = mainChartHeight;

    if (!skipIndicators && indicatorData?.rsi) {
      const rsiHeight = subplotHeight;
      const rsiTop = currentSubplotY;
      const rsiBottom = rsiTop + rsiHeight;
      const rsiStyle = indicators?.rsi?.style || {};

      // Draw background with configurable color
      if (rsiStyle.backgroundColor) {
        ctx.fillStyle = rsiStyle.backgroundColor;
        ctx.globalAlpha = rsiStyle.backgroundOpacity ?? 0.3;
        ctx.fillRect(0, rsiTop, chartWidth, rsiHeight);
        ctx.globalAlpha = 1;
      }

      // Draw separator line
      ctx.strokeStyle = colors.textDim;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, rsiTop);
      ctx.lineTo(chartWidth, rsiTop);
      ctx.stroke();

      // Helper for RSI Y coordinate
      const rsiToY = (value: number) => {
        return rsiTop + rsiHeight - (value / 100) * rsiHeight;
      };

      const rsiOverbought = indicators?.rsi?.overbought ?? 70;
      const rsiOversold = indicators?.rsi?.oversold ?? 30;

      // Draw zone highlighting if enabled
      if (rsiStyle.showZones) {
        const overboughtY = rsiToY(rsiOverbought);
        const oversoldY = rsiToY(rsiOversold);
        const zoneOpacity = rsiStyle.zoneOpacity ?? 0.1;

        // Overbought zone (top)
        ctx.fillStyle = rsiStyle.overboughtZoneColor || '#ff4444';
        ctx.globalAlpha = zoneOpacity;
        ctx.fillRect(0, rsiTop, chartWidth, overboughtY - rsiTop);

        // Oversold zone (bottom)
        ctx.fillStyle = rsiStyle.oversoldZoneColor || '#44ff44';
        ctx.fillRect(0, oversoldY, chartWidth, rsiBottom - oversoldY);
        ctx.globalAlpha = 1;
      }

      // Draw RSI grid lines - overbought/oversold from config and 50 midline
      if (rsiStyle.showGrid !== false) {
        const gridColor = rsiStyle.gridColor || 'rgba(150, 150, 150, 0.3)';
        ctx.setLineDash([4, 4]);
        [rsiOversold, 50, rsiOverbought].forEach(level => {
          ctx.beginPath();
          if (level === 50) {
            ctx.strokeStyle = gridColor;
            ctx.lineWidth = 1;
          } else {
            // Overbought/oversold lines - make them stand out more
            ctx.strokeStyle = 'rgba(180, 130, 80, 0.8)';
            ctx.lineWidth = 1.5;
          }
          const y = rsiToY(level);
          ctx.moveTo(0, y);
          ctx.lineTo(chartWidth, y);
          ctx.stroke();
        });
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
      }

      // Draw RSI line with configurable color and width
      const rsiColor = indicators?.rsi?.color || '#E74C3C';
      const rsiLineWidth = rsiStyle.lineWidth ?? 1.5;
      ctx.strokeStyle = rsiColor;
      ctx.lineWidth = rsiLineWidth;
      ctx.beginPath();
      let started = false;
      visible.candles.forEach((candle, i) => {
        const globalIdx = visible.startIndex + i;
        const value = indicatorData.rsi![globalIdx];

        if (!isNaN(value) && isFinite(value)) {
          const x = indexToX(globalIdx, visible.startIndex);
          const y = rsiToY(value);

          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      });
      ctx.stroke();

      // Draw RSI axis labels - use medium gray for visibility
      ctx.fillStyle = '#6b7280';
      ctx.font = SUBPLOT_LABEL_FONT;
      ctx.textAlign = 'left';
      [0, rsiOversold, 50, rsiOverbought, 100].forEach(level => {
        const y = rsiToY(level);
        ctx.fillText(level.toString(), chartWidth + 5, y);
      });

      // Store RSI bounds for click detection
      indicatorBoundsRef.current.rsi = { top: rsiTop, bottom: rsiBottom };

      // Draw RSI label with current value - TradingView style: "RSI 14 close  XX.XX"
      const rsiIdx = hoveredCandleIndexRef.current !== null
        ? hoveredCandleIndexRef.current
        : visible.startIndex + visible.candles.length - 1;
      const currentRsi = indicatorData.rsi[rsiIdx];
      const rsiValueText = !isNaN(currentRsi) && isFinite(currentRsi) ? currentRsi.toFixed(2) : '--';

      // Use custom label if set, otherwise default
      const defaultRsiLabel = `RSI ${indicators?.rsi?.period || 14} close`;
      const rsiLabel = indicators?.rsi?.style?.customLabel || defaultRsiLabel;

      // Draw label with customizable color
      const rsiLabelColor = indicators?.rsi?.style?.labelColor || '#d1d5db';
      ctx.fillStyle = rsiLabelColor;
      ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(rsiLabel, 5, rsiTop + 15);

      // Draw value in bright indicator color
      ctx.fillStyle = rsiColor;
      ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, sans-serif';
      const labelWidth = ctx.measureText(rsiLabel).width;
      ctx.fillText(rsiValueText, 13 + labelWidth, rsiTop + 15);
      subplotLabelEndXRef.current.rsi = 13 + labelWidth + ctx.measureText(rsiValueText).width + 8;

      currentSubplotY = rsiBottom;
    }

    // Draw MACD subplot if enabled
    if (!skipIndicators && indicatorData?.macd) {
      const macdHeight = subplotHeight;
      const macdTop = currentSubplotY;
      const macdBottom = macdTop + macdHeight;
      const macdStyle = indicators?.macd?.style || {};

      // Draw background with configurable color
      if (macdStyle.backgroundColor) {
        ctx.fillStyle = macdStyle.backgroundColor;
        ctx.globalAlpha = macdStyle.backgroundOpacity ?? 0.3;
        ctx.fillRect(0, macdTop, chartWidth, macdHeight);
        ctx.globalAlpha = 1;
      }

      // Draw separator line
      ctx.strokeStyle = colors.textDim;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, macdTop);
      ctx.lineTo(chartWidth, macdTop);
      ctx.stroke();

      // Find MACD range
      const macdValues = indicatorData.macd.macd.slice(visible.startIndex, visible.endIndex);
      const signalValues = indicatorData.macd.signal.slice(visible.startIndex, visible.endIndex);
      const histValues = indicatorData.macd.histogram.slice(visible.startIndex, visible.endIndex);
      const allValues = [...macdValues, ...signalValues, ...histValues].filter(v => !isNaN(v) && isFinite(v));
      const macdMin = Math.min(...allValues, 0);
      const macdMax = Math.max(...allValues, 0);
      const macdRange = macdMax - macdMin || 1;

      // Helper for MACD Y coordinate
      const macdToY = (value: number) => {
        return macdTop + macdHeight - ((value - macdMin) / macdRange) * macdHeight;
      };

      // Draw zero line
      if (macdStyle.showGrid !== false) {
        ctx.strokeStyle = macdStyle.gridColor || colors.grid;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        const zeroY = macdToY(0);
        ctx.moveTo(0, zeroY);
        ctx.lineTo(chartWidth, zeroY);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Draw histogram bars
      const barWidth = Math.max(2, currentCandleWidth * 0.5);
      const histUpColor = indicators?.macd?.histogramUpColor || '#26a69a';
      const histDownColor = indicators?.macd?.histogramDownColor || '#ef5350';
      const zeroY = macdToY(0);
      visible.candles.forEach((candle, i) => {
        const globalIdx = visible.startIndex + i;
        const value = indicatorData.macd!.histogram[globalIdx];

        if (!isNaN(value) && isFinite(value)) {
          const x = indexToX(globalIdx, visible.startIndex);
          const y = macdToY(value);
          const barHeight = Math.abs(zeroY - y);

          ctx.fillStyle = value >= 0 ? histUpColor : histDownColor;
          if (value >= 0) {
            ctx.fillRect(x - barWidth / 2, y, barWidth, barHeight);
          } else {
            ctx.fillRect(x - barWidth / 2, zeroY, barWidth, barHeight);
          }
        }
      });

      // Draw MACD line with configurable color
      const macdLineColor = indicators?.macd?.macdColor || '#3498DB';
      ctx.strokeStyle = macdLineColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      visible.candles.forEach((candle, i) => {
        const globalIdx = visible.startIndex + i;
        const value = indicatorData.macd!.macd[globalIdx];

        if (!isNaN(value) && isFinite(value)) {
          const x = indexToX(globalIdx, visible.startIndex);
          const y = macdToY(value);

          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      });
      ctx.stroke();

      // Draw Signal line with configurable color
      const signalLineColor = indicators?.macd?.signalColor || '#E67E22';
      ctx.strokeStyle = signalLineColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      started = false;
      visible.candles.forEach((candle, i) => {
        const globalIdx = visible.startIndex + i;
        const value = indicatorData.macd!.signal[globalIdx];

        if (!isNaN(value) && isFinite(value)) {
          const x = indexToX(globalIdx, visible.startIndex);
          const y = macdToY(value);

          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      });
      ctx.stroke();

      // Store MACD bounds for click detection
      indicatorBoundsRef.current.macd = { top: macdTop, bottom: macdBottom };

      // Draw MACD label with current values (or hovered values)
      const defaultMacdLabel = `MACD(${indicators?.macd?.fast || 12},${indicators?.macd?.slow || 26},${indicators?.macd?.signal || 9})`;
      const macdLabel = indicators?.macd?.style?.customLabel || defaultMacdLabel;

      const macdLabelColor = indicators?.macd?.style?.labelColor || colors.textDim;
      ctx.fillStyle = macdLabelColor;
      ctx.font = `bold ${SUBPLOT_LABEL_FONT}`;
      ctx.textAlign = 'left';
      const macdIdx = hoveredCandleIndexRef.current !== null
        ? hoveredCandleIndexRef.current
        : visible.startIndex + visible.candles.length - 1;
      const currentMacd = indicatorData.macd.macd[macdIdx];
      const currentSignal = indicatorData.macd.signal[macdIdx];
      const currentHist = indicatorData.macd.histogram[macdIdx];
      ctx.fillText(macdLabel, 5, macdTop + 12);
      // MACD value - position after the label
      ctx.fillStyle = macdLineColor;
      ctx.font = SUBPLOT_LABEL_FONT;
      const macdLabelWidth = ctx.measureText(macdLabel).width;
      const macdValText = !isNaN(currentMacd) && isFinite(currentMacd) ? currentMacd.toFixed(4) : '--';
      ctx.fillText(macdValText, 10 + macdLabelWidth, macdTop + 12);
      // Signal value
      ctx.fillStyle = signalLineColor;
      const signalValText = !isNaN(currentSignal) && isFinite(currentSignal) ? currentSignal.toFixed(4) : '--';
      const macdTextWidth = ctx.measureText(macdValText).width;
      ctx.fillText(signalValText, 16 + macdLabelWidth + macdTextWidth, macdTop + 12);
      // Histogram value
      const histValText = !isNaN(currentHist) && isFinite(currentHist) ? currentHist.toFixed(4) : '--';
      ctx.fillStyle = currentHist >= 0 ? '#00ff88' : '#ff0080';
      const signalTextWidth = ctx.measureText(signalValText).width;
      ctx.fillText(histValText, 22 + macdLabelWidth + macdTextWidth + signalTextWidth, macdTop + 12);
      subplotLabelEndXRef.current.macd = 22 + macdLabelWidth + macdTextWidth + signalTextWidth + ctx.measureText(histValText).width + 8;

      currentSubplotY = macdBottom;
    }

    // Draw ATR subplot if enabled
    if (!skipIndicators && indicatorData?.atr) {
      const atrHeight = subplotHeight;
      const atrTop = currentSubplotY;
      const atrBottom = atrTop + atrHeight;
      const atrStyle = indicators?.atr?.style || {};

      // Draw background with configurable color
      if (atrStyle.backgroundColor) {
        ctx.fillStyle = atrStyle.backgroundColor;
        ctx.globalAlpha = atrStyle.backgroundOpacity ?? 0.3;
        ctx.fillRect(0, atrTop, chartWidth, atrHeight);
        ctx.globalAlpha = 1;
      }

      // Draw separator line
      ctx.strokeStyle = colors.textDim;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, atrTop);
      ctx.lineTo(chartWidth, atrTop);
      ctx.stroke();

      // Find ATR range
      const atrValues = indicatorData.atr.slice(visible.startIndex, visible.endIndex).filter((v: number) => !isNaN(v) && isFinite(v));
      const atrMin = Math.min(...atrValues, 0);
      const atrMax = Math.max(...atrValues);
      const atrRange = atrMax - atrMin || 1;

      // Helper for ATR Y coordinate
      const atrToY = (value: number) => {
        return atrTop + atrHeight - ((value - atrMin) / atrRange) * atrHeight;
      };

      // Draw ATR line with configurable color and width
      const atrColor = indicators?.atr?.color || '#17a2b8';
      const atrLineWidth = atrStyle.lineWidth ?? 1.5;
      ctx.strokeStyle = atrColor;
      ctx.lineWidth = atrLineWidth;
      ctx.beginPath();
      let started = false;
      visible.candles.forEach((candle, i) => {
        const globalIdx = visible.startIndex + i;
        const value = indicatorData.atr![globalIdx];

        if (!isNaN(value) && isFinite(value)) {
          const x = indexToX(globalIdx, visible.startIndex);
          const y = atrToY(value);

          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      });
      ctx.stroke();

      // Store ATR bounds for click detection
      indicatorBoundsRef.current.atr = { top: atrTop, bottom: atrBottom };

      // Draw ATR label with current value (or hovered value)
      const defaultAtrLabel = `ATR(${indicators?.atr?.period || 14})`;
      const atrLabel = indicators?.atr?.style?.customLabel || defaultAtrLabel;

      const atrLabelColor = indicators?.atr?.style?.labelColor || colors.textDim;
      ctx.fillStyle = atrLabelColor;
      ctx.font = `bold ${SUBPLOT_LABEL_FONT}`;
      ctx.textAlign = 'left';
      const atrIdx = hoveredCandleIndexRef.current !== null
        ? hoveredCandleIndexRef.current
        : visible.startIndex + visible.candles.length - 1;
      const currentAtr = indicatorData.atr[atrIdx];
      const atrValueText = !isNaN(currentAtr) && isFinite(currentAtr) ? currentAtr.toFixed(5) : '--';
      ctx.fillText(atrLabel, 5, atrTop + 12);
      ctx.fillStyle = atrColor;
      ctx.font = SUBPLOT_LABEL_FONT;
      const atrLabelWidth = ctx.measureText(atrLabel).width;
      ctx.fillText(atrValueText, 10 + atrLabelWidth, atrTop + 12);
      subplotLabelEndXRef.current.atr = 10 + atrLabelWidth + ctx.measureText(atrValueText).width + 8;

      currentSubplotY = atrBottom;
    }

    // Draw Stochastic subplot if enabled
    if (!skipIndicators && indicatorData?.stochastic) {
      const stochHeight = subplotHeight;
      const stochTop = currentSubplotY;
      const stochBottom = stochTop + stochHeight;
      const stochStyle = indicators?.stochastic?.style || {};

      // Draw background with configurable color
      if (stochStyle.backgroundColor) {
        ctx.fillStyle = stochStyle.backgroundColor;
        ctx.globalAlpha = stochStyle.backgroundOpacity ?? 0.3;
        ctx.fillRect(0, stochTop, chartWidth, stochHeight);
        ctx.globalAlpha = 1;
      }

      // Draw separator line
      ctx.strokeStyle = colors.textDim;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, stochTop);
      ctx.lineTo(chartWidth, stochTop);
      ctx.stroke();

      // Helper for Stochastic Y coordinate (0-100 range)
      const stochToY = (value: number) => {
        return stochTop + stochHeight - (value / 100) * stochHeight;
      };

      // Draw Stochastic grid lines
      ctx.strokeStyle = colors.grid;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      const overbought = indicators?.stochastic?.overbought ?? 80;
      const oversold = indicators?.stochastic?.oversold ?? 20;
      [oversold, 50, overbought].forEach(level => {
        const y = stochToY(level);
        ctx.moveTo(0, y);
        ctx.lineTo(chartWidth, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw %K line with configurable color
      const kColor = indicators?.stochastic?.kColor || '#3498DB';
      ctx.strokeStyle = kColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      visible.candles.forEach((candle, i) => {
        const globalIdx = visible.startIndex + i;
        const value = indicatorData.stochastic!.k[globalIdx];

        if (!isNaN(value) && isFinite(value)) {
          const x = indexToX(globalIdx, visible.startIndex);
          const y = stochToY(value);

          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      });
      ctx.stroke();

      // Draw %D line with configurable color
      const dColor = indicators?.stochastic?.dColor || '#E67E22';
      ctx.strokeStyle = dColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      started = false;
      visible.candles.forEach((candle, i) => {
        const globalIdx = visible.startIndex + i;
        const value = indicatorData.stochastic!.d[globalIdx];

        if (!isNaN(value) && isFinite(value)) {
          const x = indexToX(globalIdx, visible.startIndex);
          const y = stochToY(value);

          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      });
      ctx.stroke();

      // Draw Stochastic axis labels
      ctx.fillStyle = '#6b7280';
      ctx.font = SUBPLOT_LABEL_FONT;
      ctx.textAlign = 'left';
      [0, oversold, 50, overbought, 100].forEach(level => {
        const y = stochToY(level);
        ctx.fillText(level.toString(), chartWidth + 5, y);
      });

      // Store Stochastic bounds for click detection
      indicatorBoundsRef.current.stochastic = { top: stochTop, bottom: stochBottom };

      // Draw Stochastic label with current values (or hovered values)
      const defaultStochLabel = `STOCH(${indicators?.stochastic?.kPeriod || 14},${indicators?.stochastic?.dPeriod || 3})`;
      const stochLabel = indicators?.stochastic?.style?.customLabel || defaultStochLabel;

      const stochLabelColor = indicators?.stochastic?.style?.labelColor || colors.textDim;
      ctx.fillStyle = stochLabelColor;
      ctx.font = `bold ${SUBPLOT_LABEL_FONT}`;
      ctx.textAlign = 'left';
      const stochIdx = hoveredCandleIndexRef.current !== null
        ? hoveredCandleIndexRef.current
        : visible.startIndex + visible.candles.length - 1;
      const currentK = indicatorData.stochastic.k[stochIdx];
      const currentD = indicatorData.stochastic.d[stochIdx];
      ctx.fillText(stochLabel, 5, stochTop + 12);
      // %K value
      ctx.fillStyle = kColor;
      ctx.font = SUBPLOT_LABEL_FONT;
      const stochLabelWidth = ctx.measureText(stochLabel).width;
      const kValText = !isNaN(currentK) && isFinite(currentK) ? `%K ${currentK.toFixed(2)}` : '%K --';
      ctx.fillText(kValText, 10 + stochLabelWidth, stochTop + 12);
      // %D value
      ctx.fillStyle = dColor;
      const kTextWidth = ctx.measureText(kValText).width;
      const dValText = !isNaN(currentD) && isFinite(currentD) ? `%D ${currentD.toFixed(2)}` : '%D --';
      ctx.fillText(dValText, 16 + stochLabelWidth + kTextWidth, stochTop + 12);
      subplotLabelEndXRef.current.stochastic = 16 + stochLabelWidth + kTextWidth + ctx.measureText(dValText).width + 8;

      currentSubplotY = stochBottom;
    }

    // Volume is drawn as an overlay on the main chart (TradingView style)
    // It does NOT get its own subplot panel; see the overlay drawing code above

    // Draw Williams %R subplot if enabled
    if (!skipIndicators && indicatorData?.williamsR) {
      const wrHeight = subplotHeight;
      const wrTop = currentSubplotY;
      const wrBottom = wrTop + wrHeight;
      const wrStyle = indicators?.williamsR?.style || {};

      // Draw background with configurable color
      if (wrStyle.backgroundColor) {
        ctx.fillStyle = wrStyle.backgroundColor;
        ctx.globalAlpha = wrStyle.backgroundOpacity ?? 0.3;
        ctx.fillRect(0, wrTop, chartWidth, wrHeight);
        ctx.globalAlpha = 1;
      }

      // Draw separator line
      ctx.strokeStyle = colors.textDim;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, wrTop);
      ctx.lineTo(chartWidth, wrTop);
      ctx.stroke();

      // Helper for Williams %R Y coordinate (range -100 to 0)
      const wrToY = (value: number) => {
        return wrTop + wrHeight - ((value + 100) / 100) * wrHeight;
      };

      const wrOverbought = indicators?.williamsR?.overbought ?? -20;
      const wrOversold = indicators?.williamsR?.oversold ?? -80;

      // Draw grid lines
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = wrStyle.gridColor || 'rgba(180, 130, 80, 0.6)';
      [wrOversold, -50, wrOverbought].forEach(level => {
        ctx.beginPath();
        const y = wrToY(level);
        ctx.moveTo(0, y);
        ctx.lineTo(chartWidth, y);
        ctx.stroke();
      });
      ctx.setLineDash([]);

      // Draw Williams %R line
      const wrColor = indicators?.williamsR?.color || '#E91E63';
      ctx.strokeStyle = wrColor;
      ctx.lineWidth = wrStyle.lineWidth ?? 1.5;
      ctx.beginPath();
      let started = false;
      visible.candles.forEach((candle, i) => {
        const globalIdx = visible.startIndex + i;
        const value = indicatorData.williamsR![globalIdx];
        if (!isNaN(value) && isFinite(value)) {
          const x = indexToX(globalIdx, visible.startIndex);
          const y = wrToY(value);
          if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
        }
      });
      ctx.stroke();

      // Draw axis labels
      ctx.fillStyle = '#6b7280';
      ctx.font = SUBPLOT_LABEL_FONT;
      ctx.textAlign = 'left';
      [-100, wrOversold, -50, wrOverbought, 0].forEach(level => {
        const y = wrToY(level);
        ctx.fillText(level.toString(), chartWidth + 5, y);
      });

      // Store Williams %R bounds for click detection
      indicatorBoundsRef.current.williamsR = { top: wrTop, bottom: wrBottom };

      // Draw label with current value
      const defaultWrLabel = `Williams %R ${indicators?.williamsR?.period || 14}`;
      const wrLabel = indicators?.williamsR?.style?.customLabel || defaultWrLabel;

      const wrLabelColor = indicators?.williamsR?.style?.labelColor || '#d1d5db';
      ctx.fillStyle = wrLabelColor;
      ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'left';
      const wrIdx = hoveredCandleIndexRef.current !== null ? hoveredCandleIndexRef.current : visible.startIndex + visible.candles.length - 1;
      const currentWR = indicatorData.williamsR[wrIdx];
      const wrValueText = !isNaN(currentWR) && isFinite(currentWR) ? currentWR.toFixed(2) : '--';
      ctx.fillText(wrLabel, 5, wrTop + 15);
      ctx.fillStyle = wrColor;
      const wrLabelWidth = ctx.measureText(wrLabel).width;
      ctx.fillText(wrValueText, 13 + wrLabelWidth, wrTop + 15);
      subplotLabelEndXRef.current.williamsR = 13 + wrLabelWidth + ctx.measureText(wrValueText).width + 8;

      currentSubplotY = wrBottom;
    }

    // Draw CCI subplot if enabled
    if (!skipIndicators && indicatorData?.cci) {
      const cciHeight = subplotHeight;
      const cciTop = currentSubplotY;
      const cciBottom = cciTop + cciHeight;
      const cciStyle = indicators?.cci?.style || {};

      // Draw background with configurable color
      if (cciStyle.backgroundColor) {
        ctx.fillStyle = cciStyle.backgroundColor;
        ctx.globalAlpha = cciStyle.backgroundOpacity ?? 0.3;
        ctx.fillRect(0, cciTop, chartWidth, cciHeight);
        ctx.globalAlpha = 1;
      }

      // Draw separator line
      ctx.strokeStyle = colors.textDim;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, cciTop);
      ctx.lineTo(chartWidth, cciTop);
      ctx.stroke();

      // Find CCI range for visible candles
      const visibleCCI = visible.candles.map((_, i) => indicatorData.cci![visible.startIndex + i]).filter(v => !isNaN(v) && isFinite(v));
      const cciMax = visibleCCI.length > 0 ? Math.max(200, Math.max(...visibleCCI.map(Math.abs))) : 200;

      // Helper for CCI Y coordinate
      const cciToY = (value: number) => {
        return cciTop + cciHeight / 2 - (value / cciMax) * (cciHeight / 2);
      };

      const cciOverbought = indicators?.cci?.overbought ?? 100;
      const cciOversold = indicators?.cci?.oversold ?? -100;

      // Draw grid lines
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = cciStyle.gridColor || 'rgba(180, 130, 80, 0.6)';
      [cciOversold, 0, cciOverbought].forEach(level => {
        ctx.beginPath();
        const y = cciToY(level);
        ctx.moveTo(0, y);
        ctx.lineTo(chartWidth, y);
        ctx.stroke();
      });
      ctx.setLineDash([]);

      // Draw CCI line
      const cciColor = indicators?.cci?.color || '#00BCD4';
      ctx.strokeStyle = cciColor;
      ctx.lineWidth = cciStyle.lineWidth ?? 1.5;
      ctx.beginPath();
      let started = false;
      visible.candles.forEach((candle, i) => {
        const globalIdx = visible.startIndex + i;
        const value = indicatorData.cci![globalIdx];
        if (!isNaN(value) && isFinite(value)) {
          const x = indexToX(globalIdx, visible.startIndex);
          const y = cciToY(value);
          if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
        }
      });
      ctx.stroke();

      // Draw axis labels
      ctx.fillStyle = '#6b7280';
      ctx.font = SUBPLOT_LABEL_FONT;
      ctx.textAlign = 'left';
      [Math.round(-cciMax), cciOversold, 0, cciOverbought, Math.round(cciMax)].forEach(level => {
        const y = cciToY(level);
        ctx.fillText(level.toString(), chartWidth + 5, y);
      });

      // Store CCI bounds for click detection
      indicatorBoundsRef.current.cci = { top: cciTop, bottom: cciBottom };

      // Draw label
      const defaultCciLabel = `CCI ${indicators?.cci?.period || 20}`;
      const cciLabelStr = indicators?.cci?.style?.customLabel || defaultCciLabel;

      const cciLabelColor = indicators?.cci?.style?.labelColor || '#d1d5db';
      ctx.fillStyle = cciLabelColor;
      ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'left';
      const cciIdx = hoveredCandleIndexRef.current !== null ? hoveredCandleIndexRef.current : visible.startIndex + visible.candles.length - 1;
      const currentCCI = indicatorData.cci[cciIdx];
      const cciValueText = !isNaN(currentCCI) && isFinite(currentCCI) ? currentCCI.toFixed(2) : '--';
      ctx.fillText(cciLabelStr, 5, cciTop + 15);
      ctx.fillStyle = cciColor;
      const cciLabelWidth = ctx.measureText(cciLabelStr).width;
      ctx.fillText(cciValueText, 13 + cciLabelWidth, cciTop + 15);
      subplotLabelEndXRef.current.cci = 13 + cciLabelWidth + ctx.measureText(cciValueText).width + 8;

      currentSubplotY = cciBottom;
    }

    // Draw ADX subplot if enabled
    if (!skipIndicators && indicatorData?.adx) {
      const adxHeight = subplotHeight;
      const adxTop = currentSubplotY;
      const adxBottom = adxTop + adxHeight;

      // Draw separator line
      ctx.strokeStyle = colors.textDim;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, adxTop);
      ctx.lineTo(chartWidth, adxTop);
      ctx.stroke();

      // Helper for ADX Y coordinate (0-100 range)
      const adxToY = (value: number) => {
        return adxTop + adxHeight - (value / 100) * adxHeight;
      };

      // Draw grid lines (25, 50, 75)
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(150, 150, 150, 0.3)';
      [25, 50, 75].forEach(level => {
        ctx.beginPath();
        ctx.moveTo(0, adxToY(level));
        ctx.lineTo(chartWidth, adxToY(level));
        ctx.stroke();
      });
      ctx.setLineDash([]);

      const adxColor = indicators?.adx?.adxColor || '#FFEB3B';
      const plusDIColor = indicators?.adx?.plusDIColor || '#22c55e';
      const minusDIColor = indicators?.adx?.minusDIColor || '#ef4444';

      // Draw +DI
      ctx.strokeStyle = plusDIColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      let started = false;
      visible.candles.forEach((candle, i) => {
        const globalIdx = visible.startIndex + i;
        const value = indicatorData.adx!.plusDI[globalIdx];
        if (!isNaN(value) && isFinite(value)) {
          const x = indexToX(globalIdx, visible.startIndex);
          const y = adxToY(value);
          if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
        }
      });
      ctx.stroke();

      // Draw -DI
      ctx.strokeStyle = minusDIColor;
      ctx.beginPath();
      started = false;
      visible.candles.forEach((candle, i) => {
        const globalIdx = visible.startIndex + i;
        const value = indicatorData.adx!.minusDI[globalIdx];
        if (!isNaN(value) && isFinite(value)) {
          const x = indexToX(globalIdx, visible.startIndex);
          const y = adxToY(value);
          if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
        }
      });
      ctx.stroke();

      // Draw ADX line (thicker)
      ctx.strokeStyle = adxColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      started = false;
      visible.candles.forEach((candle, i) => {
        const globalIdx = visible.startIndex + i;
        const value = indicatorData.adx!.adx[globalIdx];
        if (!isNaN(value) && isFinite(value)) {
          const x = indexToX(globalIdx, visible.startIndex);
          const y = adxToY(value);
          if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
        }
      });
      ctx.stroke();

      // Draw axis labels
      ctx.fillStyle = '#6b7280';
      ctx.font = SUBPLOT_LABEL_FONT;
      [0, 25, 50, 75, 100].forEach(level => {
        ctx.fillText(level.toString(), chartWidth + 5, adxToY(level));
      });

      // Draw label
      const adxIdx = hoveredCandleIndexRef.current !== null ? hoveredCandleIndexRef.current : visible.startIndex + visible.candles.length - 1;
      const currentADX = indicatorData.adx.adx[adxIdx];
      ctx.fillStyle = '#d1d5db';
      ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(`ADX ${indicators?.adx?.period || 14}`, 5, adxTop + 15);
      ctx.fillStyle = adxColor;
      ctx.fillText(!isNaN(currentADX) && isFinite(currentADX) ? currentADX.toFixed(2) : '--', 73, adxTop + 15);
      ctx.fillStyle = plusDIColor;
      ctx.fillText('+DI', 118, adxTop + 15);
      ctx.fillStyle = minusDIColor;
      ctx.fillText('-DI', 148, adxTop + 15);
      subplotLabelEndXRef.current.adx = 148 + ctx.measureText('-DI').width + 8;

      // Store ADX bounds for click detection
      indicatorBoundsRef.current.adx = { top: adxTop, bottom: adxBottom };

      currentSubplotY = adxBottom;
    }

    // Draw ROC subplot if enabled
    if (!skipIndicators && indicatorData?.roc) {
      const rocHeight = subplotHeight;
      const rocTop = currentSubplotY;
      const rocBottom = rocTop + rocHeight;

      // Draw separator line
      ctx.strokeStyle = colors.textDim;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, rocTop);
      ctx.lineTo(chartWidth, rocTop);
      ctx.stroke();

      // Find ROC range for visible candles
      const visibleROC = visible.candles.map((_, i) => indicatorData.roc![visible.startIndex + i]).filter(v => !isNaN(v) && isFinite(v));
      const rocMax = visibleROC.length > 0 ? Math.max(5, Math.max(...visibleROC.map(Math.abs))) : 5;

      // Helper for ROC Y coordinate
      const rocToY = (value: number) => {
        return rocTop + rocHeight / 2 - (value / rocMax) * (rocHeight / 2);
      };

      // Draw zero line
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(150, 150, 150, 0.5)';
      ctx.beginPath();
      ctx.moveTo(0, rocToY(0));
      ctx.lineTo(chartWidth, rocToY(0));
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw ROC line
      const rocColor = indicators?.roc?.color || '#9C27B0';
      ctx.strokeStyle = rocColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      visible.candles.forEach((candle, i) => {
        const globalIdx = visible.startIndex + i;
        const value = indicatorData.roc![globalIdx];
        if (!isNaN(value) && isFinite(value)) {
          const x = indexToX(globalIdx, visible.startIndex);
          const y = rocToY(value);
          if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
        }
      });
      ctx.stroke();

      // Draw axis labels
      ctx.fillStyle = '#6b7280';
      ctx.font = SUBPLOT_LABEL_FONT;
      [-rocMax, 0, rocMax].forEach(level => {
        ctx.fillText(level.toFixed(1) + '%', chartWidth + 5, rocToY(level));
      });

      // Draw label
      ctx.fillStyle = '#d1d5db';
      ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, sans-serif';
      const rocIdx = hoveredCandleIndexRef.current !== null ? hoveredCandleIndexRef.current : visible.startIndex + visible.candles.length - 1;
      const currentROC = indicatorData.roc[rocIdx];
      const rocValueText = !isNaN(currentROC) && isFinite(currentROC) ? currentROC.toFixed(2) + '%' : '--';
      ctx.fillText(`ROC ${indicators?.roc?.period || 12}`, 5, rocTop + 15);
      ctx.fillStyle = rocColor;
      const rocLabelWidth = ctx.measureText(`ROC ${indicators?.roc?.period || 12}`).width;
      ctx.fillText(rocValueText, 13 + rocLabelWidth, rocTop + 15);
      subplotLabelEndXRef.current.roc = 13 + rocLabelWidth + ctx.measureText(rocValueText).width + 8;

      // Store ROC bounds for click detection
      indicatorBoundsRef.current.roc = { top: rocTop, bottom: rocBottom };

      currentSubplotY = rocBottom;
    }

    // ── Generic subplots, Phase 2 overlays, custom indicators, subplot dots ──
    // Extracted to renderers/subplotRenderer.ts for maintainability.
    // The SubplotRenderContext bundles all values the renderer needs so it
    // can remain a pure function with no React state or ref access.
    const subplotCtx: SubplotRenderContext = {
      ctx, chartWidth, subplotHeight, visible, indexToX, currentCandleWidth,
      subplotLabelFont: SUBPLOT_LABEL_FONT,
      hoveredCandleIndex: hoveredCandleIndexRef.current,
      colors: { textDim: colors.textDim, grid: colors.grid },
      indicators, indicatorData,
      indicatorBounds: indicatorBoundsRef.current as any,
      subplotLabelEndX: subplotLabelEndXRef.current,
      mainPriceToY, mainChartHeight, skipIndicators,
      clickedIndicatorKey,
    };

    // Phase 2 overlay lines (ALMA, KAMA, Alligator, Fractals, etc.)
    // drawn on the main chart area, not in subplot panels
    renderPhase2Overlays(subplotCtx);

    // Generic subplot indicators (Aroon through Gator, custom formulas)
    currentSubplotY = renderGenericSubplots(subplotCtx, currentSubplotY);

    // Selection dots on clicked subplot indicator lines
    renderSubplotSelectionDots(subplotCtx);

    // ── ECONOMIC EVENT MARKERS ─────────────────────────────────────────────
    // TradingView-style: country flag icons sitting on the time axis bar
    // Cards appear on hover via the overlay canvas
    if (economicEvents && economicEvents.length > 0 && visible.candles.length > 0) {

      // Country code for text fallback when flag image hasn't loaded yet
      const getRegionCode = (code: string | null): string => {
        if (!code) return '??';
        return code.toUpperCase().trim().slice(0, 2);
      };

      // Get event timestamp in milliseconds (UTC)
      const getEventTimestamp = (event: any): number | null => {
        if (event.datetime) {
          const ts = new Date(event.datetime).getTime();
          if (!isNaN(ts)) return ts;
        }
        if (!event.date) return null;
        try {
          const [year, month, day] = event.date.split('-').map(Number);
          if (!event.time) return Date.UTC(year, month - 1, day, 12, 0);
          const timeMatch = event.time.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
          if (!timeMatch) return Date.UTC(year, month - 1, day, 12, 0);
          let hours = parseInt(timeMatch[1]);
          const minutes = parseInt(timeMatch[2]);
          const ampm = timeMatch[3]?.toUpperCase();
          if (ampm === 'PM' && hours !== 12) hours += 12;
          else if (ampm === 'AM' && hours === 12) hours = 0;
          return Date.UTC(year, month - 1, day, hours, minutes);
        } catch {
          return null;
        }
      };

      const markers: Array<{ x: number; y: number; event: any; impact: string; ts: number; groupEvents?: Array<{ event: any; impact: string; ts: number }> }> = [];

      ctx.save();

      const impactPriority: Record<string, number> = { high: 0, medium: 1, low: 2 };
      const eventPositions: Array<{ x: number; event: any; impact: string; ts: number; closestIdx: number }> = [];

      const nowMs = Date.now();

      for (const event of economicEvents) {
        const eventTs = getEventTimestamp(event);
        if (!eventTs) continue;

        // Only show FUTURE events (skip past events)
        if (eventTs < nowMs) continue;

        const candleInterval = candles.length > 1 ? Math.abs(candles[1].time - candles[0].time) : 60000;

        // Check if event is in the future (beyond last candle)
        const lastCandle = candles[candles.length - 1];
        const isFutureEvent = lastCandle && eventTs > lastCandle.time + candleInterval;

        let x: number;
        let closestIdx: number;

        if (isFutureEvent) {
          // Extrapolate x position for future events based on candle spacing
          const timeDiff = eventTs - lastCandle.time;
          const indexOffset = timeDiff / candleInterval;
          const futureIdx = candles.length - 1 + indexOffset;
          closestIdx = Math.round(futureIdx);
          x = indexToX(futureIdx, visible.startIndex);
          // Allow future flags in the right-side empty area (future time labels render there)
          if (x < 0 || x > chartWidth - 10) continue;
        } else {
          // Binary search for closest candle timestamp
          let left = 0;
          let right = candles.length - 1;
          closestIdx = -1;
          
          while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            if (candles[mid].time === eventTs) {
              closestIdx = mid;
              break;
            }
            if (candles[mid].time < eventTs) {
              left = mid + 1;
            } else {
              right = mid - 1;
            }
          }
          
          if (closestIdx === -1) {
             // Find closest between left and right boundary intersections
             const leftValid = left >= 0 && left < candles.length;
             const rightValid = right >= 0 && right < candles.length;
             
             if (leftValid && rightValid) {
               closestIdx = Math.abs(candles[left].time - eventTs) < Math.abs(candles[right].time - eventTs) ? left : right;
             } else if (leftValid) {
               closestIdx = left;
             } else if (rightValid) {
               closestIdx = right;
             } else {
               closestIdx = candles.length - 1;
             }
          }
          
          const closestDiff = Math.abs(candles[closestIdx].time - eventTs);

          if (closestIdx < 0) continue;
          if (closestDiff > candleInterval) continue;
          if (closestIdx < visible.startIndex || closestIdx >= visible.endIndex) continue;

          x = indexToX(closestIdx, visible.startIndex);
          if (x < 0 || x > chartWidth) continue;
        }

        const impact = getEventImpact({ event: event.event || '', country: event.region_code || '' });
        eventPositions.push({ x, event, impact, ts: eventTs, closestIdx });
      }

      eventPositions.sort((a, b) => {
        const pa = impactPriority[a.impact] ?? 3;
        const pb = impactPriority[b.impact] ?? 3;
        if (pa !== pb) return pa - pb;
        return (a.event.event || '').localeCompare(b.event.event || '');
      });

      // Group by x position (same candle = same time slot) -> single marker per group
      const xGroups = new Map<number, typeof eventPositions>();
      for (const ep of eventPositions) {
        const roundedX = Math.round(ep.x);
        if (!xGroups.has(roundedX)) xGroups.set(roundedX, []);
        xGroups.get(roundedX)!.push(ep);
      }

      // Clean pill-shaped badges above the time axis with country code text
      // Uses frosted-glass style instead of heavy colored circles; works
      // consistently across all browsers (emoji flags break on Linux/some OS)
      const isDarkMarker = document.documentElement.classList.contains('dark');
      const timeAxisTop = height - TIME_AXIS_HEIGHT;
      const pillH = 22;
      const pillW = 32;
      const flagCenterY = timeAxisTop - pillH / 2 - 5;

      for (const [_roundedX, group] of xGroups) {
        const centerX = group[0].x;
        const topImpact = group[0].impact;
        const isHigh = topImpact === 'high';
        const isLow = topImpact === 'low';
        const regionCode = getRegionCode(group[0].event.region_code);
        const flagImg = getFlagImage(group[0].event.region_code);
        const count = group.length;

        // Store grouped marker for hover detection
        markers.push({
          x: centerX, y: flagCenterY,
          event: group[0].event, impact: topImpact, ts: group[0].ts,
          groupEvents: group.map(ep => ({ event: ep.event, impact: ep.impact, ts: ep.ts })),
        });

        // Impact accent color (left border strip)
        const accentColor = isHigh ? '#dc2626' : isLow ? '#22c55e' : '#d97706';

        ctx.save();
        // Subtle shadow
        ctx.shadowColor = isDarkMarker ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0.15)';
        ctx.shadowBlur = 8;
        ctx.shadowOffsetY = 2;

        // Frosted glass pill background
        const pillX = centerX - pillW / 2;
        const pillY = flagCenterY - pillH / 2;
        ctx.fillStyle = isDarkMarker ? 'rgba(30, 41, 59, 0.92)' : 'rgba(255, 255, 255, 0.95)';
        ctx.beginPath();
        ctx.roundRect(pillX, pillY, pillW, pillH, 6);
        ctx.fill();

        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;

        // Border
        ctx.strokeStyle = isDarkMarker ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Left accent strip (colored by impact)
        ctx.fillStyle = accentColor;
        ctx.beginPath();
        ctx.roundRect(pillX, pillY, 3, pillH, [6, 0, 0, 6]);
        ctx.fill();

        ctx.restore();

        // Country flag image (or text fallback)
        const flagW = 18;
        const flagH = 13;
        if (flagImg) {
          // Draw actual flag PNG; works on every OS
          ctx.drawImage(flagImg, centerX - flagW / 2, flagCenterY - flagH / 2, flagW, flagH);
        } else {
          // Text fallback while image loads
          ctx.font = 'bold 9px -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = isDarkMarker ? '#e2e8f0' : '#334155';
          ctx.fillText(regionCode, centerX + 1, flagCenterY);
        }

        // Count badge (top-right corner)
        if (count > 1) {
          const badgeX = pillX + pillW - 2;
          const badgeY = pillY - 2;
          const badgeR = 7;
          ctx.beginPath();
          ctx.arc(badgeX, badgeY, badgeR, 0, Math.PI * 2);
          ctx.fillStyle = accentColor;
          ctx.fill();
          ctx.strokeStyle = isDarkMarker ? '#0f172a' : '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.font = 'bold 8px -apple-system, BlinkMacSystemFont, "Inter", sans-serif';
          ctx.fillStyle = '#ffffff';
          ctx.fillText(String(count), badgeX, badgeY + 0.5);
        }

        // Thin vertical tick line connecting pill to time axis
        ctx.beginPath();
        ctx.moveTo(centerX, flagCenterY + pillH / 2);
        ctx.lineTo(centerX, timeAxisTop);
        ctx.strokeStyle = isHigh
          ? 'rgba(220, 38, 38, 0.3)'
          : isLow ? 'rgba(34, 197, 94, 0.25)' : 'rgba(217, 119, 6, 0.3)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.restore();

      // Store marker positions for hover detection
      eventMarkerPositionsRef.current = markers;
    } else {
      eventMarkerPositionsRef.current = [];
    }

    // X-axis separator line: extends full width including through price axis
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height - TIME_AXIS_HEIGHT);
    ctx.lineTo(width, height - TIME_AXIS_HEIGHT);
    ctx.stroke();

    // Version label in the bottom-right corner rectangle (where axes meet).
    // Phone hides it (cfg.versionLabelVisible=false) because the cramped axis
    // intersection drags v.23 into the last price label on a narrow viewport.
    if (cfg.versionLabelVisible) {
      const gearCenterX = chartWidth + (PRICE_AXIS_WIDTH / 2) + cfg.versionLabelXOffset;
      const gearCenterY = height - (TIME_AXIS_HEIGHT / 2) + 1;

      ctx.save();
      ctx.font = 'bold 11px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = colors.text;
      ctx.fillText('v.23', gearCenterX, gearCenterY);
      ctx.restore();
    }

    // Draw time axis at the very bottom
    if (visible.candles.length > 0) {
      const timeAxisCandleSpacing = currentCandleWidth * (1 + CANDLE_GAP_RATIO);
      const labelInterval = Math.max(1, Math.floor(80 / timeAxisCandleSpacing));
      // Top of time axis area
      const axisTopY = height - TIME_AXIS_HEIGHT;
      // Center labels slightly below ticks
      const timeAxisY = axisTopY + 16;

      ctx.font = TIME_LABEL_FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // Clip labels to chart area so they never bleed into the price axis
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, axisTopY, chartWidth, TIME_AXIS_HEIGHT);
      ctx.clip();

      // Skip time labels if no candles
      if (!visible.candles || visible.candles.length === 0) { ctx.restore(); return; }

      const firstCandle = visible.candles[0];
      const visibleLastCandle = visible.candles[visible.candles.length - 1];
      if (!firstCandle || !visibleLastCandle) { ctx.restore(); return; }

      // Check if visible data spans multiple years or is from a different year
      const currentYear = new Date().getFullYear();
      const firstCandleYear = new Date(firstCandle.time).getFullYear();
      const lastCandleYear = new Date(visibleLastCandle.time).getFullYear();
      const spansMultipleYears = firstCandleYear !== lastCandleYear;
      const isHistoricalYear = firstCandleYear !== currentYear || lastCandleYear !== currentYear;

      // Determine timeframe from candle spacing (approximate)
      const secondCandle = visible.candles[1];
      const timeIncrement = secondCandle
        ? secondCandle.time - firstCandle.time
        : 60000; // Default 1 minute
      const timeframeMinutes = timeIncrement / 60000;

      // For higher timeframes (1H+), show date instead of time
      // For lower timeframes, show time but add date when day changes
      const isHigherTimeframe = timeframeMinutes >= 60;

      let lastShownDate = '';
      let lastShownYear = -1;
      // Track the right edge of the last rendered label to prevent overlaps
      let lastLabelRightEdge = -Infinity;
      const MIN_LABEL_GAP = 12; // Minimum pixels between adjacent labels

      // Helper: format a candle's time label based on timeframe and date context
      const getTimeLabel = (candleTime: number, candleYear: number): string => {
        if (isHigherTimeframe) {
          const showYear = isHistoricalYear || spansMultipleYears || candleYear !== lastShownYear;
          const dateStr = formatDate(candleTime, showYear);
          if (dateStr !== lastShownDate) {
            lastShownDate = dateStr;
            lastShownYear = candleYear;
            return dateStr;
          }
          return formatTime(candleTime);
        }
        const dateStr = formatDate(candleTime, false);
        if (candleYear !== lastShownYear && lastShownYear !== -1) {
          lastShownYear = candleYear;
          return formatDate(candleTime, true);
        }
        if (dateStr !== lastShownDate) {
          lastShownDate = dateStr;
          lastShownYear = candleYear;
          return formatDate(candleTime, isHistoricalYear);
        }
        return formatTime(candleTime);
      };

      // Phone places exactly N labels at evenly-spaced pixel positions across
      // the chart width, then snaps each to the nearest candle. The 400px
      // sub-breakpoint is a within-phone refinement (small phone => 4 labels)
      // and stays an explicit width check rather than a deviceConfig field.
      const isSmallPhone = dimensions.width < 400;

      if (cfg.useFixedTimeAxisLabels) {
        // Use nearly the full chart width for timestamps. Only a tiny 5px inset
        // on each side to avoid clipping at the very edge. The clipping rect
        // already prevents labels from bleeding into the price axis.
        const targetCount = isSmallPhone ? cfg.fixedTimeAxisLabelCountSmall : cfg.fixedTimeAxisLabelCount;
        const pad = 5;
        const usableWidth = chartWidth - pad * 2;

        for (let n = 0; n < targetCount; n++) {
          // Evenly space label positions across the usable chart width
          const targetX = pad + (usableWidth * (n + 0.5)) / targetCount;
          // Find the candle index closest to this pixel position
          const rawIdx = xToIndex(targetX, visible.startIndex);
          const localIdx = Math.round(rawIdx) - visible.startIndex;
          if (localIdx < 0 || localIdx >= visible.candles.length) continue;

          const candle = visible.candles[localIdx];
          if (!candle) continue;

          const x = indexToX(visible.startIndex + localIdx, visible.startIndex);
          const candleYear = new Date(candle.time).getFullYear();
          const labelText = getTimeLabel(candle.time, candleYear);

          ctx.fillStyle = colors.axisLabel;
          ctx.fillText(labelText, x, timeAxisY);
        }
      } else {
        // Desktop: anchor labels to absolute candle indices (multiples of
        // labelInterval from index 0) so they slide with the candles during
        // scroll. Relative indexing (i=0 from first visible candle) causes
        // anchor point calculation by prependShift so physical labels do not glitch.
        const effStart = visible.startIndex - (prependShift || 0);
        const absStart = Math.ceil(effStart / labelInterval) * labelInterval + (prependShift || 0);
        const absEnd = visible.startIndex + visible.candles.length;
        for (let absIdx = absStart; absIdx < absEnd; absIdx += labelInterval) {
          const localIdx = absIdx - visible.startIndex;
          const candle = visible.candles[localIdx];
          if (!candle) continue;

          const x = indexToX(absIdx, visible.startIndex);
          const candleYear = new Date(candle.time).getFullYear();
          const labelText = getTimeLabel(candle.time, candleYear);

          const labelW = ctx.measureText(labelText).width;
          const leftEdge = x - labelW / 2;
          const rightEdge = x + labelW / 2;
          if (leftEdge < lastLabelRightEdge + MIN_LABEL_GAP) continue;
          if (rightEdge > chartWidth - 10) continue;
          if (leftEdge < 2) continue;

          ctx.fillStyle = colors.axisLabel;
          ctx.fillText(labelText, x, timeAxisY);
          lastLabelRightEdge = rightEdge;
        }

        // Draw future time labels (continuing the pattern beyond visible candles)
        const lastCandle = visible.candles[visible.candles.length - 1];
        if (!lastCandle) { ctx.restore(); return; }

        const futureLabelsCount = 20; // Enough to cover the full future space for economic events
        const lastVisibleIndex = visible.endIndex - 1;

        for (let i = 1; i <= futureLabelsCount; i++) {
          const futureIndex = lastVisibleIndex + (i * labelInterval);
          const x = indexToX(futureIndex, visible.startIndex);
          if (x > chartWidth) break;

          const futureTime = lastCandle.time + (i * labelInterval * timeIncrement);
          // Match the past-label formatter: getTimeLabel renders a date on
          // daily/weekly timeframes, where formatTime would print "00:00" for
          // every midnight-aligned future slot and fill the empty replay space
          // with a row of identical 00:00 labels.
          const timeStr = getTimeLabel(futureTime, new Date(futureTime).getFullYear());

          const labelW = ctx.measureText(timeStr).width;
          const leftEdge = x - labelW / 2;
          const rightEdge = x + labelW / 2;
          if (leftEdge < lastLabelRightEdge + MIN_LABEL_GAP) continue;
          if (rightEdge > chartWidth - 10) continue;

          ctx.fillStyle = colors.axisLabel;
          ctx.fillText(timeStr, x, timeAxisY);
          lastLabelRightEdge = rightEdge;
        }
      }

      ctx.restore(); // Restore canvas state (removes clip)

      // ----------------------------------------------------
      // Final Z-Index Priority: Active Drawing Solid Badges
      // Must be rendered AFTER standard text labels so they stay on top
      // AND AFTER the time-axis clip is restored!
      // ----------------------------------------------------
      if (activeXHighlights.length > 0 || activeYHighlights.length > 0) {
        ctx.save();
        activeXHighlights.forEach(h => {
          ctx.fillStyle = activeBadgeColor;
          ctx.beginPath();
          ctx.roundRect(h.topOrigin, activeBYTopTime, h.bWidth, activeBRowHeight, 2);
          ctx.fill();

          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.font = activeBadgeFont;
          ctx.fillText(h.text, h.topOrigin + h.bWidth / 2, activeBYTopTime + activeBRowHeight / 2);
        });

        activeYHighlights.forEach(h => {
          ctx.fillStyle = activeBadgeColor;
          ctx.beginPath();
          ctx.roundRect(activeBX, h.topOrigin, h.bWidth, activeBRowHeight, 2);
          ctx.fill();

          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.font = activeBadgeFont;
          ctx.fillText(h.text, activeBX + h.bWidth / 2, h.topOrigin + activeBRowHeight / 2);
        });
        ctx.restore();
      }
    }

    // DOUBLE-BUFFER BLIT: Copy the fully-drawn offscreen canvas to the visible
    // canvas in one atomic operation. The visible canvas is never in a half-drawn
    // state because we only touch it here, after all drawing is complete.
    const visibleCtx = canvas.getContext('2d');
    if (visibleCtx) {
      // Reset transform so drawImage uses raw pixel coordinates (matching
      // the offscreen canvas buffer dimensions, not the CSS-scaled size)
      visibleCtx.setTransform(1, 0, 0, 1, 0, 0);
      visibleCtx.drawImage(offCanvas, 0, 0);
    }

    // Drawing preview shading and badges have been moved to DOM overlays
    // in ChartDrawingOverlay to avoid canvas redraw latency.
  }, [dimensions, candles, livePrice, viewState, colors, indicatorData, indicatorHeightRatio, getVisibleCandles, getPriceRange, formatPrice, formatTime, formatDate, pulsePhase, dpr, countdown, indicators, chartType, priceToY, economicEvents, l2DepthData, clickedIndicatorKey, drawings, selectedDrawingId]);

  // Store drawChart in a ref for stable access during scroll.
  // Updated synchronously during render to ensure wheel RAFs firing right
  // after a prepend (before effects run) use the latest candles/closure.
  drawChartRef.current = drawChart;

  // Expose a lightweight redraw trigger to external components (ChartDrawingOverlay).
  // Called on every pointer move during drawing preview so the canvas renders blue
  // cursor badges in real time. Uses fast mode (true) to skip expensive indicator
  // recalculation, matching the scroll handler's approach for 60fps performance.
  useEffect(() => {
    if (requestRedrawRef) {
      requestRedrawRef.current = () => {
        if (drawChartRef.current) drawChartRef.current(true);
      };
    }
  }, [requestRedrawRef]);

  // Store drawCrosshair ref so mouseLeave can re-call it to show OHLC
  // with the latest candle after clearing the crosshair overlay
  // drawCrosshair: delegates to the extracted pure function in renderers/crosshairRenderer.ts.
  // The original ~1,200-line inline useCallback was extracted to reduce ProChart.tsx size.
  // All ref values are read once here and passed as plain values to the renderer.
  const drawCrosshair = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    // Build the context object with all current ref/state values.
    // Refs are dereferenced here so the renderer receives plain values,
    // keeping it free of React dependencies.
    const crosshairCtx: CrosshairContext = {
      ctx,
      dimensions,
      dpr,
      candles,
      colors,
      viewState,
      indicatorData,
      indicators,
      indicatorHeightRatio,
      showOHLC,
      isDesktop,
      PRICE_AXIS_WIDTH,
      TIME_AXIS_HEIGHT,
      PRICE_LABEL_FONT,
      TIME_LABEL_FONT,
      crosshair: crosshairRef.current,
      isScrolling: isScrollingRef.current,
      scrollState: {
        startIndex: scrollStateRef.current.startIndex,
        candleWidth: scrollStateRef.current.candleWidth,
      },
      isDraggingHandle: !!draggingHandleRef.current,
      isHoveredSLTP: !!hoveredSLTPRef.current,
      sessionControlHovered: sessionControlHoveredRef.current,
      isSyncedUpdate: isSyncedUpdateRef.current,
      syncedCrosshairTime: syncedCrosshairTimeRef.current ?? undefined,
      hoveredEvent: pinnedEventRef.current || hoveredEventRef.current,
      currentOhlcTextWidth: ohlcTextWidth,
      currentBbTextEndX: bbTextEndX,
      currentMaTextEndX: maTextEndX,
      currentVwapTextEndX: vwapTextEndX,
      currentVpTextEndX: vpTextEndX,
      currentVolTextEndX: volTextEndX,
      overlayLabelEndXPrev: overlayLabelEndXRef.current,
      subplotLabelEndXPrev: subplotLabelEndX,
      getVisibleCandles,
      getPriceRange,
      yToPrice,
      xToIndex,
      indexToX,
      formatPrice,
      formatTime,
      formatDate,
      callbacks: {
        setOhlcTextWidth,
        setBbTextEndX,
        setMaTextEndX,
        setVwapTextEndX,
        setVpTextEndX,
        setVolTextEndX,
        setOverlayLabelEndX,
        setSubplotLabelEndX,
        onCrosshairMove,
      },
    };

    renderCrosshair(crosshairCtx);
  }, [dimensions, candles, viewState, colors, indicatorData, indicators, indicatorHeightRatio, getVisibleCandles, getPriceRange, yToPrice, xToIndex, indexToX, formatPrice, formatTime, formatDate, onCrosshairMove, dpr, showOHLC, syncedCrosshairTime]);

  useEffect(() => {
    drawCrosshairRef.current = drawCrosshair;
  }, [drawCrosshair]);


  // ─── Navigation + Y-axis handlers extracted to useChartNavigation ────
  // These 9 handlers (zoom in/out, reset view/Y-axis, move left/right,
  // Y-axis mouse down/touch start/wheel) have manageable dependency
  // counts (~20 params) and are extracted to reduce this file's size.
  // The complex mouse/touch/wheel handlers remain inline because they
  // access 40+ refs, indicator data, position lines, and crosshair state.
  const {
    handleZoomIn,
    handleZoomOut,
    handleResetView,
    handleResetYAxis,
    handleMoveLeft,
    handleMoveRight,
    handleYAxisMouseDown,
    handleYAxisTouchStart,
    handleYAxisWheel,
  } = useChartNavigation({
    minCandleWidth: MIN_CANDLE_WIDTH,
    maxCandleWidth: MAX_CANDLE_WIDTH,
    priceAxisWidth: PRICE_AXIS_WIDTH,
    timeAxisHeight: TIME_AXIS_HEIGHT,
    dimensions,
    candlesLength: candles.length,
    disableAutoFollow,
    livePrice: livePrice ?? null,
    scrollStateRef,
    drawChartRef,
    notifyScrollSync,
    getVisibleCandles,
    getPriceRange,
    setViewState,
    setPriceScale,
    setPriceOffset,
    setFixedPriceCenter,
    setFixedPriceRange,
    setIsScalingYAxis,
    fixedPriceCenter,
    priceScale,
    priceOffset,
    viewStateAutoFollowLatest: viewState.autoFollowLatest,
    yAxisScaleStartRef,
    priceScaleRef,
    priceOffsetRef,
    yAxisDebounceRef,
  });

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // On touch devices, only show crosshair if we're in crosshair mode (long-press activated).
    //
    // This guard must NOT swallow a real mouse DRAG. It sits above the drag
    // branch further down, so on any touch-CAPABLE machine (a touch monitor, a
    // 2-in-1, anything with maxTouchPoints > 0) every mousemove returned here
    // and panning the chart with a mouse did nothing at all, while a finger
    // worked perfectly: mousedown armed the drag, mouseup ended it, and not one
    // move in between was ever processed. The reported symptom: selecting with
    // the mouse and trying to move left/right did nothing, while a finger
    // worked. It needed a touch screen to reproduce, which is why a
    // desktop-shaped test never saw it.
    // Suppressing the hover crosshair is the whole intent; a gesture already in
    // flight is not a hover.
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (isTouchDevice && !isCrosshairMode && !isDragging && !draggingHandleRef.current) {
      return;
    }

    // Always update crosshair position to follow cursor
    crosshairRef.current = { x, y };

    // Check if hovering over the settings gear icon (for glow effect)
    // [Removed] The gear was replaced with a static version label ('v.23')
    // ─── Indicator line hover: show pointer cursor when near indicator lines ───
    if (!isDragging && !draggingHandleRef.current && indicators && indicatorData) {
      const pr = renderedPriceRangeRef.current;
      const mch = mainChartHeightRef.current;
      if (pr && mch > 0 && y < mch) {
        const currentState = scrollStateRef.current;
        const candleSpacing = currentState.candleWidth * (1 + CANDLE_GAP_RATIO);
        const startIdx = Math.max(0, Math.floor(currentState.startIndex));
        const hoverIdx = startIdx + Math.round(x / candleSpacing);
        const HIT = 8;
        
        const nearPrice = (price: number) => {
          if (isNaN(price) || !isFinite(price)) return false;
          return Math.abs(y - (mch - ((price - pr.min) / pr.range) * mch)) < HIT;
        };
        
        let foundLine: string | null = null;
        
        // Check MA lines
        if (!foundLine && indicators.movingAverages?.enabled && indicatorData.movingAverages) {
          for (const ma of indicatorData.movingAverages) {
            if (hoverIdx >= 0 && hoverIdx < ma.data.length && nearPrice(ma.data[hoverIdx])) {
              foundLine = 'movingAverages'; break;
            }
          }
        }
        // Check BB
        if (!foundLine && indicators.bollinger?.enabled && indicatorData.bollinger) {
          const bb = indicatorData.bollinger;
          if (hoverIdx >= 0 && hoverIdx < bb.upper.length &&
            (nearPrice(bb.upper[hoverIdx]) || nearPrice(bb.middle[hoverIdx]) || nearPrice(bb.lower[hoverIdx]))) {
            foundLine = 'bollinger';
          }
        }
        // Check VWAP
        if (!foundLine && indicators.vwap?.enabled && indicatorData.vwap &&
          hoverIdx >= 0 && hoverIdx < indicatorData.vwap.length && nearPrice(indicatorData.vwap[hoverIdx])) {
          foundLine = 'vwap';
        }
        // Check Supertrend
        if (!foundLine && indicators.supertrend?.enabled && indicatorData.supertrend &&
          hoverIdx >= 0 && hoverIdx < (indicatorData.supertrend as any).length && (indicatorData.supertrend as any)[hoverIdx] &&
          nearPrice((indicatorData.supertrend as any)[hoverIdx].value)) {
          foundLine = 'supertrend';
        }
        // Check Ichimoku
        if (!foundLine && indicators.ichimoku?.enabled && indicatorData.ichimoku) {
          const ich = indicatorData.ichimoku;
          if (hoverIdx >= 0 && hoverIdx < ich.tenkan.length &&
            (nearPrice(ich.tenkan[hoverIdx]) || nearPrice(ich.kijun[hoverIdx]) ||
             nearPrice(ich.senkouA[hoverIdx]) || nearPrice(ich.senkouB[hoverIdx]))) {
            foundLine = 'ichimoku';
          }
        }
        // Check Keltner
        if (!foundLine && indicators.keltner?.enabled && indicatorData.keltner) {
          const kc = indicatorData.keltner;
          if (hoverIdx >= 0 && hoverIdx < kc.upper.length &&
            (nearPrice(kc.upper[hoverIdx]) || nearPrice(kc.middle[hoverIdx]) || nearPrice(kc.lower[hoverIdx]))) {
            foundLine = 'keltner';
          }
        }
        // Check Donchian
        if (!foundLine && indicators.donchian?.enabled && indicatorData.donchian) {
          const dc = indicatorData.donchian;
          if (hoverIdx >= 0 && hoverIdx < dc.upper.length &&
            (nearPrice(dc.upper[hoverIdx]) || nearPrice(dc.middle[hoverIdx]) || nearPrice(dc.lower[hoverIdx]))) {
            foundLine = 'donchian';
          }
        }
        // Check Envelopes
        if (!foundLine && indicators.envelopes?.enabled && indicatorData.envelopes) {
          const env = indicatorData.envelopes;
          if (hoverIdx >= 0 && hoverIdx < env.upper.length &&
            (nearPrice(env.upper[hoverIdx]) || nearPrice((env as any).basis[hoverIdx]) || nearPrice(env.lower[hoverIdx]))) {
            foundLine = 'envelopes';
          }
        }
        
        // Smart volume bar hover: only show pointer cursor when the cursor is
        // actually over a specific volume bar (not just anywhere in the bottom 20%).
        // The highlight rectangle (drawn in drawCrosshair) provides additional feedback.
        if (!foundLine && indicators?.volume?.enabled && mch > 0 && y >= mch * 0.8 && y <= mch) {
          // Use same candle index calculation as the main hover code above
          const localI = hoverIdx - startIdx;
          const vis = getVisibleCandles();
          if (localI >= 0 && localI < vis.candles.length) {
            const vol = vis.candles[localI].volume ?? 0;
            if (vol > 0) {
              // Check cursor Y against this bar's actual pixel height.
              // Only show pointer when cursor is within the bar itself, not
              // just anywhere in the 20% overlay region.
              const volOverlayHeight = mch * 0.2;
              const volBottom = mch;
              const visVols = vis.candles.map(c => c.volume ?? 0).filter(v => v > 0);
              const vMax = visVols.length > 0 ? Math.max(...visVols) : 1;
              const barH = (vol / vMax) * volOverlayHeight * 0.95;
              const barTop = volBottom - barH;
              if (y >= barTop) {
                foundLine = 'volume';
              }
            }
          }
        }

        // Smart volume profile hover: show pointer when cursor is actually
        // over one of the side volume profile bars on the right edge.
        // Early-exit: only check if cursor is in the rightmost area where bars live.
        const vpChartWidth = dimensions.width - PRICE_AXIS_WIDTH;
        if (!foundLine && indicators?.volumeProfile?.enabled && mch > 0
            && x >= vpChartWidth * (1 - (indicators.volumeProfile.rowWidth ?? 15) / 100)) {
          const vis = getVisibleCandles();
          if (vis.candles.length > 0) {
            const numRows = indicators.volumeProfile.numberOfRows ?? 48;
            const maxBarW = vpChartWidth * ((indicators.volumeProfile.rowWidth ?? 15) / 100);
            const lookback = indicators.volumeProfile.lookbackBars ?? 0;
            const candlesUsed = lookback > 0 ? vis.candles.slice(-lookback) : vis.candles;
            let pMin = Infinity, pMax = -Infinity;
            candlesUsed.forEach(c => { pMin = Math.min(pMin, c.low); pMax = Math.max(pMax, c.high); });
            const pStep = (pMax - pMin || 1) / numRows;
            const pr = renderedPriceRangeRef.current;
            if (pr && pr.range > 0) {
              const cursorPrice = pr.max - (y / mch) * pr.range;
              const binIdx = Math.floor((cursorPrice - pMin) / pStep);
              if (binIdx >= 0 && binIdx < numRows) {
                // Calculate all bins in one pass to get both the hovered bin volume and max
                const bins = new Float64Array(numRows);
                candlesUsed.forEach(c => {
                  if (!c.volume || c.volume <= 0) return;
                  for (let i = 0; i < numRows; i++) {
                    const bL = pMin + i * pStep;
                    const bH = bL + pStep;
                    if (c.high >= bL && c.low <= bH) {
                      const oL = Math.max(c.low, bL);
                      const oH = Math.min(c.high, bH);
                      const oR = (c.high - c.low) > 0 ? (oH - oL) / (c.high - c.low) : 1;
                      bins[i] += c.volume * oR;
                    }
                  }
                });
                let maxVol = 0;
                for (let i = 0; i < numRows; i++) { if (bins[i] > maxVol) maxVol = bins[i]; }
                const binVol = bins[binIdx];
                if (binVol > 0 && maxVol > 0) {
                  const totalBarW = (binVol / maxVol) * maxBarW;
                  const barStartX = vpChartWidth - totalBarW;
                  if (x >= barStartX) {
                    foundLine = 'volumeProfile';
                  }
                }
              }
            }
          }
        }

        // Also check subplot indicator lines for hover cursor
        if (!foundLine) {
          const spBounds = indicatorBoundsRef.current;
          const spChecks: { key: string; check: () => boolean }[] = [];
          
          // RSI (0-100)
          if (indicators.rsi?.enabled && indicatorData.rsi) {
            const pb = (spBounds as any).rsi;
            spChecks.push({ key: 'sp-rsi', check: () => {
              if (!pb || y < pb.top || y > pb.bottom) return false;
              if (hoverIdx < 0 || hoverIdx >= indicatorData.rsi!.length) return false;
              const v = indicatorData.rsi![hoverIdx];
              if (isNaN(v) || !isFinite(v)) return false;
              const h = pb.bottom - pb.top;
              return Math.abs(y - (pb.top + h - (v / 100) * h)) < HIT;
            }});
          }
          // MACD
          if (indicators.macd?.enabled && indicatorData.macd) {
            const pb = (spBounds as any).macd;
            spChecks.push({ key: 'sp-macd', check: () => {
              if (!pb || y < pb.top || y > pb.bottom) return false;
              return true; // Any position in MACD panel
            }});
          }
          // Stochastic (0-100)
          if (indicators.stochastic?.enabled && indicatorData.stochastic) {
            const pb = (spBounds as any).stochastic;
            spChecks.push({ key: 'sp-stochastic', check: () => {
              if (!pb || y < pb.top || y > pb.bottom) return false;
              if (hoverIdx < 0 || hoverIdx >= indicatorData.stochastic!.k.length) return false;
              const h = pb.bottom - pb.top;
              const kY = pb.top + h - (indicatorData.stochastic!.k[hoverIdx] / 100) * h;
              const dY = pb.top + h - (indicatorData.stochastic!.d[hoverIdx] / 100) * h;
              return Math.abs(y - kY) < HIT || Math.abs(y - dY) < HIT;
            }});
          }
          // ATR
          if (indicators.atr?.enabled && indicatorData.atr) {
            const pb = (spBounds as any).atr;
            spChecks.push({ key: 'sp-atr', check: () => {
              if (!pb || y < pb.top || y > pb.bottom) return false;
              return true;
            }});
          }
          
          for (const sc of spChecks) {
            if (sc.check()) { foundLine = sc.key; break; }
          }
        }
        
        const prevHovered = hoveredIndicatorLineRef.current;
        hoveredIndicatorLineRef.current = foundLine;
        if (foundLine !== prevHovered) {
          if (overlayCanvasRef.current) {
            overlayCanvasRef.current.style.cursor = foundLine ? 'pointer' : 'crosshair';
          }
        }
      } else if (hoveredIndicatorLineRef.current) {
        hoveredIndicatorLineRef.current = null;
        if (overlayCanvasRef.current && !isHoveringGearRef.current) {
          overlayCanvasRef.current.style.cursor = 'crosshair';
        }
      }
    }

    // Check for economic event marker hover (proximity to any pill)
    let foundHoveredEvent = false;
    for (const marker of eventMarkerPositionsRef.current) {
      const dx = x - marker.x;
      const dy2 = y - marker.y;
      if (Math.sqrt(dx * dx + dy2 * dy2) < 16) {
        hoveredEventRef.current = marker;
        foundHoveredEvent = true;
        if (overlayCanvasRef.current) overlayCanvasRef.current.style.cursor = 'pointer';
        break;
      }
    }
    if (!foundHoveredEvent) {
      hoveredEventRef.current = null;
    }
    // ─── SL/TP handle drag ────────────────────────────────────────────────
    if (draggingHandleRef.current) {
      const pr = renderedPriceRangeRef.current;
      const mch = mainChartHeightRef.current;
      if (pr && pr.range > 0 && mch > 0) {
        const mousePrice = pr.max - (y / mch) * pr.range;
        if (draggingHandleRef.current === 'sl') {
          slDraftRef.current = mousePrice;
        } else {
          tpDraftRef.current = mousePrice;
        }
        // Custom grab cursor during drag
        if (overlayCanvasRef.current) overlayCanvasRef.current.style.cursor = sltpDraggingCursor;
        // RAF-batched redraw for silk-smooth animation
        if (sltpDragRAFRef.current === null) {
          sltpDragRAFRef.current = requestAnimationFrame(() => {
            if (drawChartRef.current) drawChartRef.current(false);
            sltpDragRAFRef.current = null;
          });
        }
        return; // Don't do chart panning while dragging SL/TP
      }
    }

    // ─── Position entry badge hover: show pointer when near badge or buttons ──
    if (positionLines && positionLines.length > 0) {
      const pr = renderedPriceRangeRef.current;
      const mch = mainChartHeightRef.current;
      if (pr && pr.range > 0 && mch > 0) {
        let overBadge = false;
        for (const pos of positionLines) {
          const posY = (pr.max - pos.price) / pr.range * mch;
          // Badge area: same as click detection (x <= 160, y within 12px)
          if (x <= 160 && Math.abs(y - posY) < 12) {
            overBadge = true;
            break;
          }
          // Place/Cancel/Close buttons area (centered, below entry line)
          if (pos.id === selectedPositionRef.current) {
            const btnH = 22;
            const btnY = Math.min(posY + 10, mch - btnH - 4);
            const cw = dimensions.width - PRICE_AXIS_WIDTH;
            const totalW = 45 + 55 + 44 + 5 * 2; // placeBw + cancelBw + closeBw + gaps
            const startX = (cw - totalW) / 2;
            if (x >= startX - 8 && x <= startX + totalW + 8 && y >= btnY - 8 && y <= btnY + btnH + 8) {
              overBadge = true;
              break;
            }
          }
        }
        if (overBadge) {
          if (overlayCanvasRef.current) overlayCanvasRef.current.style.cursor = 'pointer';
          // Don't return; still need to draw crosshair, but cursor is set
        }
      }
    }

    // ─── SL/TP hover cursor: show ns-resize when near SL/TP lines ─────────
    if (selectedPositionRef.current && positionLines && positionLines.length > 0) {
      const pr = renderedPriceRangeRef.current;
      const mch = mainChartHeightRef.current;
      if (pr && pr.range > 0 && mch > 0) {
        const mousePrice = pr.max - (y / mch) * pr.range;
        const hitThreshold = pr.range * 0.012; // ~1.2% of visible range for generous hover area
        const selPos = positionLines.find(p => p.id === selectedPositionRef.current);
        if (selPos) {
          const isBuy = selPos.side === 'buy';
          const defaultOffset = selPos.price * 0.005;
          const slPrice = slDraftRef.current ?? selPos.stopLoss ?? (isBuy ? selPos.price - defaultOffset : selPos.price + defaultOffset);
          const tpPrice = tpDraftRef.current ?? selPos.takeProfit ?? (isBuy ? selPos.price + defaultOffset : selPos.price - defaultOffset);
          const nearSL = Math.abs(mousePrice - slPrice) < hitThreshold;
          const nearTP = Math.abs(mousePrice - tpPrice) < hitThreshold;
          if (nearSL || nearTP) {
            if (overlayCanvasRef.current) overlayCanvasRef.current.style.cursor = sltpGrabCursor;
            // Store which line is hovered for visual highlight
            hoveredSLTPRef.current = nearSL ? 'sl' : 'tp';
            if (drawChartRef.current) drawChartRef.current(false);
          } else {
            if (hoveredSLTPRef.current) {
              hoveredSLTPRef.current = null;
              if (drawChartRef.current) drawChartRef.current(false);
            }
            if (overlayCanvasRef.current && overlayCanvasRef.current.style.cursor !== 'crosshair') overlayCanvasRef.current.style.cursor = 'crosshair';
          }
        }
      }
    }

    // Handle dragging with ref-based updates (no React re-renders during drag)
    if (isDragging) {
      // Safety check: if mouse button is no longer pressed but isDragging is stuck true,
      // reset immediately. This catches edge cases in multi-panel layouts where mouseup
      // fires on a different panel's canvas and the original panel never gets the event.
      // e.buttons === 0 means no mouse buttons are currently held down.
      if (e.buttons === 0) {
        setIsDragging(false);
        setScrolling(false);
        return;
      }
      // Mark as scrolling for fast mode
      setScrolling(true);

      const dx = x - dragStart.x;
      const dy = y - dragStart.y;
      const candleSpacing = viewState.candleWidth * (1 + CANDLE_GAP_RATIO);
      const indexDelta = dx / candleSpacing; // Use float for smoother panning

      // Clamp scroll so at least 85% of the viewport is filled with candles.
      // The old `candles.length - 10` allowed scrolling to a position where only
      // 10 candles were visible, causing extreme Y-axis auto-scaling with huge gaps.
      const visibleCount = Math.floor((dimensions.width - PRICE_AXIS_WIDTH) / candleSpacing);
      const maxStartIndex = candles.length - Math.floor(visibleCount * 0.85);
      const newStartIndex = Math.max(
        0,
        Math.min(maxStartIndex, dragStart.startIndex - indexDelta)
      );

      // Update scroll ref immediately (no React re-render)
      scrollStateRef.current = {
        startIndex: newStartIndex,
        candleWidth: viewState.candleWidth
      };

      // If in free mode, also pan vertically with drag (use ref to avoid re-renders)
      // IMPORTANT: Update this BEFORE notifyScrollSync so drawings use the new offset
      if (isYAxisFreeMode && fixedPriceRange !== null) {
        const pricePerPixel = (fixedPriceRange / priceScaleRef.current) / (dimensions.height - TIME_AXIS_HEIGHT);
        const yPanAmount = dy * pricePerPixel;
        priceOffsetRef.current = dragStart.priceOffset + yPanAmount;
      }

      // Schedule RAF redraw in fast mode if not already pending
      if (mouseDragRAFRef.current === null) {
        mouseDragRAFRef.current = requestAnimationFrame(() => {
          if (drawChartRef.current) {
            drawChartRef.current(true); // Fast mode - skip expensive indicator drawing
          }
          // Also draw crosshair during drag
          drawCrosshair();
          // Notify drawing overlay to re-render with new scroll position
          notifyScrollSync();
          mouseDragRAFRef.current = null;
        });
      }

      // Debounce state sync - only update React state when dragging stops
      if (scrollDebounceRef.current) {
        clearTimeout(scrollDebounceRef.current);
      }
      scrollDebounceRef.current = setTimeout(() => {
        const finalState = scrollStateRef.current;
        // Update React state first (this will trigger a useEffect that redraws)
        setViewState(prev => ({
          ...prev,
          startIndex: finalState.startIndex, // Keep float precision - no rounding
          autoFollowLatest: false,
        }));
        // Sync Y-axis state too
        if (isYAxisFreeMode) {
          setPriceOffset(priceOffsetRef.current);
        }
        // Mark scrolling as done AFTER state update is queued
        setScrolling(false);
      }, 100);

      return; // Skip the non-drag crosshair handling below
    }

    // Update hovered candle index for indicator values
    const visible = getVisibleCandles();
    const hoveredIndex = xToIndex(x, visible.startIndex);
    if (hoveredIndex >= 0 && hoveredIndex < candles.length) {
      hoveredCandleIndexRef.current = hoveredIndex;
    } else {
      hoveredCandleIndexRef.current = null;
    }

    // Draw crosshair immediately - no chart redraw needed for cursor tracking
    // This provides zero-delay crosshair movement
    drawCrosshair();
  }, [isDragging, dragStart, viewState.candleWidth, candles.length, isYAxisFreeMode, fixedPriceRange, priceScale, dimensions.height, drawCrosshair, isCrosshairMode, getVisibleCandles, xToIndex, candles]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // ─── Economic event marker click-to-pin ───────────────────────────
    // Click on a marker -> pin its tooltip. Click again -> unpin.
    // Click elsewhere -> unpin any pinned tooltip.
    let clickedOnEventMarker = false;
    for (const marker of eventMarkerPositionsRef.current) {
      const dx = x - marker.x;
      const dy2 = y - marker.y;
      if (Math.sqrt(dx * dx + dy2 * dy2) < 16) {
        clickedOnEventMarker = true;
        // Toggle: if same event is already pinned, unpin it
        if (pinnedEventRef.current && pinnedEventRef.current.ts === marker.ts && pinnedEventRef.current.x === marker.x) {
          pinnedEventRef.current = null;
        } else {
          pinnedEventRef.current = marker;
        }
        // Force redraw to show/hide pinned card
        if (drawCrosshairRef.current) drawCrosshairRef.current();
        return; // Don't start dragging
      }
    }
    // If clicked elsewhere while an event is pinned, unpin it
    if (pinnedEventRef.current && !clickedOnEventMarker) {
      pinnedEventRef.current = null;
      if (drawCrosshairRef.current) drawCrosshairRef.current();
    }

    // (Removed click handler for settings gear - replaced with static v.23 label)
    // Check if click is on an overlay indicator label text area
    // These labels are drawn on canvas starting at y=28, each 16px apart
    if (showOHLC && indicators) {
      const overlayClickOrder: { key: string; title: string; enabledCheck: () => boolean; endXSource: () => number }[] = [
        { key: 'bollinger', title: 'BB', enabledCheck: () => !!(indicators?.bollinger?.enabled && indicatorData?.bollinger), endXSource: () => bbTextEndX },
        { key: 'movingAverages', title: 'MA', enabledCheck: () => !!(indicators?.movingAverages?.enabled && indicatorData?.movingAverages), endXSource: () => maTextEndX },
        { key: 'vwap', title: 'VWAP', enabledCheck: () => !!(indicators?.vwap?.enabled && indicatorData?.vwap), endXSource: () => vwapTextEndX },
        { key: 'ichimoku', title: 'Ichimoku', enabledCheck: () => !!(indicators?.ichimoku?.enabled && indicatorData?.ichimoku), endXSource: () => overlayLabelEndX['ichimoku'] || 0 },
        { key: 'keltner', title: 'Keltner', enabledCheck: () => !!(indicators?.keltner?.enabled && indicatorData?.keltner), endXSource: () => overlayLabelEndX['keltner'] || 0 },
        { key: 'volumeProfile', title: 'Vol Profile', enabledCheck: () => !!(indicators?.volumeProfile?.enabled), endXSource: () => vpTextEndX },
        { key: 'volume', title: 'Volume', enabledCheck: () => !!(indicators?.volume?.enabled && candles.some(c => c.volume)), endXSource: () => volTextEndX },
        { key: 'supertrend', title: 'Supertrend', enabledCheck: () => !!(indicators?.supertrend?.enabled && indicatorData?.supertrend), endXSource: () => overlayLabelEndX['supertrend'] || 0 },
        { key: 'donchian', title: 'Donchian', enabledCheck: () => !!(indicators?.donchian?.enabled && indicatorData?.donchian), endXSource: () => overlayLabelEndX['donchian'] || 0 },
        { key: 'envelopes', title: 'Envelopes', enabledCheck: () => !!(indicators?.envelopes?.enabled && indicatorData?.envelopes), endXSource: () => overlayLabelEndX['envelopes'] || 0 },
        // Phase 2 overlays
        { key: 'alma', title: 'ALMA', enabledCheck: () => !!(indicators?.alma?.enabled && indicatorData?.alma), endXSource: () => overlayLabelEndX['alma'] || 0 },
        { key: 'kama', title: 'KAMA', enabledCheck: () => !!(indicators?.kama?.enabled && indicatorData?.kama), endXSource: () => overlayLabelEndX['kama'] || 0 },
        { key: 'zlema', title: 'ZLEMA', enabledCheck: () => !!(indicators?.zlema?.enabled && indicatorData?.zlema), endXSource: () => overlayLabelEndX['zlema'] || 0 },
        { key: 't3', title: 'T3', enabledCheck: () => !!(indicators?.t3?.enabled && indicatorData?.t3), endXSource: () => overlayLabelEndX['t3'] || 0 },
        { key: 'lsma', title: 'LSMA', enabledCheck: () => !!(indicators?.lsma?.enabled && indicatorData?.lsma), endXSource: () => overlayLabelEndX['lsma'] || 0 },
        { key: 'mcginley', title: 'McGinley', enabledCheck: () => !!(indicators?.mcginley?.enabled && indicatorData?.mcginley), endXSource: () => overlayLabelEndX['mcginley'] || 0 },
        { key: 'wma', title: 'WMA', enabledCheck: () => !!(indicators?.wma?.enabled && indicatorData?.wma), endXSource: () => overlayLabelEndX['wma'] || 0 },
        { key: 'smmaOverlay', title: 'SMMA', enabledCheck: () => !!(indicators?.smmaOverlay?.enabled && indicatorData?.smmaOverlay), endXSource: () => overlayLabelEndX['smmaOverlay'] || 0 },
        { key: 'vwma', title: 'VWMA', enabledCheck: () => !!(indicators?.vwma?.enabled && indicatorData?.vwma), endXSource: () => overlayLabelEndX['vwma'] || 0 },
        { key: 'medianPrice', title: 'Median', enabledCheck: () => !!(indicators?.medianPrice?.enabled && indicatorData?.medianPrice), endXSource: () => overlayLabelEndX['medianPrice'] || 0 },
        { key: 'typicalPrice', title: 'Typical', enabledCheck: () => !!(indicators?.typicalPrice?.enabled && indicatorData?.typicalPrice), endXSource: () => overlayLabelEndX['typicalPrice'] || 0 },
        { key: 'weightedClose', title: 'WClose', enabledCheck: () => !!(indicators?.weightedClose?.enabled && indicatorData?.weightedClose), endXSource: () => overlayLabelEndX['weightedClose'] || 0 },
        { key: 'zigzag', title: 'ZigZag', enabledCheck: () => !!(indicators?.zigzag?.enabled && indicatorData?.zigzag), endXSource: () => overlayLabelEndX['zigzag'] || 0 },
        { key: 'alligator', title: 'Alligator', enabledCheck: () => !!(indicators?.alligator?.enabled && indicatorData?.alligator), endXSource: () => overlayLabelEndX['alligator'] || 0 },
        { key: 'priceChannel', title: 'Price Ch', enabledCheck: () => !!(indicators?.priceChannel?.enabled && indicatorData?.priceChannel), endXSource: () => overlayLabelEndX['priceChannel'] || 0 },
        { key: 'chandeKroll', title: 'Chande Kroll', enabledCheck: () => !!(indicators?.chandeKroll?.enabled && indicatorData?.chandeKroll), endXSource: () => overlayLabelEndX['chandeKroll'] || 0 },
        { key: 'chandelierExit', title: 'Chandelier', enabledCheck: () => !!(indicators?.chandelierExit?.enabled && indicatorData?.chandelierExit), endXSource: () => overlayLabelEndX['chandelierExit'] || 0 },
        { key: 'accBands', title: 'Acc Bands', enabledCheck: () => !!(indicators?.accBands?.enabled && indicatorData?.accBands), endXSource: () => overlayLabelEndX['accBands'] || 0 },
        { key: 'demarkPivots', title: 'DeMark', enabledCheck: () => !!(indicators?.demarkPivots?.enabled && indicatorData?.demarkPivots), endXSource: () => overlayLabelEndX['demarkPivots'] || 0 },
        { key: 'fractals', title: 'Fractals', enabledCheck: () => !!(indicators?.fractals?.enabled && indicatorData?.fractals), endXSource: () => overlayLabelEndX['fractals'] || 0 },
      ];
      let labelY = 28;
      for (const ind of overlayClickOrder) {
        if (!ind.enabledCheck()) continue;
        // MAs now render one line per MA, so the hitbox must span all MA lines
        // and labelY must advance accordingly. Other indicators still use 1 row.
        const rowCount = ind.key === 'movingAverages' && indicatorData?.movingAverages
          ? Math.max(1, indicatorData.movingAverages.length)
          : 1;
        // Match the 19px (desktop) / 14px (mobile) line height used in rendering
        const labelLineH = dimensions.width < 500 ? 14 : 19;
        const blockHeight = rowCount * labelLineH;
        const labelEndX = ind.endXSource();
        if (labelEndX > 0 && x >= 0 && x <= labelEndX && y >= labelY - 10 && y <= labelY - 10 + blockHeight) {
          // Click on overlay indicator label: toggle selection
          setClickedIndicatorKey(prev => prev === ind.key ? null : ind.key);
          setHoveredIndicatorKey(ind.key);
          return; // Don't start dragging
        }
        labelY += blockHeight;
      }
    }

    // ─── TradingView-style: click on indicator LINE on chart to select it ───
    // Check if click is near any overlay indicator's plotted line
    if (indicators && indicatorData) {
      const pr = renderedPriceRangeRef.current;
      const mch = mainChartHeightRef.current;
      if (pr && mch > 0) {
        const currentState = scrollStateRef.current;
        const candleSpacing = currentState.candleWidth * (1 + CANDLE_GAP_RATIO);
        const chartWidth = dimensions.width - PRICE_AXIS_WIDTH;
        const visibleCount = Math.floor(chartWidth / candleSpacing);
        const startIdx = Math.max(0, Math.floor(currentState.startIndex));
        
        // Convert click X to candle index
        const clickCandleIdx = startIdx + Math.round(x / candleSpacing);
        const HIT_DISTANCE = 8; // pixels proximity threshold
        
        // Helper: check if click Y is near a price value
        const isNearPrice = (price: number): boolean => {
          if (isNaN(price) || !isFinite(price)) return false;
          const lineY = mch - ((price - pr.min) / pr.range) * mch;
          return Math.abs(y - lineY) < HIT_DISTANCE;
        };
        
        // Check Moving Averages lines
        if (indicators.movingAverages?.enabled && indicatorData.movingAverages) {
          for (const ma of indicatorData.movingAverages) {
            if (clickCandleIdx >= 0 && clickCandleIdx < ma.data.length) {
              if (isNearPrice(ma.data[clickCandleIdx])) {
                setClickedIndicatorKey(prev => prev === 'movingAverages' ? null : 'movingAverages');
                setHoveredIndicatorKey('movingAverages');
                return;
              }
            }
          }
        }
        
        // Check Bollinger Bands
        if (indicators.bollinger?.enabled && indicatorData.bollinger) {
          const bb = indicatorData.bollinger;
          if (clickCandleIdx >= 0 && clickCandleIdx < bb.upper.length) {
            if (isNearPrice(bb.upper[clickCandleIdx]) || isNearPrice(bb.middle[clickCandleIdx]) || isNearPrice(bb.lower[clickCandleIdx])) {
              setClickedIndicatorKey(prev => prev === 'bollinger' ? null : 'bollinger');
              setHoveredIndicatorKey('bollinger');
              return;
            }
          }
        }
        
        // Check VWAP
        if (indicators.vwap?.enabled && indicatorData.vwap) {
          if (clickCandleIdx >= 0 && clickCandleIdx < indicatorData.vwap.length) {
            if (isNearPrice(indicatorData.vwap[clickCandleIdx])) {
              setClickedIndicatorKey(prev => prev === 'vwap' ? null : 'vwap');
              setHoveredIndicatorKey('vwap');
              return;
            }
          }
        }
        
        // Check Supertrend
        if (indicators.supertrend?.enabled && indicatorData.supertrend) {
          if (clickCandleIdx >= 0 && clickCandleIdx < (indicatorData.supertrend as any).length) {
            const st = indicatorData.supertrend[clickCandleIdx];
            if (st && isNearPrice(st.value)) {
              setClickedIndicatorKey(prev => prev === 'supertrend' ? null : 'supertrend');
              setHoveredIndicatorKey('supertrend');
              return;
            }
          }
        }
        
        // Check Ichimoku (tenkan, kijun, senkouA, senkouB)
        if (indicators.ichimoku?.enabled && indicatorData.ichimoku) {
          const ich = indicatorData.ichimoku;
          if (clickCandleIdx >= 0 && clickCandleIdx < ich.tenkan.length) {
            if (isNearPrice(ich.tenkan[clickCandleIdx]) || isNearPrice(ich.kijun[clickCandleIdx]) ||
                isNearPrice(ich.senkouA[clickCandleIdx]) || isNearPrice(ich.senkouB[clickCandleIdx])) {
              setClickedIndicatorKey(prev => prev === 'ichimoku' ? null : 'ichimoku');
              setHoveredIndicatorKey('ichimoku');
              return;
            }
          }
        }
        
        // Check Keltner Channels
        if (indicators.keltner?.enabled && indicatorData.keltner) {
          const kc = indicatorData.keltner;
          if (clickCandleIdx >= 0 && clickCandleIdx < kc.upper.length) {
            if (isNearPrice(kc.upper[clickCandleIdx]) || isNearPrice(kc.middle[clickCandleIdx]) || isNearPrice(kc.lower[clickCandleIdx])) {
              setClickedIndicatorKey(prev => prev === 'keltner' ? null : 'keltner');
              setHoveredIndicatorKey('keltner');
              return;
            }
          }
        }
        
        // Check Donchian Channels
        if (indicators.donchian?.enabled && indicatorData.donchian) {
          const dc = indicatorData.donchian;
          if (clickCandleIdx >= 0 && clickCandleIdx < dc.upper.length) {
            if (isNearPrice(dc.upper[clickCandleIdx]) || isNearPrice(dc.middle[clickCandleIdx]) || isNearPrice(dc.lower[clickCandleIdx])) {
              setClickedIndicatorKey(prev => prev === 'donchian' ? null : 'donchian');
              setHoveredIndicatorKey('donchian');
              return;
            }
          }
        }
        
        // Check Envelopes
        if (indicators.envelopes?.enabled && indicatorData.envelopes) {
          const env = indicatorData.envelopes;
          if (clickCandleIdx >= 0 && clickCandleIdx < env.upper.length) {
            if (isNearPrice(env.upper[clickCandleIdx]) || isNearPrice((env as any).basis[clickCandleIdx]) || isNearPrice(env.lower[clickCandleIdx])) {
              setClickedIndicatorKey(prev => prev === 'envelopes' ? null : 'envelopes');
              setHoveredIndicatorKey('envelopes');
              return;
            }
          }
        }
        
        // Check DEMA/TEMA/HMA single-line overlays
        const singleLineOverlays = ['dema', 'tema', 'hma'] as const;
        for (const key of singleLineOverlays) {
          if ((indicators as any)[key]?.enabled && (indicatorData as any)[key]) {
            const data = (indicatorData as any)[key];
            if (Array.isArray(data) && clickCandleIdx >= 0 && clickCandleIdx < data.length) {
              if (isNearPrice(data[clickCandleIdx])) {
                setClickedIndicatorKey(prev => prev === key ? null : key);
                setHoveredIndicatorKey(key);
                return;
              }
            }
          }
        }
      }
    }

    // Check if click is on the volume overlay area (bottom 20% of main chart)
    if (indicators?.volume?.enabled) {
      const mch = mainChartHeightRef.current;
      if (mch > 0 && y >= mch * 0.8 && y <= mch) {
        setClickedIndicatorKey(prev => prev === 'volume' ? null : 'volume');
        setHoveredIndicatorKey('volume');
        return;
      }
    }

    // Check if click is on a volume profile bar (right-side horizontal bars).
    // Uses hoveredIndicatorLineRef to avoid recalculating bins on click;
    // the hover detection in handleMouseMove already set 'volumeProfile' if the
    // cursor was over a VP bar.
    if (hoveredIndicatorLineRef.current === 'volumeProfile') {
      setClickedIndicatorKey(prev => prev === 'volumeProfile' ? null : 'volumeProfile');
      setHoveredIndicatorKey('volumeProfile');
      return;
    }

    // Check if click is on a subplot indicator panel: both label area AND plotted lines
    const bounds = indicatorBoundsRef.current;

    // First check label area clicks (first 200px, first 25px) for all subplot types
    const allSubplotTypes = ['rsi', 'macd', 'atr', 'stochastic', 'volume', 'williamsR', 'cci', 'adx', 'roc',
      'aroon', 'momentum', 'ao', 'mfi', 'tsi', 'trix', 'ultimateOsc', 'dpo', 'kst', 'stochRsi',
      'bbPercent', 'bbWidth', 'histVol', 'chaikinVol', 'stdDev',
      'obv', 'cmf', 'adl', 'forceIndex', 'eom', 'correlation', 'coppock',
      // Phase 2 subplot indicators
      'vortex', 'choppiness', 'elderRay', 'massIndex', 'linRegSlope',
      'ppo', 'pvo', 'cmo', 'fisher', 'stc', 'rviOsc', 'klinger', 'connorsRsi', 'apo', 'qstick', 'bop', 'psychLine', 'pfe', 'smi',
      'ulcerIndex', 'natr', 'trueRange', 'squeeze', 'relVolIndex', 'vhf',
      'volumeOsc', 'nvi', 'pvi', 'pvt', 'vroc', 'netVolume', 'twiggsMF',
      'linRegRSquared', 'gator'];

    for (const type of allSubplotTypes) {
      const panelBounds = (bounds as any)[type];
      if (panelBounds && y >= panelBounds.top && y <= panelBounds.top + 25 && x <= 200) {
        const spKey = `sp-${type}`;
        setClickedIndicatorKey(prev => prev === spKey ? null : spKey);
        setHoveredIndicatorKey(spKey);
        return;
      }
    }

    // Then check if click is near indicator LINES within subplot panels
    if (indicators && indicatorData) {
      const currentState = scrollStateRef.current;
      const candleSpacing = currentState.candleWidth * (1 + CANDLE_GAP_RATIO);
      const startIdx = Math.max(0, Math.floor(currentState.startIndex));
      const clickIdx = startIdx + Math.round(x / candleSpacing);
      const HIT = 10; // slightly larger hit area for subplot lines
      
      // Helper: check click proximity for a subplot panel with 0-100 range
      const checkSubplotLine0_100 = (key: string, data: number[] | undefined): boolean => {
        if (!data) return false;
        const pb = (bounds as any)[key];
        if (!pb || y < pb.top || y > pb.bottom) return false;
        if (clickIdx < 0 || clickIdx >= data.length) return false;
        const val = data[clickIdx];
        if (isNaN(val) || !isFinite(val)) return false;
        const h = pb.bottom - pb.top;
        const lineY = pb.top + h - (val / 100) * h;
        return Math.abs(y - lineY) < HIT;
      };
      
      // Helper: check click proximity for a subplot with auto-ranged data
      const checkSubplotLineAutoRange = (key: string, dataArrays: (number[] | undefined)[]): boolean => {
        const pb = (bounds as any)[key];
        if (!pb || y < pb.top || y > pb.bottom) return false;
        const h = pb.bottom - pb.top;
        // Find min/max from visible data for proper Y mapping
        let dMin = Infinity, dMax = -Infinity;
        const chartWidth = dimensions.width - PRICE_AXIS_WIDTH;
        const visCount = Math.floor(chartWidth / candleSpacing);
        const vStart = Math.max(0, startIdx);
        const vEnd = Math.min(vStart + visCount, dataArrays[0]?.length ?? 0);
        for (const arr of dataArrays) {
          if (!arr) continue;
          for (let i = vStart; i < vEnd; i++) {
            const v = arr[i];
            if (!isNaN(v) && isFinite(v)) {
              if (v < dMin) dMin = v;
              if (v > dMax) dMax = v;
            }
          }
        }
        if (dMin >= dMax) return false;
        const range = dMax - dMin;
        const padding = range * 0.1;
        dMin -= padding; dMax += padding;
        const totalRange = dMax - dMin;
        
        if (clickIdx < 0) return false;
        for (const arr of dataArrays) {
          if (!arr || clickIdx >= arr.length) continue;
          const val = arr[clickIdx];
          if (isNaN(val) || !isFinite(val)) continue;
          const lineY = pb.top + h - ((val - dMin) / totalRange) * h;
          if (Math.abs(y - lineY) < HIT) return true;
        }
        return false;
      };
      
      // RSI (0-100)
      if (indicators.rsi?.enabled && checkSubplotLine0_100('rsi', indicatorData.rsi)) {
        setClickedIndicatorKey(prev => prev === 'sp-rsi' ? null : 'sp-rsi');
        setHoveredIndicatorKey('sp-rsi');
        return;
      }
      // Stochastic (0-100)
      if (indicators.stochastic?.enabled && indicatorData.stochastic) {
        if (checkSubplotLine0_100('stochastic', indicatorData.stochastic.k) ||
            checkSubplotLine0_100('stochastic', indicatorData.stochastic.d)) {
          setClickedIndicatorKey(prev => prev === 'sp-stochastic' ? null : 'sp-stochastic');
          setHoveredIndicatorKey('sp-stochastic');
          return;
        }
      }
      // MACD (auto-ranged)
      if (indicators.macd?.enabled && indicatorData.macd) {
        if (checkSubplotLineAutoRange('macd', [indicatorData.macd.macd, indicatorData.macd.signal])) {
          setClickedIndicatorKey(prev => prev === 'sp-macd' ? null : 'sp-macd');
          setHoveredIndicatorKey('sp-macd');
          return;
        }
      }
      // ATR (auto-ranged)
      if (indicators.atr?.enabled && indicatorData.atr) {
        if (checkSubplotLineAutoRange('atr', [indicatorData.atr])) {
          setClickedIndicatorKey(prev => prev === 'sp-atr' ? null : 'sp-atr');
          setHoveredIndicatorKey('sp-atr');
          return;
        }
      }
      // WilliamsR (-100 to 0)
      if (indicators.williamsR?.enabled && indicatorData.williamsR) {
        const pb = (bounds as any).williamsR;
        if (pb && y >= pb.top && y <= pb.bottom && clickIdx >= 0 && clickIdx < indicatorData.williamsR.length) {
          const val = indicatorData.williamsR[clickIdx];
          if (!isNaN(val) && isFinite(val)) {
            const h = pb.bottom - pb.top;
            const lineY = pb.top + h - ((val + 100) / 100) * h; // -100 -> bottom, 0 -> top
            if (Math.abs(y - lineY) < HIT) {
              setClickedIndicatorKey(prev => prev === 'sp-williamsR' ? null : 'sp-williamsR');
              setHoveredIndicatorKey('sp-williamsR');
              return;
            }
          }
        }
      }
      // CCI (auto-ranged)
      if (indicators.cci?.enabled && indicatorData.cci) {
        if (checkSubplotLineAutoRange('cci', [indicatorData.cci])) {
          setClickedIndicatorKey(prev => prev === 'sp-cci' ? null : 'sp-cci');
          setHoveredIndicatorKey('sp-cci');
          return;
        }
      }
      // ADX (0-100)
      if (indicators.adx?.enabled && indicatorData.adx) {
        if (checkSubplotLine0_100('adx', indicatorData.adx.adx) ||
            checkSubplotLine0_100('adx', indicatorData.adx.plusDI) ||
            checkSubplotLine0_100('adx', indicatorData.adx.minusDI)) {
          setClickedIndicatorKey(prev => prev === 'sp-adx' ? null : 'sp-adx');
          setHoveredIndicatorKey('sp-adx');
          return;
        }
      }
      // ROC (auto-ranged)
      if (indicators.roc?.enabled && indicatorData.roc) {
        if (checkSubplotLineAutoRange('roc', [indicatorData.roc])) {
          setClickedIndicatorKey(prev => prev === 'sp-roc' ? null : 'sp-roc');
          setHoveredIndicatorKey('sp-roc');
          return;
        }
      }
      // Generic: check any subplot panel click (for remaining types)
      for (const type of allSubplotTypes) {
        const pb = (bounds as any)[type];
        if (pb && y >= pb.top && y <= pb.bottom) {
          const data = (indicatorData as any)[type];
          if (data && Array.isArray(data) && checkSubplotLineAutoRange(type, [data])) {
            const spKey = `sp-${type}`;
            setClickedIndicatorKey(prev => prev === spKey ? null : spKey);
            setHoveredIndicatorKey(spKey);
            return;
          }
        }
      }
    }

    // Close settings and deselect indicator if clicking elsewhere
    if (selectedIndicator) {
      setSelectedIndicator(null);
    }
    if (clickedIndicatorKey) {
      setClickedIndicatorKey(null);
    }
    if (indicatorContextMenu) {
      setIndicatorContextMenu(null);
    }

    // ─── SL/TP interaction: detect clicks on position lines ─────────────
    // Skip if a touch event just handled SL/TP (prevents synthetic mouse from toggling)
    if (positionLines && positionLines.length > 0 && (Date.now() - lastTouchInteractionRef.current > 500)) {
      const pr = renderedPriceRangeRef.current;
      const mch = mainChartHeightRef.current;
      if (pr && pr.range > 0 && mch > 0) {
        const mousePrice = pr.max - (y / mch) * pr.range;
        const hitThreshold = pr.range * 0.006; // ~0.6% of visible range

        // ─── Place/Cancel/Close button click detection ───────────────────────
        if (selectedPositionRef.current) {
          const selPos = positionLines.find(p => p.id === selectedPositionRef.current);
          if (selPos) {
            const entryY = (pr.max - selPos.price) / pr.range * mch;
            const btnH = 22;
            const btnY = Math.min(entryY + 10, mch - btnH - 4);
            const btnGap = 5;

            // Button widths must match rendering code (text width + 16)
            const placeBw = 45;
            const cancelBw = 55;
            const closeBw = 44;
            const cw = dimensions.width - PRICE_AXIS_WIDTH;
            const totalW = placeBw + cancelBw + closeBw + btnGap * 2;
            const startX = (cw - totalW) / 2;
            const placeBx = startX;
            const cancelBx = placeBx + placeBw + btnGap;
            const closeBxVal = cancelBx + cancelBw + btnGap;

            const pad = 8;
            // Place button hit: saves the SL/TP to the position.
            // Uses draft values if the user dragged the lines, otherwise falls back
            // to the suggested defaults (0.5% offset from entry) that are visually
            // shown on the chart. Without this fallback, clicking Place on the
            // default suggestion lines would send undefined and not save anything.
            if (x >= placeBx - pad && x <= placeBx + placeBw + pad && y >= btnY - pad && y <= btnY + btnH + pad) {
              if (onPositionModify) {
                const isBuyPos = selPos.side === 'buy';
                const defaultOff = selPos.price * 0.005;
                const finalSL = slDraftRef.current ?? selPos.stopLoss ?? (isBuyPos ? selPos.price - defaultOff : selPos.price + defaultOff);
                const finalTP = tpDraftRef.current ?? selPos.takeProfit ?? (isBuyPos ? selPos.price + defaultOff : selPos.price - defaultOff);
                onPositionModify(selectedPositionRef.current, finalSL, finalTP);
              }
              selectedPositionRef.current = null;
              slDraftRef.current = null;
              tpDraftRef.current = null;
              draggingHandleRef.current = null;
              forceRender(n => n + 1);
              if (drawChartRef.current) drawChartRef.current(false);
              return;
            }

            // Cancel button hit
            if (x >= cancelBx - pad && x <= cancelBx + cancelBw + pad && y >= btnY - pad && y <= btnY + btnH + pad) {
              selectedPositionRef.current = null;
              slDraftRef.current = null;
              tpDraftRef.current = null;
              draggingHandleRef.current = null;
              forceRender(n => n + 1);
              if (drawChartRef.current) drawChartRef.current(false);
              return;
            }

            // Close button hit: close position at market
            if (x >= closeBxVal - pad && x <= closeBxVal + closeBw + pad && y >= btnY - pad && y <= btnY + btnH + pad) {
              if (onPositionClose) {
                onPositionClose(selectedPositionRef.current);
              }
              selectedPositionRef.current = null;
              slDraftRef.current = null;
              tpDraftRef.current = null;
              draggingHandleRef.current = null;
              forceRender(n => n + 1);
              if (drawChartRef.current) drawChartRef.current(false);
              return;
            }
          }
        }

        // SL/TP drag handle detection (when position already selected)
        if (selectedPositionRef.current) {
          const selPos2 = positionLines.find(p => p.id === selectedPositionRef.current);
          if (selPos2) {
            const isBuy = selPos2.side === 'buy';
            const defaultOffset = selPos2.price * 0.005;
            const slPrice = slDraftRef.current ?? selPos2.stopLoss ?? (isBuy ? selPos2.price - defaultOffset : selPos2.price + defaultOffset);
            const tpPrice = tpDraftRef.current ?? selPos2.takeProfit ?? (isBuy ? selPos2.price + defaultOffset : selPos2.price - defaultOffset);

            if (Math.abs(mousePrice - slPrice) < hitThreshold) {
              draggingHandleRef.current = 'sl';
              slDraftRef.current = slPrice;
              return; // Don't start chart drag
            }
            if (Math.abs(mousePrice - tpPrice) < hitThreshold) {
              draggingHandleRef.current = 'tp';
              tpDraftRef.current = tpPrice;
              return;
            }
          }
        }

        // Check clicks on entry lines to select/deselect
        let clickedPos: string | null = null;
        for (const pos of positionLines) {
          if (Math.abs(mousePrice - pos.price) < hitThreshold) {
            clickedPos = pos.id;
            break;
          }
        }

        if (clickedPos) {
          if (selectedPositionRef.current === clickedPos) {
            // Deselect
            selectedPositionRef.current = null;
            slDraftRef.current = null;
            tpDraftRef.current = null;
          } else {
            // Select
            selectedPositionRef.current = clickedPos;
            const pos = positionLines.find(p => p.id === clickedPos);
            slDraftRef.current = pos?.stopLoss ?? null;
            tpDraftRef.current = pos?.takeProfit ?? null;
          }
          draggingHandleRef.current = null;
          forceRender(n => n + 1);
          if (drawChartRef.current) drawChartRef.current(false);
          return; // Don't start chart drag
        }

        // Click elsewhere: DON'T deselect; lines persist until Place/Cancel
      }
    }

    setIsDragging(true);
    setDragStart({ x, y, startIndex: viewState.startIndex, priceOffset });
  }, [viewState.startIndex, priceOffset, selectedIndicator, clickedIndicatorKey, indicatorContextMenu, positionLines, onPositionModify, onPositionClose, onOpenSettings]);

  const handleMouseUp = useCallback(() => {
    // ─── SL/TP drag end: stop drag but DON'T save yet ────────────────────
    if (draggingHandleRef.current && selectedPositionRef.current) {
      draggingHandleRef.current = null;
      if (overlayCanvasRef.current) overlayCanvasRef.current.style.cursor = 'crosshair';
      if (drawChartRef.current) drawChartRef.current(false);
      return; // Don't process chart drag end
    }

    // Sync scroll state to React state when drag ends
    if (isScrollingRef.current) {
      setScrolling(false);
      const finalState = scrollStateRef.current;
      // Do a full redraw with indicators
      if (drawChartRef.current) {
        drawChartRef.current(false);
      }
      // In replay mode: if user scrolled back to the right edge (latest candle visible),
      // reset the flag so auto-follow resumes. Otherwise mark as user-scrolled to
      // prevent auto-scroll from pulling the view back during playback.
      if (disableAutoFollow) {
        const chartWidth = dimensions.width - PRICE_AXIS_WIDTH;
        const candleSpacing = viewState.candleWidth * (1 + CANDLE_GAP_RATIO);
        const visibleCount = Math.floor(chartWidth / candleSpacing);
        const endIdx = finalState.startIndex + visibleCount;
        const latestVisible = (candles.length - 1) < endIdx;
        replayUserScrolledRef.current = !latestVisible;
      }
      setViewState(prev => ({
        ...prev,
        startIndex: finalState.startIndex, // Keep float precision - no rounding
        autoFollowLatest: false,
      }));
    }

    // Cancel any pending drag RAF
    if (mouseDragRAFRef.current !== null) {
      cancelAnimationFrame(mouseDragRAFRef.current);
      mouseDragRAFRef.current = null;
    }

    setIsDragging(false);
  }, [onPositionModify, onPositionClose]);

  // ─── Window-level mouseup listener to prevent stuck drag state in multi-panel mode ───
  // In multi-panel layouts, the user can mousedown on Panel A then release over Panel B.
  // Panel A's canvas mouseup never fires because the cursor left its bounds, leaving
  // isDragging stuck at true (free-pan mode). This window listener catches the mouseup
  // globally so isDragging always resets regardless of which panel the cursor is over.
  useEffect(() => {
    if (!isDragging) return;
    const handleGlobalMouseUp = () => {
      handleMouseUp();
    };
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => {
      window.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [isDragging, handleMouseUp]);

  // ─── Keyboard shortcuts for SL/TP: Enter = Place, Escape/Backspace = Cancel ───
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!selectedPositionRef.current) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (onPositionModify) {
          onPositionModify(selectedPositionRef.current, slDraftRef.current ?? undefined, tpDraftRef.current ?? undefined);
        }
        selectedPositionRef.current = null;
        slDraftRef.current = null;
        tpDraftRef.current = null;
        draggingHandleRef.current = null;
        forceRender(n => n + 1);
        if (drawChartRef.current) drawChartRef.current(false);
      } else if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault();
        selectedPositionRef.current = null;
        slDraftRef.current = null;
        tpDraftRef.current = null;
        draggingHandleRef.current = null;
        forceRender(n => n + 1);
        if (drawChartRef.current) drawChartRef.current(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onPositionModify, onPositionClose]);

  // ─── Backspace/Delete removes selected indicator (TradingView behaviour) ───
  // When an indicator is selected (clickedIndicatorKey is set) and the user
  // presses Backspace or Delete, disable that indicator in the config.
  useEffect(() => {
    const handleIndicatorDelete = (e: KeyboardEvent) => {
      if (!clickedIndicatorKey || !indicators || !onIndicatorsChange) return;
      // Don't intercept if user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        // Map clickedIndicatorKey to the config key:
        // Overlay indicators use their key directly (e.g. 'movingAverages')
        // Subplot indicators are prefixed with 'sp-' (e.g. 'sp-rsi' -> 'rsi')
        const configKey = clickedIndicatorKey.startsWith('sp-')
          ? clickedIndicatorKey.replace('sp-', '')
          : clickedIndicatorKey;

        const cfg = (indicators as any)[configKey];
        if (cfg) {
          onIndicatorsChange({ ...indicators, [configKey]: { ...cfg, enabled: false } });
        }
        setClickedIndicatorKey(null);
      } else if (e.key === 'Escape') {
        // Escape just deselects without deleting
        setClickedIndicatorKey(null);
      }
    };
    window.addEventListener('keydown', handleIndicatorDelete);
    return () => window.removeEventListener('keydown', handleIndicatorDelete);
  }, [clickedIndicatorKey, indicators, onIndicatorsChange]);

  const handleMouseLeave = useCallback(() => {
    // Use a small timeout to allow settings button hover to be detected first
    if (mouseLeaveTimeoutRef.current) {
      clearTimeout(mouseLeaveTimeoutRef.current);
    }

    mouseLeaveTimeoutRef.current = setTimeout(() => {
      // Don't clear crosshair if now hovering over settings buttons
      if (isHoveringSettingsRef.current) return;

      crosshairRef.current = null;
      hoveredCandleIndexRef.current = null;
      hoveredEventRef.current = null;
      // Keep pinned event visible even after mouse leaves
      // Clear overlay canvas then redraw OHLC legend (shows latest candle
      // when mouse leaves, so OHLC is always visible like TradingView)
      const canvas = overlayCanvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (ctx && canvas) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      // Redraw overlay to show OHLC with latest candle data
      if (drawCrosshairRef.current) drawCrosshairRef.current();
      // Redraw chart to reset indicator values to latest
      drawChart();
      setIsDragging(false);
      setIsScalingYAxis(false);
      if (onCrosshairMove) onCrosshairMove(null, null);
    }, 50);
  }, [onCrosshairMove, drawChart]);



  useEffect(() => {
    if (!isScalingYAxis && !isPanningYAxis) return;

    const handleScaleMove = (e: MouseEvent) => {
      const deltaY = yAxisScaleStartRef.current.y - e.clientY;

      // Scaling: stretch/compress based on vertical drag (use ref to avoid re-renders)
      const scaleDelta = deltaY / 150; // Smoother scaling
      const newScale = Math.max(0.1, Math.min(10.0, yAxisScaleStartRef.current.scale + scaleDelta));
      priceScaleRef.current = newScale;

      // Immediate redraw using ref
      if (drawChartRef.current) {
        drawChartRef.current(true);
      }
      // Sync drawings immediately - no lag
      notifyScrollSync();

      // Debounce state sync
      if (yAxisDebounceRef.current) {
        clearTimeout(yAxisDebounceRef.current);
      }
      yAxisDebounceRef.current = setTimeout(() => {
        setPriceScale(priceScaleRef.current);
      }, 100);
    };

    const handleScaleEnd = () => {
      setIsScalingYAxis(false);
      setIsPanningYAxis(false);
      // Final state sync
      setPriceScale(priceScaleRef.current);
      notifyScrollSync();
    };

    // Touch handler mirrors mouse handler for mobile
    const handleScaleTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      const deltaY = yAxisScaleStartRef.current.y - e.touches[0].clientY;
      const scaleDelta = deltaY / 150;
      const newScale = Math.max(0.1, Math.min(10.0, yAxisScaleStartRef.current.scale + scaleDelta));
      priceScaleRef.current = newScale;

      if (drawChartRef.current) {
        drawChartRef.current(true);
      }
      notifyScrollSync();

      if (yAxisDebounceRef.current) {
        clearTimeout(yAxisDebounceRef.current);
      }
      yAxisDebounceRef.current = setTimeout(() => {
        setPriceScale(priceScaleRef.current);
      }, 100);
    };

    window.addEventListener('mousemove', handleScaleMove);
    window.addEventListener('mouseup', handleScaleEnd);
    window.addEventListener('touchmove', handleScaleTouchMove, { passive: false });
    window.addEventListener('touchend', handleScaleEnd);
    window.addEventListener('touchcancel', handleScaleEnd);

    return () => {
      window.removeEventListener('mousemove', handleScaleMove);
      window.removeEventListener('mouseup', handleScaleEnd);
      window.removeEventListener('touchmove', handleScaleTouchMove);
      window.removeEventListener('touchend', handleScaleEnd);
      window.removeEventListener('touchcancel', handleScaleEnd);
    };
  }, [isScalingYAxis, isPanningYAxis, notifyScrollSync]);








  // Touch event handlers for mobile (TradingView-style: long-press for crosshair)
  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault(); // Prevent iOS Safari callout menu

    if (e.touches.length === 1) {
      const touch = e.touches[0];
      const canvas = overlayCanvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = touch.clientX - rect.left;
      const y = touch.clientY - rect.top;

      // Store initial touch position
      touchStartPosRef.current = { x, y };

      // Always clear any existing timer first - critical for double-tap
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }

      // Clear any existing crosshair
      if (isCrosshairMode) {
        setIsCrosshairMode(false);
        crosshairRef.current = null;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
      }

      // Mark finger as down with a unique touch session ID
      const touchSession = Date.now();
      isTouchDownRef.current = true;
      touchIdRef.current = touchSession;

      // Double-tap detection
      const timeSinceLastTap = touchSession - lastTapTimeRef.current;
      lastTapTimeRef.current = touchSession;

      // If this tap is within 300ms of the last tap, it's a double-tap - block crosshair
      const isDoubleTap = timeSinceLastTap < 300;

      // Only start long-press timer if this is NOT a double-tap
      if (!isDoubleTap) {
        const timerTouchSession = touchSession;
        longPressTimerRef.current = setTimeout(() => {
          // Only activate if same touch session and finger still down
          if (touchIdRef.current === timerTouchSession && isTouchDownRef.current) {
            setIsCrosshairMode(true);
            crosshairRef.current = { x, y };
            if (crosshairRAFRef.current !== null) {
              cancelAnimationFrame(crosshairRAFRef.current);
            }
            crosshairRAFRef.current = requestAnimationFrame(() => {
              drawCrosshair();
              crosshairRAFRef.current = null;
            });
          }
          longPressTimerRef.current = null;
        }, 400);
      }

      // ─── SL/TP touch interaction: detect taps on position lines ─────────────
      if (positionLines && positionLines.length > 0) {
        lastTouchInteractionRef.current = Date.now(); // Prevent synthetic mouse from re-processing
        const pr = renderedPriceRangeRef.current;
        const mch = mainChartHeightRef.current;
        if (pr && pr.range > 0 && mch > 0) {
          const touchPrice = pr.max - (y / mch) * pr.range;
          const hitThreshold = pr.range * 0.015; // 1.5%, generous for fat fingers

          // Place/Cancel/Close button tap detection
          if (selectedPositionRef.current) {
            const selPos = positionLines.find(p => p.id === selectedPositionRef.current);
            if (selPos) {
              const entryY = (pr.max - selPos.price) / pr.range * mch;
              const btnH = 22;
              const btnY2 = Math.min(entryY + 10, mch - btnH - 4);
              const btnGap = 5;
              const cw = dimensions.width - PRICE_AXIS_WIDTH;
              const placeBw = 45;
              const cancelBw = 55;
              const closeBw = 44;
              const totalW = placeBw + cancelBw + closeBw + btnGap * 2;
              const startX2 = (cw - totalW) / 2;
              const placeBx = startX2;
              const cancelBx = placeBx + placeBw + btnGap;
              const closeBxVal = cancelBx + cancelBw + btnGap;
              const pad = 12; // Extra padding for touch

              if (x >= placeBx - pad && x <= placeBx + placeBw + pad && y >= btnY2 - pad && y <= btnY2 + btnH + pad) {
                if (onPositionModify) {
                  onPositionModify(selectedPositionRef.current, slDraftRef.current ?? undefined, tpDraftRef.current ?? undefined);
                }
                selectedPositionRef.current = null;
                slDraftRef.current = null;
                tpDraftRef.current = null;
                draggingHandleRef.current = null;
                forceRender(n => n + 1);
                if (drawChartRef.current) drawChartRef.current(false);
                return;
              }

              if (x >= cancelBx - pad && x <= cancelBx + cancelBw + pad && y >= btnY2 - pad && y <= btnY2 + btnH + pad) {
                selectedPositionRef.current = null;
                slDraftRef.current = null;
                tpDraftRef.current = null;
                draggingHandleRef.current = null;
                forceRender(n => n + 1);
                if (drawChartRef.current) drawChartRef.current(false);
                return;
              }

              // Close button: close position at market
              if (x >= closeBxVal - pad && x <= closeBxVal + closeBw + pad && y >= btnY2 - pad && y <= btnY2 + btnH + pad) {
                if (onPositionClose) {
                  onPositionClose(selectedPositionRef.current);
                }
                selectedPositionRef.current = null;
                slDraftRef.current = null;
                tpDraftRef.current = null;
                draggingHandleRef.current = null;
                forceRender(n => n + 1);
                if (drawChartRef.current) drawChartRef.current(false);
                return;
              }
            }
          }

          // SL/TP drag handle detection (touch near an SL or TP line)
          if (selectedPositionRef.current) {
            const selPos2 = positionLines.find(p => p.id === selectedPositionRef.current);
            if (selPos2) {
              const isBuy = selPos2.side === 'buy';
              const defaultOffset = selPos2.price * 0.005;
              const slPrice = slDraftRef.current ?? selPos2.stopLoss ?? (isBuy ? selPos2.price - defaultOffset : selPos2.price + defaultOffset);
              const tpPrice = tpDraftRef.current ?? selPos2.takeProfit ?? (isBuy ? selPos2.price + defaultOffset : selPos2.price - defaultOffset);

              if (Math.abs(touchPrice - slPrice) < hitThreshold) {
                draggingHandleRef.current = 'sl';
                slDraftRef.current = slPrice;
                if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
                return; // Don't start chart pan
              }
              if (Math.abs(touchPrice - tpPrice) < hitThreshold) {
                draggingHandleRef.current = 'tp';
                tpDraftRef.current = tpPrice;
                if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
                return;
              }
            }
          }

          // Tap on entry badge label ("BUY 0.01 @ price") to select/deselect position
          // Only matches taps on the badge area (left side), not the entire price line
          let clickedPos: string | null = null;
          for (const pos of positionLines) {
            const posY = (pr.max - pos.price) / pr.range * mch;
            // Badge area: x = 4..~150px, y = posY ± 20px (generous for touch)
            if (x <= 160 && Math.abs(y - posY) < 20) {
              clickedPos = pos.id;
              break;
            }
          }
          if (clickedPos) {
            if (selectedPositionRef.current === clickedPos) {
              selectedPositionRef.current = null;
              slDraftRef.current = null;
              tpDraftRef.current = null;
            } else {
              selectedPositionRef.current = clickedPos;
              const pos = positionLines.find(p => p.id === clickedPos);
              slDraftRef.current = pos?.stopLoss ?? null;
              tpDraftRef.current = pos?.takeProfit ?? null;
            }
            draggingHandleRef.current = null;
            if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
            forceRender(n => n + 1);
            if (drawChartRef.current) drawChartRef.current(false);
            return; // Don't start chart pan
          }
        }
      }

      setIsDragging(true);
      setDragStart({ x, y, startIndex: viewState.startIndex, priceOffset });
    }
  }, [viewState.startIndex, priceOffset, drawCrosshair, isCrosshairMode]);

  // Pinch-to-zoom for mobile
  const lastPinchDistanceRef = useRef<number | null>(null);

  const handlePinchZoom = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 2) {
      e.preventDefault();

      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const distance = Math.hypot(
        touch2.clientX - touch1.clientX,
        touch2.clientY - touch1.clientY
      );

      if (lastPinchDistanceRef.current !== null) {
        const currentCandleWidth = scrollStateRef.current.candleWidth;
        const currentStartIndex = scrollStateRef.current.startIndex;
        
        // Use physical distance ratio for smooth, continuous zoom (like TradingView)
        // 1.3x amplifier balances responsiveness with control on small screens
        const ratio = distance / lastPinchDistanceRef.current;
        const delta = 1 + (ratio - 1) * 1.3;
        
        const newCandleWidth = Math.max(
          MIN_CANDLE_WIDTH,
          Math.min(MAX_CANDLE_WIDTH, currentCandleWidth * delta)
        );

        // Calculate center point of pinch
        const canvas = overlayCanvasRef.current;
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          const centerX = ((touch1.clientX + touch2.clientX) / 2) - rect.left;
          const candleSpacing = currentCandleWidth * (1 + CANDLE_GAP_RATIO);
          const newCandleSpacing = newCandleWidth * (1 + CANDLE_GAP_RATIO);

          const centerIndex = currentStartIndex + centerX / candleSpacing;
          const newStartIndex = Math.max(0, centerIndex - centerX / newCandleSpacing);

          // Update ref immediately for instant drawing sync
          scrollStateRef.current = { startIndex: newStartIndex, candleWidth: newCandleWidth };

          // Trigger immediate redraw and sync
          if (drawChartRef.current) drawChartRef.current(true);
          notifyScrollSync();

          // Sync to React state (debounced to avoid excessive re-renders during fast pinching)
          setViewState(prev => ({
            ...prev,
            candleWidth: newCandleWidth,
            startIndex: newStartIndex,
            autoFollowLatest: false,
          }));
        }
      }

      lastPinchDistanceRef.current = distance;
    }
  }, [notifyScrollSync]);

  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    // Handle pinch-to-zoom with 2 fingers
    if (e.touches.length === 2) {
      handlePinchZoom(e);
      // Cancel long-press timer on pinch
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      return;
    }

    // Handle single-finger touch
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      const canvas = overlayCanvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = touch.clientX - rect.left;
      const y = touch.clientY - rect.top;

      // Check if moved significantly - cancel long-press timer if scrolling
      if (longPressTimerRef.current && touchStartPosRef.current) {
        const dx = Math.abs(x - touchStartPosRef.current.x);
        const dy = Math.abs(y - touchStartPosRef.current.y);
        if (dx > 10 || dy > 10) {
          clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }
      }

      // Only show crosshair if in crosshair mode (long-press activated)
      if (isCrosshairMode) {
        crosshairRef.current = { x, y };
        if (crosshairRAFRef.current !== null) {
          cancelAnimationFrame(crosshairRAFRef.current);
        }
        crosshairRAFRef.current = requestAnimationFrame(() => {
          drawCrosshair();
          crosshairRAFRef.current = null;
        });
      }

      // ─── SL/TP touch drag: update draft price ────────────────────────
      if (draggingHandleRef.current) {
        e.preventDefault();
        const pr = renderedPriceRangeRef.current;
        const mch = mainChartHeightRef.current;
        if (pr && pr.range > 0 && mch > 0) {
          const touchPrice = pr.max - (y / mch) * pr.range;
          if (draggingHandleRef.current === 'sl') {
            slDraftRef.current = touchPrice;
          } else {
            tpDraftRef.current = touchPrice;
          }
          // RAF-batched redraw for silk-smooth touch animation
          if (sltpDragRAFRef.current === null) {
            sltpDragRAFRef.current = requestAnimationFrame(() => {
              if (drawChartRef.current) drawChartRef.current(false);
              sltpDragRAFRef.current = null;
            });
          }
        }
        return; // Don't pan while dragging SL/TP
      }

      // Handle panning when dragging (only if not in crosshair mode)
      // Use RAF throttling with refs for smooth mobile performance
      if (isDragging && !isCrosshairMode) {
        e.preventDefault();

        // Mark as scrolling for fast mode
        setScrolling(true);

        const dx = x - dragStart.x;
        const dy = y - dragStart.y;
        const candleSpacing = viewState.candleWidth * (1 + CANDLE_GAP_RATIO);
        const indexDelta = dx / candleSpacing;

        // Clamp scroll so at least 85% of the viewport is filled with candles (touch drag).
        const visibleCount = Math.floor((dimensions.width - PRICE_AXIS_WIDTH) / candleSpacing);
        const maxStartIndex = candles.length - Math.floor(visibleCount * 0.85);
        const newStartIndex = Math.max(
          0,
          Math.min(maxStartIndex, dragStart.startIndex - indexDelta)
        );

        // If in free mode, also pan vertically with drag (mirrors desktop mouse behavior)
        if (isYAxisFreeMode && fixedPriceRange !== null) {
          const pricePerPixel = (fixedPriceRange / priceScaleRef.current) / (dimensions.height - TIME_AXIS_HEIGHT);
          const yPanAmount = dy * pricePerPixel;
          priceOffsetRef.current = dragStart.priceOffset + yPanAmount;
        }

        // Update scroll ref immediately (no React re-render)
        scrollStateRef.current = {
          startIndex: newStartIndex,
          candleWidth: viewState.candleWidth
        };

        // Schedule RAF redraw in fast mode if not already pending
        if (touchPanRAFRef.current === null) {
          touchPanRAFRef.current = requestAnimationFrame(() => {
            if (drawChartRef.current) {
              drawChartRef.current(true); // Fast mode
            }
            // Notify drawing overlay to re-render with new scroll position
            notifyScrollSync();
            touchPanRAFRef.current = null;
          });
        }
      }
    }
  }, [isDragging, dragStart, viewState.candleWidth, candles.length, handlePinchZoom, drawCrosshair, isCrosshairMode, isYAxisFreeMode, fixedPriceRange, dimensions.height, positionLines]);

  const handleTouchEnd = useCallback(() => {
    // Mark finger as lifted - prevents any pending timer from activating crosshair
    isTouchDownRef.current = false;
    touchIdRef.current = 0;

    // Clear long-press timer
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }

    // ─── SL/TP touch drag end ──────────────────────────────────────────
    if (draggingHandleRef.current && selectedPositionRef.current) {
      draggingHandleRef.current = null;
      if (drawChartRef.current) drawChartRef.current(false);
      // Don't process chart drag end; just stop SL/TP drag
      isTouchDownRef.current = false;
      touchIdRef.current = 0;
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      return;
    }

    // Exit crosshair mode and clear crosshair display
    if (isCrosshairMode) {
      setIsCrosshairMode(false);
      crosshairRef.current = null;
      const canvas = overlayCanvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (ctx && canvas) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      if (onCrosshairMove) onCrosshairMove(null, null);
    }

    // Sync scroll state to React state when touch ends
    if (isScrollingRef.current) {
      setScrolling(false);
      const finalState = scrollStateRef.current;
      // Do a full redraw with indicators
      if (drawChartRef.current) {
        drawChartRef.current(false);
      }
      // In replay mode: if user scrolled back to the right edge (latest candle visible),
      // reset the flag so auto-follow resumes. Otherwise mark as user-scrolled to
      // prevent auto-scroll from pulling the view back during playback.
      if (disableAutoFollow) {
        const chartWidth = dimensions.width - PRICE_AXIS_WIDTH;
        const candleSpacing = viewState.candleWidth * (1 + CANDLE_GAP_RATIO);
        const visibleCount = Math.floor(chartWidth / candleSpacing);
        const endIdx = finalState.startIndex + visibleCount;
        const latestVisible = (candles.length - 1) < endIdx;
        replayUserScrolledRef.current = !latestVisible;
      }
      setViewState(prev => ({
        ...prev,
        startIndex: finalState.startIndex, // Keep float precision - no rounding
        autoFollowLatest: false,
      }));
      // Sync Y-axis state too (mirrors desktop mouse behavior)
      if (isYAxisFreeMode) {
        setPriceOffset(priceOffsetRef.current);
      }
    }

    setIsDragging(false);
    lastPinchDistanceRef.current = null;
    touchStartPosRef.current = null;
    pendingStartIndexRef.current = null;
    // Cancel any pending touch pan RAF
    if (touchPanRAFRef.current !== null) {
      cancelAnimationFrame(touchPanRAFRef.current);
      touchPanRAFRef.current = null;
    }
  }, [isCrosshairMode, onCrosshairMove, isYAxisFreeMode]);

  // Find the closest zoom level to a given candle width
  const findClosestZoomLevel = useCallback((width: number): number => {
    let closest = ZOOM_LEVELS[0];
    let minDiff = Math.abs(width - closest);
    for (const level of ZOOM_LEVELS) {
      const diff = Math.abs(width - level);
      if (diff < minDiff) {
        minDiff = diff;
        closest = level;
      }
    }
    return closest;
  }, [ZOOM_LEVELS]);

  // Get the next zoom level (in or out)
  const getNextZoomLevel = useCallback((currentWidth: number, zoomIn: boolean): number => {
    const currentIndex = ZOOM_LEVELS.findIndex(level => level >= currentWidth - 0.001);
    if (zoomIn) {
      // Zoom in = larger candles = higher index
      const nextIndex = Math.min(ZOOM_LEVELS.length - 1, currentIndex + 1);
      return ZOOM_LEVELS[nextIndex];
    } else {
      // Zoom out = smaller candles = lower index
      const nextIndex = Math.max(0, currentIndex - 1);
      return ZOOM_LEVELS[nextIndex];
    }
  }, [ZOOM_LEVELS]);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    // On Windows/Linux trackpads: handle deltaX (time pan) + deltaY (price pan) simultaneously
    // Ctrl+scroll zooms. On Mac: all wheel events go through the existing zoom/pan logic.
    const isCtrlZoom = e.ctrlKey || e.metaKey;

    if (!isMacRef.current && !isCtrlZoom) {
      // Windows/Linux trackpads: match Mac behavior
      // Horizontal swipe (deltaX or shift+scroll) -> pan time axis, then return
      // Vertical swipe (deltaY) -> fall through to zoom logic below (like Mac)
      const hasDeltaX = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      const hasShiftScroll = e.shiftKey && e.deltaY !== 0;

      if (hasDeltaX || hasShiftScroll) {
        e.preventDefault();

        const currentStartIndex = scrollStateRef.current.startIndex;
        const currentCandleWidth = scrollStateRef.current.candleWidth;
        const candleSpacing = currentCandleWidth * (1 + CANDLE_GAP_RATIO);

        setScrolling(true);
        const scrollAmount = hasShiftScroll ? e.deltaY : e.deltaX;
        const baseSensitivity = 0.2 + (scrollSensitivity - 1) * 0.2;
        const indexDelta = (scrollAmount * baseSensitivity) / candleSpacing;
        // Clamp scroll so at least 85% of the viewport is filled (horizontal wheel).
        const visibleCount = Math.floor((dimensions.width - PRICE_AXIS_WIDTH) / candleSpacing);
        const maxStartIndex = candles.length - Math.floor(visibleCount * 0.85);
        const newStartIndex = Math.max(
          0,
          Math.min(maxStartIndex, currentStartIndex + indexDelta)
        );
        scrollStateRef.current = { startIndex: newStartIndex, candleWidth: currentCandleWidth };

        if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current);
        scrollDebounceRef.current = setTimeout(() => {
          // In replay: only mark as user-scrolled if latest candle is off-screen.
          // If user scrolled back to the right edge, reset flag to resume auto-follow.
          if (disableAutoFollow) {
            const cw = dimensions.width - PRICE_AXIS_WIDTH;
            const cs = scrollStateRef.current.candleWidth * (1 + CANDLE_GAP_RATIO);
            const vc = Math.floor(cw / cs);
            const ei = scrollStateRef.current.startIndex + vc;
            replayUserScrolledRef.current = !((candles.length - 1) < ei);
          }
          const finalState = scrollStateRef.current;
          setViewState(prev => ({
            ...prev,
            startIndex: finalState.startIndex,
            autoFollowLatest: false,
          }));
          setScrolling(false);
        }, 150);

        if (wheelRAFRef.current === null) {
          wheelRAFRef.current = requestAnimationFrame(() => {
            if (drawChartRef.current) drawChartRef.current(true);
            drawCrosshair();
            notifyScrollSync();
            wheelRAFRef.current = null;
          });
        }
        return;
      }

      // Pure vertical scroll on Windows -> fall through to zoom logic below
      // This matches Mac behavior: vertical trackpad swipe = chart zoom
    }

    e.preventDefault();

    // Mark as scrolling to use refs instead of state
    setScrolling(true);

    const canvas = overlayCanvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Update crosshair position to follow cursor during zoom
    crosshairRef.current = { x: mouseX, y: mouseY };

    // Get current values from scroll ref
    const currentStartIndex = scrollStateRef.current.startIndex;
    const currentCandleWidth = scrollStateRef.current.candleWidth;
    const candleSpacing = currentCandleWidth * (1 + CANDLE_GAP_RATIO);

    // Horizontal scroll (trackpad gesture or shift+scroll) - pan left/right (no animation needed)
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      const scrollAmount = e.shiftKey ? e.deltaY : e.deltaX;

      // MacBook trackpads have much higher deltaX values, so reduce sensitivity significantly
      // scrollSensitivity ranges from 1-10, map to 0.05-0.5 for Mac, 0.2-2.0 for others
      const baseSensitivity = isMacRef.current
        ? 0.02 + (scrollSensitivity - 1) * 0.02  // Mac: 0.02 to 0.2
        : 0.2 + (scrollSensitivity - 1) * 0.2;   // Others: 0.2 to 2.0

      const indexDelta = (scrollAmount * baseSensitivity) / candleSpacing;

      // Clamp scroll so at least 85% of the viewport is filled (Mac trackpad).
      const visibleCount = Math.floor((dimensions.width - PRICE_AXIS_WIDTH) / candleSpacing);
      const maxStartIndex = candles.length - Math.floor(visibleCount * 0.85);
      const newStartIndex = Math.max(
        0,
        Math.min(maxStartIndex, currentStartIndex + indexDelta)
      );

      scrollStateRef.current = { startIndex: newStartIndex, candleWidth: currentCandleWidth };

      // Immediate redraw for panning
      if (wheelRAFRef.current === null) {
        wheelRAFRef.current = requestAnimationFrame(() => {
          if (drawChartRef.current) {
            drawChartRef.current(true);
          }
          drawCrosshair();
          // Notify drawing overlay to re-render with new scroll position
          notifyScrollSync();
          wheelRAFRef.current = null;
        });
      }

      // Debounce state sync for panning - use floor to prevent forward snap
      if (scrollDebounceRef.current) {
        clearTimeout(scrollDebounceRef.current);
      }
      scrollDebounceRef.current = setTimeout(() => {
        // In replay: only mark as user-scrolled if latest candle is off-screen.
        // If user scrolled back to the right edge, reset flag to resume auto-follow.
        if (disableAutoFollow) {
          const cw = dimensions.width - PRICE_AXIS_WIDTH;
          const cs = scrollStateRef.current.candleWidth * (1 + CANDLE_GAP_RATIO);
          const vc = Math.floor(cw / cs);
          const ei = scrollStateRef.current.startIndex + vc;
          replayUserScrolledRef.current = !((candles.length - 1) < ei);
        }
        const finalState = scrollStateRef.current;
        setViewState(prev => ({
          ...prev,
          startIndex: finalState.startIndex, // Keep float precision - no rounding
          autoFollowLatest: false,
        }));
        setScrolling(false);
      }, 150);

      return;
    }

    // Vertical scroll - discrete zoom levels (TradingView-style: instant snap, right edge fixed)
    // For Mac trackpads, accumulate small deltas and only zoom when threshold is reached
    if (isMacRef.current) {
      // Accumulate the delta
      macZoomAccumulatorRef.current += e.deltaY;

      // Reset accumulator after a pause in scrolling
      if (macZoomResetRef.current) {
        clearTimeout(macZoomResetRef.current);
      }
      macZoomResetRef.current = setTimeout(() => {
        macZoomAccumulatorRef.current = 0;
      }, 200);

      // Only trigger zoom when accumulated delta exceeds threshold
      // scrollSensitivity 1-10 maps to threshold 200-20 (lower sensitivity = higher threshold)
      const zoomThreshold = 220 - (scrollSensitivity * 20);
      if (Math.abs(macZoomAccumulatorRef.current) < zoomThreshold) {
        return;
      }

      // Reset accumulator after triggering zoom
      const zoomIn = macZoomAccumulatorRef.current < 0;
      macZoomAccumulatorRef.current = 0;

      const newCandleWidth = getNextZoomLevel(currentCandleWidth, zoomIn);
      if (newCandleWidth === currentCandleWidth) return;

      // TradingView-style: Keep RIGHT edge fixed. Use dynamic PRICE_AXIS_WIDTH
      // so zoom calculations match the actual chart drawing area.
      const chartWidth = dimensions.width - PRICE_AXIS_WIDTH;
      const currentSpacing = currentCandleWidth * (1 + CANDLE_GAP_RATIO);
      const newSpacing = newCandleWidth * (1 + CANDLE_GAP_RATIO);
      const currentRightIndex = currentStartIndex + (chartWidth / currentSpacing);
      const newStartIndex = Math.max(0, currentRightIndex - (chartWidth / newSpacing));

      setScrolling(true);
      scrollStateRef.current = { startIndex: newStartIndex, candleWidth: newCandleWidth };

      if (wheelRAFRef.current === null) {
        wheelRAFRef.current = requestAnimationFrame(() => {
          if (drawChartRef.current) drawChartRef.current(true);
          drawCrosshair();
          notifyScrollSync();
          wheelRAFRef.current = null;
        });
      }

      if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current);
      scrollDebounceRef.current = setTimeout(() => {
        const finalState = scrollStateRef.current;
        setViewState(prev => ({
          ...prev,
          candleWidth: finalState.candleWidth,
          startIndex: finalState.startIndex, // Keep float precision
          autoFollowLatest: false,
        }));
        setScrolling(false);
      }, 100);
      return;
    }

    // Non-Mac: immediate zoom on any vertical scroll
    const zoomIn = e.deltaY < 0;
    const newCandleWidth = getNextZoomLevel(currentCandleWidth, zoomIn);

    // Skip if already at min/max
    if (newCandleWidth === currentCandleWidth) return;

    // TradingView-style: Keep RIGHT edge fixed, only left side expands/contracts.
    // Use dynamic PRICE_AXIS_WIDTH so zoom matches actual chart drawing area.
    const chartWidth = dimensions.width - PRICE_AXIS_WIDTH;
    const currentSpacing = currentCandleWidth * (1 + CANDLE_GAP_RATIO);
    const newSpacing = newCandleWidth * (1 + CANDLE_GAP_RATIO);

    // Calculate visible candles and maintain right edge position
    const currentRightIndex = currentStartIndex + (chartWidth / currentSpacing);
    const newStartIndex = Math.max(0, currentRightIndex - (chartWidth / newSpacing));

    // CRITICAL: Mark as scrolling BEFORE updating ref so converter uses ref values
    setScrolling(true);

    // Update scroll ref and redraw immediately (no animation = no jitter)
    scrollStateRef.current = { startIndex: newStartIndex, candleWidth: newCandleWidth };

    // Immediate redraw with sync notification in same RAF for consistency
    if (wheelRAFRef.current === null) {
      wheelRAFRef.current = requestAnimationFrame(() => {
        if (drawChartRef.current) {
          drawChartRef.current(true);
        }
        drawCrosshair();
        // Notify drawing overlay to re-render with new scroll position
        notifyScrollSync();
        wheelRAFRef.current = null;
      });
    }

    // Debounce state sync
    if (scrollDebounceRef.current) {
      clearTimeout(scrollDebounceRef.current);
    }
    scrollDebounceRef.current = setTimeout(() => {
      const finalState = scrollStateRef.current;
      setViewState(prev => ({
        ...prev,
        candleWidth: finalState.candleWidth,
        startIndex: finalState.startIndex, // Keep float precision
        autoFollowLatest: false,
      }));
      setScrolling(false);
    }, 100);
  }, [candles.length, drawCrosshair, getNextZoomLevel, dimensions.width, dimensions.height, scrollSensitivity, fixedPriceCenter, getVisibleCandles, livePrice, getPriceRange, viewState.autoFollowLatest, notifyScrollSync]);

  // Store wheel handlers in refs for non-passive event listener attachment
  const handleWheelRef = useRef(handleWheel);
  const handleYAxisWheelRef = useRef(handleYAxisWheel);
  useEffect(() => {
    handleWheelRef.current = handleWheel;
  }, [handleWheel]);
  useEffect(() => {
    handleYAxisWheelRef.current = handleYAxisWheel;
  }, [handleYAxisWheel]);

  // Y-axis div ref for wheel listener
  const yAxisRef = useRef<HTMLDivElement>(null);

  // Attach non-passive wheel listeners to prevent "Unable to preventDefault" warnings
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    const yAxisDiv = yAxisRef.current;

    // Wrapper that calls the current handler ref
    const wheelHandler = (e: WheelEvent) => {
      handleWheelRef.current(e as unknown as React.WheelEvent<HTMLCanvasElement>);
    };
    const yAxisWheelHandler = (e: WheelEvent) => {
      handleYAxisWheelRef.current(e as unknown as React.WheelEvent<HTMLDivElement>);
    };

    if (canvas) {
      canvas.addEventListener('wheel', wheelHandler, { passive: false });
    }
    if (yAxisDiv) {
      yAxisDiv.addEventListener('wheel', yAxisWheelHandler, { passive: false });
    }

    return () => {
      if (canvas) {
        canvas.removeEventListener('wheel', wheelHandler);
      }
      if (yAxisDiv) {
        yAxisDiv.removeEventListener('wheel', yAxisWheelHandler);
      }
    };
  }, []);

  // useLayoutEffect (not useEffect) so dimensions are measured BEFORE the browser
  // paints. With useEffect, the first paint uses the 300x300 fallback dimensions,
  // causing a visible ~0.5s flash of a tiny chart before ResizeObserver updates
  // to the real container size. useLayoutEffect runs after DOM commit but before
  // paint, so getBoundingClientRect reads real dimensions and the first visible
  // frame already has the correct size.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Read real container size synchronously before paint
    const rect = container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setDimensions({ width: rect.width, height: rect.height });
    }

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setDimensions({ width, height });
        }
      }
    });

    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, []);

  // Apply external dimensions when provided (bypasses internal ResizeObserver)
  useEffect(() => {
    if (externalDimensions && externalDimensions.width > 0 && externalDimensions.height > 0) {
      setDimensions(externalDimensions);
    }
  }, [externalDimensions]);

  // useLayoutEffect (not useEffect) so startIndex is calculated BEFORE the browser
  // paints. With useEffect, the first frame renders at startIndex=0 (oldest candles),
  // then the effect fires and jumps to the latest candles, causing a visible ghost
  // flash of ~50ms showing the wrong part of the chart.
  useLayoutEffect(() => {
    if (candles.length === 0) return;
    if (disableAutoFollow) {
      // In replay mode: auto-scroll whenever candle count changes (play/step/batch/TF switch)
      const prevLength = prevCandlesLengthRef.current;
      const chartWidth = dimensions.width - PRICE_AXIS_WIDTH;

      // Latch a timeframe switch from the prop so the refit fires in BOTH
      // directions (a hop to a finer timeframe grows the candle array and would
      // never look like a "shrink").
      if (timeframe !== prevReplayTfRef.current) {
        prevReplayTfRef.current = timeframe;
        pendingTfRefitRef.current = true;
      }

      // Detect if this is the first time we have real dimensions (not the 300px default)
      const prevWidth = prevDimensionWidthRef.current;
      const dimensionsJustBecameReal = prevWidth <= 300 && dimensions.width > 300;
      prevDimensionWidthRef.current = dimensions.width;

      // Scroll when candle count changes (grows during play, or shrinks/changes on TF switch)
      // Also scroll when dimensions become real for the first time (fixes initial positioning)
      if (candles.length !== prevLength || prevLength === 0 || dimensionsJustBecameReal || pendingTfRefitRef.current) {
        // A real timeframe switch is detected ONLY by the prop latch. The
        // old "length shrank" heuristic predates the latch and misfired on
        // eviction: when forward replay pages push the raw window over its
        // cap, old bars are dropped and the aggregated array legitimately
        // shrinks, which recentered the view onto the newest bar AND
        // re-armed auto-follow, yanking a user who had panned back into
        // history straight back to the current price.
        const isTfSwitch = pendingTfRefitRef.current;
        const isRefit = prevLength === 0 || isTfSwitch || dimensionsJustBecameReal;

        // On a refit, resize the bars so the loaded series fills the viewport
        // rather than keeping the previous timeframe's width. A sparse
        // timeframe (few daily/weekly bars) kept at a fine timeframe's narrow
        // width crushed into the left edge with an empty grid to the right;
        // a rich timeframe kept at a coarse width showed only a handful of
        // bars. Target a comfortable count, but never wider than the series
        // itself needs, and clamp to sane on-screen sizes.
        const TARGET_VISIBLE = 120;
        let width = viewState.candleWidth;
        if (isRefit) {
          const shownBars = Math.max(1, Math.min(candles.length, TARGET_VISIBLE));
          const desired = (chartWidth * 0.9) / shownBars / (1 + CANDLE_GAP_RATIO);
          width = Math.min(40, Math.max(2, desired));
        }
        const candleSpacing = width * (1 + CANDLE_GAP_RATIO);
        const visibleCount = Math.floor(chartWidth / candleSpacing);
        const targetPosition = Math.floor(visibleCount * 0.9);

        // Check if the latest candle is currently visible on screen. Read the
        // LIVE position while a drag/wheel is in flight: mid-gesture the real
        // startIndex lives in scrollStateRef and viewState is stale at the
        // pre-gesture value, so the old viewState read judged "latest still
        // visible" while the user was already far back in history.
        const liveStartIndex = isScrollingRef.current
          ? scrollStateRef.current.startIndex : viewState.startIndex;
        const currentStart = Math.max(0, Math.floor(liveStartIndex));
        const currentEnd = Math.min(candles.length, currentStart + visibleCount);
        // "Was the user at the right edge?" must be judged against the array
        // as it was BEFORE this batch of bars arrived. Judging against the
        // new array meant a large append (the 30k-bar forward preload that
        // fires at session start) instantly put the newest bar thousands of
        // bars off-screen, the gate said "not at the edge", the follow never
        // ran, and the view stayed stranded months back while the replay
        // played on unseen.
        const prevEdgeLen = prevLength > 0 ? prevLength : candles.length;
        const latestCandleVisible = (prevEdgeLen - 1) < currentEnd;

        // Auto-scroll when: initial load, TF switch, dimensions just loaded,
        // or the latest candle is still visible AND user hasn't manually panned away.
        // Without the replayUserScrolledRef check, every new candle during replay
        // would force-scroll the chart back to the right edge, making it impossible
        // for the user to look at older candles while playback is running.
        // Never while a pan/wheel gesture is active (isScrollingRef): the flag
        // that records "user panned away" is only written on gesture END, so a
        // bar landing mid-drag used to yank the view back to the newest bar,
        // fighting the user's pull toward history.
        // Bars APPENDED at the right (the replay feed) move the last bar's
        // time forward; bars PREPENDED by scrollback loading do not. The
        // follow must only advance for appends: the prepend layout-effect
        // already shifts the view for prepends, and advancing here too
        // double-counted every scrollback page and dragged the view forward.
        const lastTs = (candles[candles.length - 1] as any)?.timestamp
          ?? (candles[candles.length - 1] as any)?.time;
        const prevLastTs = prevReplayLastTsRef.current;
        const lastAdvanced = prevLastTs !== null && lastTs !== prevLastTs;
        prevReplayLastTsRef.current = lastTs;
        // Count appends by TIMESTAMP (bars strictly newer than the previous
        // last bar). Everything else in the length delta happened at the
        // FRONT: prepends from scrollback (positive) or evictions
        // (negative). netFront is EXACT by construction, which the old
        // cross-component "prepend shift" ledger was not: its local-midnight
        // bucket keying overcounted stock sessions that cross midnight in
        // the server timezone, so every landed history page nudged the view
        // a couple of bars forward while the user was swiping back.
        let appended = 0;
        if (prevLastTs !== null) {
          const prevMs = new Date(prevLastTs as any).getTime();
          for (let i = candles.length - 1; i >= 0 && appended < 100000; i--) {
            const cts = (candles[i] as any).timestamp ?? (candles[i] as any).time;
            if (new Date(cts).getTime() > prevMs) appended++;
            else break;
          }
        }
        // Front-compensated position: the same candles stay on screen after
        // a prepend or eviction. Anchored by TIMESTAMP against the retained
        // previous array, not by length arithmetic: partial-bucket evictions
        // change the front bucket's contents without changing the count, so
        // "length minus appends" was off by up to a bar per eviction and the
        // parked view slowly drifted. The anchor bar is looked up in the new
        // array by binary search; if it was itself evicted, the view pins to
        // the oldest bar still loaded.
        let base = Math.max(0, liveStartIndex);
        const prevArr = prevReplayCandlesRef.current;
        if (!isRefit && prevArr && prevArr.length > 0) {
          const anchorIdx = Math.max(0, Math.min(Math.floor(liveStartIndex), prevArr.length - 1));
          const a = prevArr[anchorIdx] as any;
          const anchorMs = new Date(a.timestamp ?? a.time).getTime();
          let lo = 0, hi = candles.length - 1, found = 0;
          while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            const c = candles[mid] as any;
            const ms = new Date(c.timestamp ?? c.time).getTime();
            if (ms < anchorMs) { lo = mid + 1; found = lo; }
            else { hi = mid - 1; found = mid; }
          }
          base = Math.max(0, found + (liveStartIndex - Math.floor(liveStartIndex)));
        }
        const netFront = Math.round(base - Math.max(0, liveStartIndex));
        prevReplayCandlesRef.current = candles;
        if (isRefit || (!isScrollingRef.current && latestCandleVisible && !replayUserScrolledRef.current && lastAdvanced)) {
          // Refit recenters (latest at ~90%). A plain follow instead ADVANCES
          // only as far as needed to keep the newest bar on screen: with the
          // window full that is exactly `appended`; when the user has panned
          // back and the bars end mid-screen, new bars paint into the empty
          // right side without moving the view at all.
          const overflowRight = Math.max(0, candles.length - Math.floor(base) - visibleCount);
          const followBy = Math.min(appended, overflowRight);
          const newStartIndex = isRefit
            ? Math.max(0, candles.length - 1 - targetPosition)
            : base + followBy;
          setViewState(prev => ({ ...prev, candleWidth: width, startIndex: newStartIndex, autoFollowLatest: false }));
          // Sync the scroll ref so the next gesture starts from this position
          // instead of a stale pre-follow index.
          scrollStateRef.current = { startIndex: newStartIndex, candleWidth: width };
          // A held-but-paused drag (the 100ms idle commit drops isScrolling
          // while the button is still down) computes its position from the
          // mousedown anchor, so the anchor must move with the array too or
          // the next movement snaps back by everything that landed during
          // the pause.
          if (!isRefit && isDragging && (netFront !== 0 || followBy > 0)) {
            setDragStart(prev => ({ ...prev, startIndex: prev.startIndex + netFront + followBy }));
          }
          // Reset user-scrolled flag on TF switch so play auto-follows again
          if (isTfSwitch) replayUserScrolledRef.current = false;
        } else if (netFront !== 0) {
          // No follow (user panned away, or a gesture is active), but the
          // array still moved under the view: compensate so the same candles
          // stay on screen.
          setViewState(prev => ({ ...prev, startIndex: Math.max(0, prev.startIndex + netFront) }));
          scrollStateRef.current.startIndex = Math.max(0, scrollStateRef.current.startIndex + netFront);
          if (isDragging) {
            setDragStart(prev => ({ ...prev, startIndex: prev.startIndex + netFront }));
          }
        }
        // The refit for this switch has been applied (or was unnecessary
        // because the user had panned away); clear the latch either way.
        if (isRefit) pendingTfRefitRef.current = false;
      }
      prevCandlesLengthRef.current = candles.length;
      return;
    }
    if (!viewState.autoFollowLatest) return;

    const chartWidth = dimensions.width - PRICE_AXIS_WIDTH;
    const candleSpacing = viewState.candleWidth * (1 + CANDLE_GAP_RATIO);
    const visibleCount = Math.floor(chartWidth / candleSpacing);

    // Calculate start index to show latest candles with small right margin
    // We want most recent candles visible, with a small buffer on the right
    const rightBuffer = Math.min(viewState.futureSpace, Math.floor(visibleCount * 0.3));
    const startIndex = Math.max(0, candles.length - visibleCount + rightBuffer);

    setViewState(prev => ({ ...prev, startIndex }));
    prevCandlesLengthRef.current = candles.length;
  }, [candles.length, dimensions.width, viewState.autoFollowLatest, viewState.candleWidth, viewState.futureSpace, disableAutoFollow, timeframe]);

  // INFINITE SCROLLBACK: When prependShift increases, the parent has prepended older candles.
  // Shift viewState.startIndex by the delta so the user's visible view stays on the same
  // candles (no visual jump). Uses useLayoutEffect instead of useEffect so the shift
  // happens BEFORE the browser paints, eliminating the ghost frame where the user would
  // briefly see the wrong candles before the view corrects itself.
  useLayoutEffect(() => {
    // View compensation for prepends/evictions no longer lives here: the
    // replay follow effect derives the exact front delta from the candle
    // array itself (netFront), because this ledger's bucket-count deltas
    // proved inexact (local-midnight keying overcounts midnight-crossing
    // stock sessions) and shifting by them crept the view forward on every
    // landed history page. The prop still feeds the grid-anchor offsets in
    // the draw code; only the ref bookkeeping remains here.
    prevPrependShiftRef.current = prependShift;
  }, [prependShift]);

  // Scroll to specific index when requested (for replay mode)
  useEffect(() => {
    if (scrollToIndex === undefined || scrollToIndex === null) {
      lastScrolledIndexRef.current = undefined;
      return;
    }
    if (candles.length === 0) return;

    // Only scroll if this is a NEW scroll request (not just a dependency change)
    if (lastScrolledIndexRef.current === scrollToIndex) return;
    lastScrolledIndexRef.current = scrollToIndex;

    const chartWidth = dimensions.width - PRICE_AXIS_WIDTH;
    const candleSpacing = viewState.candleWidth * (1 + CANDLE_GAP_RATIO);
    const visibleCount = Math.floor(chartWidth / candleSpacing);

    // Clamp scrollToIndex to valid range
    const clampedIndex = Math.min(scrollToIndex, candles.length - 1);

    // Position so the target candle is near the right edge (90% across the visible area)
    // This ensures the "current" replay position is visible at the right
    const targetPosition = Math.floor(visibleCount * 0.9);
    const newStartIndex = Math.max(0, clampedIndex - targetPosition);
    setViewState(prev => ({ ...prev, startIndex: newStartIndex, autoFollowLatest: false }));
  }, [scrollToIndex, candles.length, dimensions.width, viewState.candleWidth]);

  useEffect(() => {
    // Skip during active scroll: the scroll RAF (wheelRAFRef) already calls
    // drawChartRef.current(true) every frame. Firing drawChart() here on top of
    // that is redundant and blocks the main thread (especially when history
    // prepends trigger a new drawChart identity with recomputed indicators).
    if (!isScrollingRef.current && !isDrawingDragging) {
      drawChart();
    }
  }, [drawChart, isDrawingDragging]);

  // Throttle live price redraws to avoid performance issues with drawing overlays
  const lastLivePriceRedrawRef = useRef<number>(0);
  const livePriceRedrawTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (livePrice === null || livePrice === undefined) return;

    // Throttle redraws to max once every 50ms (20 FPS) to prevent lag with drawing tools
    // while keeping the chart looking completely real-time for live tick data
    const now = Date.now();
    const timeSinceLastRedraw = now - lastLivePriceRedrawRef.current;

    if (timeSinceLastRedraw >= 50) {
      lastLivePriceRedrawRef.current = now;
      drawChart();
    } else {
      // Schedule a redraw for later if we're throttling
      if (livePriceRedrawTimeoutRef.current) {
        clearTimeout(livePriceRedrawTimeoutRef.current);
      }
      livePriceRedrawTimeoutRef.current = setTimeout(() => {
        lastLivePriceRedrawRef.current = Date.now();
        drawChart();
      }, 50 - timeSinceLastRedraw);
    }

    return () => {
      if (livePriceRedrawTimeoutRef.current) {
        clearTimeout(livePriceRedrawTimeoutRef.current);
      }
    };
  }, [livePrice, drawChart]);

  useEffect(() => {
    drawCrosshair();
  }, [drawCrosshair]);

  // Trigger crosshair redraw when syncedCrosshairTime changes from another panel
  useEffect(() => {
    syncedCrosshairTimeRef.current = syncedCrosshairTime;
    if (syncedCrosshairTime !== undefined && syncedCrosshairTime !== null) {
      isSyncedUpdateRef.current = true;
      // Force a redraw of the overlay canvas using requestAnimationFrame
      requestAnimationFrame(() => {
        drawCrosshair();
        isSyncedUpdateRef.current = false;
      });
    }
  }, [syncedCrosshairTime, drawCrosshair]);

  // Note: Pulse animation is already handled in the useEffect at line ~122

  // Build a time->index lookup Map for O(1) lookups (instead of O(n) findIndex per call).
  // Cached in a ref so we can defer rebuilding during active scroll (history prepends
  // change the candles array, triggering this useMemo, but building a 100K-entry Map
  // on the main thread blocks the scroll RAF).
  const timeToIndexMapCacheRef = useRef<Map<number, number>>(new Map());
  const timeToIndexMap = useMemo(() => {
    // Defer during active scroll: the converter uses binary search as fallback
    // when a timestamp isn't in the map, so stale map entries cause minimal impact.
    // The map will be rebuilt when scrolling stops. 
    // CRITICAL: We pass deferral ONLY if candles array length is identical (e.g. 
    // live tick replacing last candle). If it's a historical prepend, indices shift 
    // entirely so we MUST rebuild immediately to prevent ghost jumps on SVG drawings.
    if (isScrollingRef.current && timeToIndexMapCacheRef.current.size > 0 && candles.length === timeToIndexMapCacheRef.current.size) {
      return timeToIndexMapCacheRef.current;
    }
    const map = new Map<number, number>();
    for (let i = 0; i < candles.length; i++) {
      map.set(candles[i].time, i);
    }
    timeToIndexMapCacheRef.current = map;
    return map;
  }, [candles]);


  // Create converter function - stored in ref so it can be called during scroll
  const createAndEmitConverter = useCallback(() => {
    if (!onConverterReady) return;

    const visible = getVisibleCandles();
    const priceRange = getPriceRange(visible.candles, viewState.autoFollowLatest);

    // Calculate time interval between candles (for future time extrapolation)
    const lastCandle = candles.length > 0 ? candles[candles.length - 1] : null;
    const secondLastCandle = candles.length >= 2 ? candles[candles.length - 2] : null;
    const timeInterval = lastCandle && secondLastCandle
      ? lastCandle.time - secondLastCandle.time
      : 60000; // Default to 1 minute

    onConverterReady({
      priceAxisWidth: PRICE_AXIS_WIDTH,
      timeToX: (time: number) => {
        // Use the same scroll source as the canvas to prevent micro-jitter:
        // during active scroll -> scrollStateRef (real-time, sub-pixel)
        // after scroll settles -> viewState (React state, debounced)
        // Without this match, drawings and candles render at slightly
        // different positions during the transition between the two sources.
        const rawStartIndex = isScrollingRef.current
          ? scrollStateRef.current.startIndex
          : viewState.startIndex;
        const currentCandleWidth = isScrollingRef.current
          ? scrollStateRef.current.candleWidth
          : viewState.candleWidth;
        const currentCandleSpacing = currentCandleWidth * (1 + CANDLE_GAP_RATIO);

        // For smooth scrolling: chart uses floored startIndex + fractional offset
        // Formula: (index - flooredStartIndex) * spacing + spacing/2 - fractionalOffset
        const flooredStartIndex = Math.floor(rawStartIndex);
        const fractionalOffset = (rawStartIndex - flooredStartIndex) * currentCandleSpacing;

        // O(1) lookup instead of O(n) findIndex
        let index = timeToIndexMap.get(time) ?? -1;

        // If not found, interpolate position based on time
        if (index === -1 && candles.length > 0) {
          const firstCandle = candles[0];
          const lastCandleData = candles[candles.length - 1];

          if (time > lastCandleData.time) {
            // Future time - extrapolate beyond chart
            const timeDiff = time - lastCandleData.time;
            const extrapolatedIndex = candles.length - 1 + Math.round(timeDiff / timeInterval);
            index = extrapolatedIndex;
          } else if (time < firstCandle.time) {
            // Time is before first candle - extrapolate backwards
            const timeDiff = firstCandle.time - time;
            const extrapolatedIndex = -Math.round(timeDiff / timeInterval);
            index = extrapolatedIndex;
          } else {
            // Time is within range - find closest candle using binary search
            let left = 0;
            let right = candles.length - 1;
            while (left < right) {
              const mid = Math.floor((left + right) / 2);
              if (candles[mid].time < time) {
                left = mid + 1;
              } else {
                right = mid;
              }
            }
            // Interpolate between candles for smoother positioning
            if (left > 0) {
              const prevCandle = candles[left - 1];
              const nextCandle = candles[left];
              const ratio = (time - prevCandle.time) / (nextCandle.time - prevCandle.time);
              const interpolatedIndex = (left - 1) + ratio;
              // Match chart's smooth scroll formula with fractional offset
              return (interpolatedIndex - flooredStartIndex) * currentCandleSpacing + currentCandleSpacing / 2 - fractionalOffset;
            }
            index = left;
          }
        }

        if (index === -1) return null;
        // Match chart's smooth scroll formula with fractional offset
        return (index - flooredStartIndex) * currentCandleSpacing + currentCandleSpacing / 2 - fractionalOffset;
      },
      xToTime: (x: number) => {
        // Match the same scroll source as timeToX and the canvas renderer
        const rawStartIndex = isScrollingRef.current
          ? scrollStateRef.current.startIndex
          : viewState.startIndex;
        const currentCandleWidth = isScrollingRef.current
          ? scrollStateRef.current.candleWidth
          : viewState.candleWidth;
        const currentCandleSpacing = currentCandleWidth * (1 + CANDLE_GAP_RATIO);

        // Match the smooth scroll formula with fractional offset
        const flooredStartIndex = Math.floor(rawStartIndex);
        const fractionalOffset = (rawStartIndex - flooredStartIndex) * currentCandleSpacing;

        // Calculate PRECISE fractional index (not floored) for sub-candle accuracy
        // This is critical for brush drawings to stay exactly where placed
        // Inverse of timeToX: x = (index - flooredStartIndex) * spacing + spacing/2 - fractionalOffset
        // So: index = flooredStartIndex + (x + fractionalOffset - spacing/2) / spacing
        const adjustedX = x + fractionalOffset;
        const preciseIndex = flooredStartIndex + (adjustedX - currentCandleSpacing / 2) / currentCandleSpacing;

        if (preciseIndex < 0) return null;

        // Interpolate time based on fractional index position
        // This ensures brush drawings maintain exact pixel position when converted back
        const baseIndex = Math.floor(preciseIndex);
        const fraction = preciseIndex - baseIndex;

        if (baseIndex >= candles.length) {
          // Future time - extrapolate beyond chart
          if (lastCandle) {
            const futureOffset = preciseIndex - (candles.length - 1);
            return lastCandle.time + (futureOffset * timeInterval);
          }
          return null;
        }

        const baseCandle = candles[baseIndex];
        if (!baseCandle) return null;

        // For positions within candle range, interpolate between candles
        if (fraction > 0 && baseIndex + 1 < candles.length) {
          const nextCandle = candles[baseIndex + 1];
          return baseCandle.time + fraction * (nextCandle.time - baseCandle.time);
        }

        // At exact candle boundary or last candle - return candle time + fractional offset
        return baseCandle.time + fraction * timeInterval;
      },
      priceToY: (price: number) => {
        // CRITICAL: Use the EXACT price range from the most recent chart render frame
        // This ensures drawings stay perfectly synchronized with the chart during scroll
        // Previously this recalculated the price range independently, causing drift
        let currentPriceRange = renderedPriceRangeRef.current;
        let mainChartHeight = mainChartHeightRef.current;

        // Fallback if ref not yet populated (shouldn't happen in normal use)
        if (!currentPriceRange || mainChartHeight === 0) {
          const chartWidth = dimensions.width - PRICE_AXIS_WIDTH;
          const currentState = scrollStateRef.current;
          const candleSpacing = currentState.candleWidth * (1 + CANDLE_GAP_RATIO);
          const visibleCount = Math.floor(chartWidth / candleSpacing);
          const start = Math.max(0, Math.floor(currentState.startIndex));
          const end = Math.min(candles.length, start + visibleCount);
          const visibleCandles = candles.slice(start, end);

          let priceMin = Infinity;
          let priceMax = -Infinity;

          if (visibleCandles.length === 0) {
            priceMin = 0;
            priceMax = 100;
          } else {
            for (const c of visibleCandles) {
              if (c.low < priceMin) priceMin = c.low;
              if (c.high > priceMax) priceMax = c.high;
            }
            if (livePrice) {
              if (livePrice < priceMin) priceMin = livePrice;
              if (livePrice > priceMax) priceMax = livePrice;
            }
          }

          const priceRangeValue = priceMax - priceMin;
          const padding = priceRangeValue * 0.05;
          const midpoint = (priceMax + priceMin) / 2;
          const paddedRange = priceRangeValue + padding * 2;
          currentPriceRange = {
            min: midpoint - paddedRange / 2,
            max: midpoint + paddedRange / 2,
            range: paddedRange,
          };

          // Calculate main chart height for fallback
          const hasRSI = indicators?.rsi?.enabled;
          const hasMACD = indicators?.macd?.enabled;
          const hasATR = indicators?.atr?.enabled;
          const hasStochastic = indicators?.stochastic?.enabled;
          const hasVolume = indicators?.volume?.enabled && candles.some(c => c.volume !== undefined && c.volume > 0);
          const numIndicators = (hasRSI ? 1 : 0) + (hasMACD ? 1 : 0) + (hasATR ? 1 : 0) + (hasStochastic ? 1 : 0);
          const totalAvailableHeight = dimensions.height - TIME_AXIS_HEIGHT;
          const totalIndicatorPanelHeight = numIndicators > 0
            ? Math.max(60 * numIndicators, totalAvailableHeight * indicatorHeightRatio)
            : 0;
          mainChartHeight = totalAvailableHeight - totalIndicatorPanelHeight;
        }

        // Override with fixed price mode if active
        if (fixedPriceCenter !== null && fixedPriceRange !== null) {
          const currentScale = priceScaleRef.current;
          const currentOffset = priceOffsetRef.current;
          const scaledRange = fixedPriceRange / currentScale;
          const offsetCenter = fixedPriceCenter + currentOffset;
          currentPriceRange = {
            min: offsetCenter - scaledRange / 2,
            max: offsetCenter + scaledRange / 2,
            range: scaledRange,
          };
        }

        return mainChartHeight - ((price - currentPriceRange.min) / currentPriceRange.range) * mainChartHeight;
      },
      yToPrice: (y: number) => {
        // CRITICAL: Use the EXACT price range from the most recent chart render frame
        // This ensures drawings stay perfectly synchronized with the chart during scroll
        let currentPriceRange = renderedPriceRangeRef.current;
        let mainChartHeight = mainChartHeightRef.current;

        // Fallback if ref not yet populated
        if (!currentPriceRange || mainChartHeight === 0) {
          const chartWidth = dimensions.width - PRICE_AXIS_WIDTH;
          const currentState = scrollStateRef.current;
          const candleSpacing = currentState.candleWidth * (1 + CANDLE_GAP_RATIO);
          const visibleCount = Math.floor(chartWidth / candleSpacing);
          const start = Math.max(0, Math.floor(currentState.startIndex));
          const end = Math.min(candles.length, start + visibleCount);
          const visibleCandles = candles.slice(start, end);

          let priceMin = Infinity;
          let priceMax = -Infinity;

          if (visibleCandles.length === 0) {
            priceMin = 0;
            priceMax = 100;
          } else {
            for (const c of visibleCandles) {
              if (c.low < priceMin) priceMin = c.low;
              if (c.high > priceMax) priceMax = c.high;
            }
            if (livePrice) {
              if (livePrice < priceMin) priceMin = livePrice;
              if (livePrice > priceMax) priceMax = livePrice;
            }
          }

          const priceRangeValue = priceMax - priceMin;
          const padding = priceRangeValue * 0.05;
          const midpoint = (priceMax + priceMin) / 2;
          const paddedRange = priceRangeValue + padding * 2;
          currentPriceRange = {
            min: midpoint - paddedRange / 2,
            max: midpoint + paddedRange / 2,
            range: paddedRange,
          };

          // Calculate main chart height for fallback
          const hasRSI = indicators?.rsi?.enabled;
          const hasMACD = indicators?.macd?.enabled;
          const hasATR = indicators?.atr?.enabled;
          const hasStochastic = indicators?.stochastic?.enabled;
          const hasVolume = indicators?.volume?.enabled && candles.some(c => c.volume !== undefined && c.volume > 0);
          const numIndicators = (hasRSI ? 1 : 0) + (hasMACD ? 1 : 0) + (hasATR ? 1 : 0) + (hasStochastic ? 1 : 0);
          const totalAvailableHeight = dimensions.height - TIME_AXIS_HEIGHT;
          const totalIndicatorPanelHeight = numIndicators > 0
            ? Math.max(60 * numIndicators, totalAvailableHeight * indicatorHeightRatio)
            : 0;
          mainChartHeight = totalAvailableHeight - totalIndicatorPanelHeight;
        }

        // Override with fixed price mode if active
        if (fixedPriceCenter !== null && fixedPriceRange !== null) {
          const currentScale = priceScaleRef.current;
          const currentOffset = priceOffsetRef.current;
          const scaledRange = fixedPriceRange / currentScale;
          const offsetCenter = fixedPriceCenter + currentOffset;
          currentPriceRange = {
            min: offsetCenter - scaledRange / 2,
            max: offsetCenter + scaledRange / 2,
            range: scaledRange,
          };
        }

        return currentPriceRange.max - (y / mainChartHeight) * currentPriceRange.range;
      },
    });
  }, [candles, viewState, dimensions, onConverterReady, indicators, indicatorHeightRatio, livePrice, fixedPriceCenter, fixedPriceRange, timeToIndexMap]);

  // Store in ref for access during scroll
  useEffect(() => {
    updateConverterRef.current = createAndEmitConverter;
  }, [createAndEmitConverter]);

  // Expose coordinate converter - called when deps change
  useEffect(() => {
    createAndEmitConverter();
  }, [createAndEmitConverter]);


  // Calculate resize handle position based on current layout
  // Must include ALL subplot indicators (not just the original 4)
  // Must match the subplot key list in drawChart and drawCrosshair exactly,
  // otherwise the resize handle position will be wrong for Phase 2 indicators.
  const numSubplotsForHandle = [
    indicatorData?.rsi, indicatorData?.macd, indicatorData?.atr, indicatorData?.stochastic,
    indicatorData?.williamsR, indicatorData?.cci, indicatorData?.adx, indicatorData?.roc,
    indicatorData?.aroon, indicatorData?.momentum, indicatorData?.ao, indicatorData?.mfi,
    indicatorData?.tsi, indicatorData?.trix, indicatorData?.ultimateOsc, indicatorData?.dpo,
    indicatorData?.kst, indicatorData?.stochRsi, indicatorData?.bbPercent, indicatorData?.bbWidth,
    indicatorData?.histVol, indicatorData?.chaikinVol, indicatorData?.stdDev,
    indicatorData?.obv, indicatorData?.cmf, indicatorData?.adl, indicatorData?.forceIndex,
    indicatorData?.eom, indicatorData?.correlation, indicatorData?.coppock,
    // Phase 2 subplots
    indicatorData?.vortex, indicatorData?.choppiness, indicatorData?.elderRay,
    indicatorData?.massIndex, indicatorData?.linRegSlope,
    indicatorData?.ppo, indicatorData?.pvo, indicatorData?.cmo, indicatorData?.fisher,
    indicatorData?.stc, indicatorData?.rviOsc, indicatorData?.klinger, indicatorData?.connorsRsi,
    indicatorData?.apo, indicatorData?.qstick, indicatorData?.bop, indicatorData?.psychLine,
    indicatorData?.pfe, indicatorData?.smi,
    indicatorData?.ulcerIndex, indicatorData?.natr, indicatorData?.trueRange,
    indicatorData?.squeeze, indicatorData?.relVolIndex, indicatorData?.vhf,
    indicatorData?.volumeOsc, indicatorData?.nvi, indicatorData?.pvi, indicatorData?.pvt,
    indicatorData?.vroc, indicatorData?.netVolume, indicatorData?.twiggsMF,
    indicatorData?.linRegRSquared, indicatorData?.gator,
  ].filter(Boolean).length
    + (indicatorData?.customIndicators?.filter((ci: any) => ci.display === 'subplot').length || 0);
  const hasIndicators = numSubplotsForHandle > 0;
  const availableHeight = dimensions.height - TIME_AXIS_HEIGHT;
  const totalIndicatorHeight = numSubplotsForHandle > 0
    ? Math.max(60 * numSubplotsForHandle, availableHeight * indicatorHeightRatio)
    : 0;
  const mainChartHeightForHandle = availableHeight - totalIndicatorHeight;

  // Resize handle handlers
  const handleResizeStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizingIndicator(true);
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    resizeStartRef.current = { y: clientY, ratio: indicatorHeightRatio };
  }, [indicatorHeightRatio]);

  useEffect(() => {
    if (!isResizingIndicator) return;

    const handleResizeMove = (e: MouseEvent | TouchEvent) => {
      const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
      const deltaY = resizeStartRef.current.y - clientY;
      const deltaRatio = deltaY / (dimensions.height - TIME_AXIS_HEIGHT);
      const newRatio = Math.max(0.1, Math.min(0.6, resizeStartRef.current.ratio + deltaRatio));
      setIndicatorHeightRatio(newRatio);
    };

    const handleResizeEnd = () => {
      setIsResizingIndicator(false);
    };

    window.addEventListener('mousemove', handleResizeMove);
    window.addEventListener('mouseup', handleResizeEnd);
    window.addEventListener('touchmove', handleResizeMove);
    window.addEventListener('touchend', handleResizeEnd);

    return () => {
      window.removeEventListener('mousemove', handleResizeMove);
      window.removeEventListener('mouseup', handleResizeEnd);
      window.removeEventListener('touchmove', handleResizeMove);
      window.removeEventListener('touchend', handleResizeEnd);
    };
  }, [isResizingIndicator, dimensions.height]);


  return (
    <div
      ref={containerRef}
      className="relative w-full h-full select-none"
      style={{
        backgroundColor: colors.background,
        WebkitTouchCallout: 'none',
        WebkitUserSelect: 'none',
        userSelect: 'none',
      }}
    >
      {/* CSS width/height use 100% instead of explicit pixels so the canvas
         always fills the container instantly when it resizes (e.g. watchlist
         opening). With explicit pixel dimensions, the canvas keeps the old
         size until ResizeObserver fires, causing the price axis to get clipped
         by overflow-hidden for one frame. 100% keeps it flush; the draw buffer
         (width/height attributes) catches up on the next ResizeObserver tick. */}
      <canvas
        ref={canvasRef}
        width={dimensions.width * dpr}
        height={dimensions.height * dpr}
        className="absolute inset-0 w-full h-full select-none"
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
        style={{
          willChange: 'contents',
        }}
      />
      <canvas
        ref={overlayCanvasRef}
        width={dimensions.width * dpr}
        height={dimensions.height * dpr}
        className="absolute inset-0 w-full h-full cursor-crosshair touch-none select-none"
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
        style={{
          WebkitTouchCallout: 'none',
          WebkitUserSelect: 'none',
          willChange: 'contents',
        }}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onContextMenu={(e) => {
          // TradingView-style: right-click on indicator line shows context menu
          if (!indicators || !indicatorData) return;
          const canvas = overlayCanvasRef.current;
          if (!canvas) return;
          const rect = canvas.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          const pr = renderedPriceRangeRef.current;
          const mch = mainChartHeightRef.current;
          if (!pr || mch <= 0) return;
          
          const currentState = scrollStateRef.current;
          const candleSpacing = currentState.candleWidth * (1 + CANDLE_GAP_RATIO);
          const startIdx = Math.max(0, Math.floor(currentState.startIndex));
          const clickCandleIdx = startIdx + Math.round(x / candleSpacing);
          const HIT_DISTANCE = 8;
          
          const isNearPrice = (price: number): boolean => {
            if (isNaN(price) || !isFinite(price)) return false;
            const lineY = mch - ((price - pr.min) / pr.range) * mch;
            return Math.abs(y - lineY) < HIT_DISTANCE;
          };

          // Map indicator key -> title for context menu
          const lineChecks: { key: string; title: string; check: () => boolean }[] = [];
          
          if (indicators.movingAverages?.enabled && indicatorData.movingAverages) {
            lineChecks.push({ key: 'movingAverages', title: 'Moving Averages', check: () => {
              return indicatorData.movingAverages!.some((ma: any) => 
                clickCandleIdx >= 0 && clickCandleIdx < ma.data.length && isNearPrice(ma.data[clickCandleIdx])
              );
            }});
          }
          if (indicators.bollinger?.enabled && indicatorData.bollinger) {
            const bb = indicatorData.bollinger;
            lineChecks.push({ key: 'bollinger', title: 'Bollinger Bands', check: () =>
              clickCandleIdx >= 0 && clickCandleIdx < bb.upper.length && 
              (isNearPrice(bb.upper[clickCandleIdx]) || isNearPrice(bb.middle[clickCandleIdx]) || isNearPrice(bb.lower[clickCandleIdx]))
            });
          }
          if (indicators.vwap?.enabled && indicatorData.vwap) {
            lineChecks.push({ key: 'vwap', title: 'VWAP', check: () =>
              clickCandleIdx >= 0 && clickCandleIdx < indicatorData.vwap!.length && isNearPrice(indicatorData.vwap![clickCandleIdx])
            });
          }
          if (indicators.supertrend?.enabled && indicatorData.supertrend) {
            lineChecks.push({ key: 'supertrend', title: 'Supertrend', check: () =>
              clickCandleIdx >= 0 && clickCandleIdx < (indicatorData.supertrend as any)!.length && (indicatorData.supertrend as any)![clickCandleIdx] && isNearPrice((indicatorData.supertrend as any)![clickCandleIdx].value)
            });
          }
          if (indicators.ichimoku?.enabled && indicatorData.ichimoku) {
            const ich = indicatorData.ichimoku;
            lineChecks.push({ key: 'ichimoku', title: 'Ichimoku Cloud', check: () =>
              clickCandleIdx >= 0 && clickCandleIdx < ich.tenkan.length &&
              (isNearPrice(ich.tenkan[clickCandleIdx]) || isNearPrice(ich.kijun[clickCandleIdx]) || isNearPrice(ich.senkouA[clickCandleIdx]) || isNearPrice(ich.senkouB[clickCandleIdx]))
            });
          }
          if (indicators.keltner?.enabled && indicatorData.keltner) {
            const kc = indicatorData.keltner;
            lineChecks.push({ key: 'keltner', title: 'Keltner Channel', check: () =>
              clickCandleIdx >= 0 && clickCandleIdx < kc.upper.length &&
              (isNearPrice(kc.upper[clickCandleIdx]) || isNearPrice(kc.middle[clickCandleIdx]) || isNearPrice(kc.lower[clickCandleIdx]))
            });
          }
          if (indicators.donchian?.enabled && indicatorData.donchian) {
            const dc = indicatorData.donchian;
            lineChecks.push({ key: 'donchian', title: 'Donchian Channel', check: () =>
              clickCandleIdx >= 0 && clickCandleIdx < dc.upper.length &&
              (isNearPrice(dc.upper[clickCandleIdx]) || isNearPrice(dc.middle[clickCandleIdx]) || isNearPrice(dc.lower[clickCandleIdx]))
            });
          }
          
          for (const lc of lineChecks) {
            if (lc.check()) {
              e.preventDefault();
              e.stopPropagation();
              setClickedIndicatorKey(lc.key);
              setIndicatorContextMenu({ visible: true, x: e.clientX, y: e.clientY, key: lc.key, title: lc.title });
              return;
            }
          }
        }}
      />
      {/* OHLC Toggle + Session Dot: single container so they share one position and don't flicker */}
      <div
        className="absolute z-40 flex items-center gap-1"
        style={{
          top: 3,
          left: showOHLC ? ((ohlcTextWidth || 295) + 6) : 6,
          pointerEvents: 'auto',
        }}
        onMouseEnter={() => { sessionControlHoveredRef.current = true; }}
        onMouseLeave={() => { sessionControlHoveredRef.current = false; }}
      >
        {/* OHLC Toggle chevron */}
        <button
          onClick={() => {
            const newValue = !showOHLC;
            setShowOHLC(newValue);
          }}
          className="flex items-center justify-center w-4 h-4 rounded transition-all duration-200"
          style={{ background: 'rgba(128, 128, 128, 0.3)' }}
          title={showOHLC ? "Hide OHLC" : "Show OHLC"}
        >
          {showOHLC ? (
            <svg viewBox="0 0 16 16" className="w-2.5 h-2.5" fill="none" stroke="#9ca3af" strokeWidth="3" strokeLinecap="round">
              <path d="M10 4L5 8L10 12" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" className="w-2.5 h-2.5" fill="none" stroke="#9ca3af" strokeWidth="3" strokeLinecap="round">
              <path d="M6 4L11 8L6 12" />
            </svg>
          )}
        </button>

        {/* Session Info Dot */}
        {showOHLC && symbol && (() => {
        const _now = new Date();
        void sessionTick; // consume tick to trigger re-render
        const _assetType = getAssetType(symbol);
        const _isOpen = isMarketOpenForPair(symbol);

        // Determine session hours: exchange-aware (mirrors ops/market_hours.py)
        let _sessionLabel = '';
        let _exchangeTz = '';
        let _openMinutes = 0;
        let _closeMinutes = 0;
        let _is24h = false;
        let _statusColor = _isOpen ? '#22c55e' : '#ef4444';
        let _statusText = _isOpen ? 'Market open' : 'Market closed';
        let _updateFreq = 'Real time';

        // UK time via Intl.DateTimeFormat (DST-aware)
        const _uk = getUKTime(_now);
        const _ukMinutes = _uk.hours * 60 + _uk.minutes;
        const _ukDay = _uk.day;
        const _isBST = _uk.isBST;
        const _ukTzLabel = _isBST ? 'BST (UTC+1)' : 'GMT (UTC+0)';
        const _ukHH = String(_uk.hours).padStart(2, '0');
        const _ukMM = String(_uk.minutes).padStart(2, '0');

        // Detect exchange from symbol suffix
        const _exchangeId = getExchangeFromSymbol(symbol);

        if (_assetType === 'crypto') {
          _is24h = true;
          _sessionLabel = '24/7';
          _exchangeTz = 'Always open';
          _statusColor = '#22c55e';
          _statusText = 'Market open';
        } else if (_assetType === 'forex') {
          _is24h = true;
          _sessionLabel = _isBST ? 'Sun 10 PM – Fri 10 PM BST' : 'Sun 10 PM – Fri 10 PM GMT';
          _exchangeTz = _ukTzLabel;
          if (!_isOpen) _statusText = 'Weekend — market closed';
        } else if (_assetType === 'stock' && _exchangeId) {
          // International stock: use exchange-specific hours
          const _exInfo = getExchangeInfo(_exchangeId);
          _openMinutes = _exInfo.openHour * 60 + _exInfo.openMinute;
          _closeMinutes = _exInfo.closeHour * 60 + _exInfo.closeMinute;
          const _oH = String(_exInfo.openHour).padStart(2, '0');
          const _oM = _exInfo.openMinute === 0 ? '00' : String(_exInfo.openMinute).padStart(2, '0');
          const _cH = String(_exInfo.closeHour).padStart(2, '0');
          const _cM = _exInfo.closeMinute === 0 ? '00' : String(_exInfo.closeMinute).padStart(2, '0');
          _sessionLabel = `${_oH}:${_oM} – ${_cH}:${_cM} ${_exInfo.tzLabel}`;
          _exchangeTz = `${_exInfo.exchange} (${_exInfo.tzLabel})`;
          if (_exInfo.lunchBreak) {
            const _lbS = `${String(_exInfo.lunchBreak.startHour).padStart(2,'0')}:${String(_exInfo.lunchBreak.startMinute).padStart(2,'0')}`;
            const _lbE = `${String(_exInfo.lunchBreak.endHour).padStart(2,'0')}:${String(_exInfo.lunchBreak.endMinute).padStart(2,'0')}`;
            _sessionLabel += ` (break ${_lbS}–${_lbE})`;
          }
        } else if (_assetType === 'stock') {
          // US stocks: show in UK time
          _openMinutes = 14 * 60 + 30; // 2:30 PM UK (9:30 AM ET + 5h)
          _closeMinutes = 21 * 60; // 9:00 PM UK (4:00 PM ET + 5h)
          if (isUSEarlyClose(_now)) {
            _closeMinutes = 18 * 60; // 6:00 PM UK (1:00 PM ET + 5h)
            _statusColor = _isOpen ? '#f59e0b' : '#ef4444';
            _statusText = _isOpen ? 'Early close today' : 'Market closed';
          }
          const _openH = Math.floor(_openMinutes / 60);
          const _closeH = Math.floor(_closeMinutes / 60);
          const _openMStr = _openMinutes % 60 === 0 ? ':00' : ':30';
          const _closeMStr = _closeMinutes % 60 === 0 ? ':00' : ':30';
          _sessionLabel = `${_openH}${_openMStr} – ${_closeH}${_closeMStr} ${_isBST ? 'BST' : 'GMT'}`;
          _exchangeTz = `NYSE/NASDAQ (${_ukTzLabel})`;
        } else if (_assetType === 'commodity' || _assetType === 'index') {
          _is24h = true;
          _sessionLabel = _isBST ? 'Sun 11 PM – Fri 10 PM BST' : 'Sun 11 PM – Fri 10 PM GMT';
          _exchangeTz = _ukTzLabel;
          const _breakStart = _isBST ? 23 * 60 : 22 * 60;
          const _breakEnd = _isBST ? 24 * 60 : 23 * 60;
          if (_isOpen && _ukMinutes >= _breakStart - 15 && _ukMinutes < _breakStart) {
            _statusText = 'Closing soon — daily break';
            _statusColor = '#f59e0b';
          } else if (!_isOpen && _ukMinutes >= _breakStart && _ukMinutes < _breakEnd) {
            _statusText = 'Daily maintenance break';
          }
        }

        // Calculate countdown for stocks
        let _countdown = '';
        if (!_is24h && _assetType === 'stock') {
          // For intl stocks, compute countdown using exchange local time
          let _localMin = _ukMinutes; // default UK
          if (_exchangeId) {
            try {
              const _exInfo = getExchangeInfo(_exchangeId);
              const _fmt = new Intl.DateTimeFormat('en-GB', { timeZone: _exInfo.timezone, hour: 'numeric', minute: 'numeric', hour12: false });
              const _parts = _fmt.formatToParts(_now);
              const _h = parseInt(_parts.find(p => p.type === 'hour')?.value || '0');
              const _m = parseInt(_parts.find(p => p.type === 'minute')?.value || '0');
              _localMin = _h * 60 + _m;
            } catch { /* fallback to UK */ }
          }
          if (_isOpen) {
            const mins = _closeMinutes - _localMin;
            if (mins > 0) {
              const h = Math.floor(mins / 60);
              const m = mins % 60;
              _countdown = h > 0 ? `Closes in ${h}h ${m}m` : `Closes in ${m} minutes`;
            }
          } else {
            // Check if today is a weekday and before market open
            const _localDay = _exchangeId ? (() => { try { const f = new Intl.DateTimeFormat('en-GB', { timeZone: getExchangeInfo(_exchangeId).timezone, weekday: 'short' }); const d = f.formatToParts(_now).find(p => p.type === 'weekday')?.value || ''; return { 'Mon':1,'Tue':2,'Wed':3,'Thu':4,'Fri':5 }[d] || 0; } catch { return 0; } })() : _ukDay;
            if (_localDay >= 1 && _localDay <= 5 && _localMin < _openMinutes) {
              const mins = _openMinutes - _localMin;
              const h = Math.floor(mins / 60);
              const m = mins % 60;
              _countdown = h > 0 ? `Opens in ${h}h ${m}m` : `Opens in ${m} minutes`;
            }
          }
        }

        // Session progress for timeline bar
        let _progress = 0;
        if (!_is24h && _isOpen && _closeMinutes > _openMinutes) {
          let _localMin = _ukMinutes;
          if (_exchangeId) {
            try {
              const _exInfo = getExchangeInfo(_exchangeId);
              const _fmt = new Intl.DateTimeFormat('en-GB', { timeZone: _exInfo.timezone, hour: 'numeric', minute: 'numeric', hour12: false });
              const _parts = _fmt.formatToParts(_now);
              const _h = parseInt(_parts.find(p => p.type === 'hour')?.value || '0');
              const _m = parseInt(_parts.find(p => p.type === 'minute')?.value || '0');
              _localMin = _h * 60 + _m;
            } catch { /* fallback */ }
          }
          _progress = Math.max(0, Math.min(1, (_localMin - _openMinutes) / (_closeMinutes - _openMinutes)));
        }

        const _dayLabel = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][_ukDay];

        // Theme-aware colors via CSS variables
        const _isDarkTheme = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
        const _bg = _isDarkTheme ? 'rgba(22, 25, 35, 0.98)' : 'rgba(255, 255, 255, 0.98)';
        const _border = _isDarkTheme ? 'rgba(55, 60, 75, 0.6)' : 'rgba(210, 215, 225, 0.8)';
        const _dimText = _isDarkTheme ? '#7b8094' : '#6b7280';
        const _labelText = _isDarkTheme ? '#a0a6b8' : '#374151';
        const _trackBg = _isDarkTheme ? '#2a2e3a' : '#e5e7eb';

        return (
          <div
            ref={sessionInfoRef}
            className="relative"
          >
            {/* Dot button */}
            <button
              onClick={(e) => { e.stopPropagation(); setSessionInfoOpen(p => !p); }}
              className="flex items-center justify-center w-5 h-5 rounded-full transition-all duration-200 hover:scale-125"
              title="Session info"
              style={{ background: 'transparent' }}
            >
              <span
                className="block rounded-full"
                style={{
                  width: 7,
                  height: 7,
                  background: _statusColor,
                  boxShadow: `0 0 6px ${_statusColor}60`,
                }}
              />
            </button>

            {/* Popover */}
            {sessionInfoOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 4px)',
                  left: -40,
                  width: 260,
                  background: _bg,
                  border: `1px solid ${_border}`,
                  borderRadius: 10,
                  boxShadow: _isDarkTheme
                    ? '0 8px 32px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3)'
                    : '0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)',
                  zIndex: 100,
                  backdropFilter: 'blur(12px)',
                  overflow: 'hidden',
                }}
              >
                {/* Status header */}
                <div style={{ padding: '14px 16px 10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: _statusColor,
                        boxShadow: `0 0 6px ${_statusColor}60`,
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ color: _statusColor, fontSize: 13, fontWeight: 600 }}>
                      {_statusText}
                    </span>
                  </div>
                  {_countdown && (
                    <p style={{ color: _dimText, fontSize: 12, margin: '4px 0 0 16px', lineHeight: 1.3 }}>
                      {_countdown}
                    </p>
                  )}
                </div>

                {/* Session timeline (stocks only) */}
                {!_is24h && _assetType === 'stock' && (
                  <div style={{ padding: '6px 16px 10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                      <span style={{ color: _dimText, fontSize: 9, fontWeight: 700, letterSpacing: 1.2, fontFamily: '"SF Mono", Consolas, monospace' }}>
                        {_dayLabel}
                      </span>
                      <div style={{ flex: 1, height: 5, borderRadius: 3, background: _trackBg, overflow: 'hidden', position: 'relative' }}>
                        {_isOpen && (
                          <div
                            style={{
                              position: 'absolute',
                              left: 0,
                              top: 0,
                              height: '100%',
                              width: `${_progress * 100}%`,
                              background: `linear-gradient(90deg, ${_statusColor}aa, ${_statusColor})`,
                              borderRadius: 3,
                              transition: 'width 1s ease',
                            }}
                          />
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: _dimText, fontFamily: '"SF Mono", Consolas, monospace' }}>
                      <span>{_sessionLabel.split('–')[0]?.trim()}</span>
                      <span>{_sessionLabel.split('–')[1]?.trim()}</span>
                    </div>
                  </div>
                )}

                {/* Separator */}
                <div style={{ height: 1, background: _border, margin: '0 12px' }} />

                {/* Info rows */}
                <div style={{ padding: '10px 16px 14px' }}>
                  {_exchangeTz && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, marginBottom: 6 }}>
                      <span style={{ color: _dimText }}>Exchange timezone</span>
                      <span style={{ color: _labelText, fontFamily: '"SF Mono", Consolas, monospace', fontSize: 10 }}>{_exchangeTz}</span>
                    </div>
                  )}
                  {_sessionLabel && _assetType !== 'stock' && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, marginBottom: 6 }}>
                      <span style={{ color: _dimText }}>Session</span>
                      <span style={{ color: _labelText, fontFamily: '"SF Mono", Consolas, monospace', fontSize: 10 }}>{_sessionLabel}</span>
                    </div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, marginBottom: 6 }}>
                    <span style={{ color: _dimText }}>Local time</span>
                    <span style={{ color: _labelText, fontFamily: '"SF Mono", Consolas, monospace', fontSize: 10 }}>{_ukHH}:{_ukMM} {_isBST ? 'BST' : 'GMT'}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11 }}>
                    <span style={{ color: _dimText }}>Update frequency</span>
                    <span style={{ color: '#22c55e', fontFamily: '"SF Mono", Consolas, monospace', fontSize: 10 }}>{_updateFreq}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })()}
      </div>

      {/* ═══ TradingView-style clickable overlay indicator labels + inline toolbar ═══ */}
      {showOHLC && indicators && onIndicatorsChange && (() => {
        // Registry-driven overlay list; see ProChart.tsx for the same
        // pattern. Bespoke endX vars stay because BB/MA/VWAP/Vol Profile/
        // Volume measure label width via custom canvas paths instead of
        // the generic overlayLabelEndX dict.
        const bespokeOverlayEndX: Record<string, () => number> = {
          bollinger: () => bbTextEndX,
          movingAverages: () => maTextEndX,
          vwap: () => vwapTextEndX,
          volumeProfile: () => vpTextEndX,
          volume: () => volTextEndX,
        };
        const overlayOrder: { key: string; title: string; enabledCheck: () => boolean; endXSource: () => number }[] =
          getOverlayIndicatorIds().map((id) => ({
            key: id,
            title: getLegendTitle(id),
            enabledCheck: () => {
              if (id === 'volume') {
                return !!(indicators?.volume?.enabled && candles.some(c => c.volume));
              }
              if (id === 'volumeProfile') {
                return !!(indicators as any)?.volumeProfile?.enabled;
              }
              return !!((indicators as any)?.[id]?.enabled && (indicatorData as any)?.[id]);
            },
            endXSource: bespokeOverlayEndX[id] ?? (() => overlayLabelEndX[id] || 0),
          }));

        // Must match canvas rendering: ohlcBottomY and indicatorLineH.
        // Values come from the active device config block.
        const toolbarLineH = cfg.toolbarLineHeight;
        let currentY = cfg.toolbarStartY;
        const rows: React.ReactNode[] = [];

        // No OHLC row in the toolbar. The existing chevron toggle handles
        // show/hide. Adding a hide button here would leave no way to unhide.

        for (const ind of overlayOrder) {
          if (!ind.enabledCheck()) continue;
          const y = currentY;
          const endX = ind.endXSource();
          // MAs span multiple lines (one per MA), other indicators use 1 row
          const rowCount = ind.key === 'movingAverages' && indicatorData?.movingAverages
            ? Math.max(1, indicatorData.movingAverages.length)
            : 1;
          currentY += toolbarLineH * rowCount;
          if (endX <= 0) continue;

          const isSelected = clickedIndicatorKey === ind.key;
          const isActive = isSelected || hoveredIndicatorKey === ind.key;

          rows.push(
            <div
              key={`overlay-row-${ind.key}`}
              className="absolute z-20 flex items-center"
              style={{
                left: 0,
                top: y - cfg.toolbarRowYOffset,
                height: toolbarLineH * rowCount,
              }}
              onMouseEnter={() => {
                setHoveredIndicatorKey(ind.key);
                isHoveringSettingsRef.current = true;
                if (mouseLeaveTimeoutRef.current) clearTimeout(mouseLeaveTimeoutRef.current);
              }}
              onMouseLeave={() => {
                mouseLeaveTimeoutRef.current = setTimeout(() => {
                  setHoveredIndicatorKey(prev => prev === ind.key ? null : prev);
                  isHoveringSettingsRef.current = false;
                }, 150);
              }}
            >
              {/* Selection highlight background, only when clicked */}
              {isSelected && (
                <div
                  className="absolute inset-0 pointer-events-none"
                  style={{
                    width: endX + 105,
                    borderRadius: 3,
                    background: 'rgba(59, 130, 246, 0.08)',
                  }}
                />
              )}
              {/* Transparent clickable area over the canvas label text */}
              <div
                className="cursor-pointer select-none"
                style={{ width: endX, height: 16 }}
                onClick={(e) => {
                  e.stopPropagation();
                  setClickedIndicatorKey(prev => prev === ind.key ? null : ind.key);
                  setHoveredIndicatorKey(ind.key);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setClickedIndicatorKey(ind.key);
                  setIndicatorContextMenu({ visible: true, x: e.clientX, y: e.clientY, key: ind.key, title: ind.title });
                }}
              />
              {/* Inline icon toolbar, only visible when CLICKED (not hover), matching TradingView */}
              {isSelected && (
                <div className="flex items-center gap-[3px] ml-1.5" style={{ height: 16 }}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const cfg = (indicators as any)[ind.key];
                      if (cfg) onIndicatorsChange({ ...indicators, [ind.key]: { ...cfg, enabled: false } });
                      setHoveredIndicatorKey(null);
                      setClickedIndicatorKey(null);
                    }}
                    className="w-[22px] h-[18px] flex items-center justify-center rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors"
                    title={`Hide ${ind.title}`}
                  >
                    <Eye className="w-[15px] h-[15px]" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedIndicator({ type: ind.key as IndicatorType, position: { x: endX, y } });
                    }}
                    className="w-[22px] h-[18px] flex items-center justify-center rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors"
                    title={`${ind.title} Settings`}
                  >
                    <Settings className="w-[15px] h-[15px]" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const cfg = (indicators as any)[ind.key];
                      if (cfg) onIndicatorsChange({ ...indicators, [ind.key]: { ...cfg, enabled: false } });
                      setHoveredIndicatorKey(null);
                      setClickedIndicatorKey(null);
                    }}
                    className="w-[22px] h-[18px] flex items-center justify-center rounded hover:bg-white/10 text-muted-foreground hover:text-red-400 transition-colors"
                    title={`Remove ${ind.title}`}
                  >
                    <Trash2 className="w-[15px] h-[15px]" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setClickedIndicatorKey(ind.key);
                      setIndicatorContextMenu({ visible: true, x: e.clientX, y: e.clientY, key: ind.key, title: ind.title });
                    }}
                    className="w-[22px] h-[18px] flex items-center justify-center rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors"
                    title="More options"
                  >
                    <MoreHorizontal className="w-[15px] h-[15px]" />
                  </button>
                </div>
              )}
            </div>
          );
        }
        return rows;
      })()}

      {/* ═══ TradingView-style clickable subplot indicator labels + inline toolbar ═══ */}
      {indicators && onIndicatorsChange && (() => {
        // Registry-driven subplot list (mirrors ProChart.tsx Phase 3b).
        const allSubplots: { key: string; title: string }[] = getSubplotIndicatorIds()
          .map((id) => ({ key: id, title: getLegendTitle(id) }));
        return allSubplots.map(({ key, title }) => {
          const bounds = (indicatorBoundsRef.current as any)[key];
          const data = (indicatorData as any)?.[key];
          if (!data || !bounds) return null;
          const endX = subplotLabelEndX[key] || 0;
          if (endX <= 0) return null;

          const spKey = `sp-${key}`;
          const isSelected = clickedIndicatorKey === spKey;
          const isActive = isSelected || hoveredIndicatorKey === spKey;

          return (
            <div
              key={`sp-row-${key}`}
              className="absolute z-20 flex items-center"
              style={{
                left: 0,
                top: bounds.top + 2,
                height: 16,
              }}
              onMouseEnter={() => {
                setHoveredIndicatorKey(spKey);
                isHoveringSettingsRef.current = true;
                if (mouseLeaveTimeoutRef.current) clearTimeout(mouseLeaveTimeoutRef.current);
              }}
              onMouseLeave={() => {
                mouseLeaveTimeoutRef.current = setTimeout(() => {
                  setHoveredIndicatorKey(prev => prev === spKey ? null : prev);
                  isHoveringSettingsRef.current = false;
                }, 150);
              }}
            >
              {/* Selection highlight background, only when clicked */}
              {isSelected && (
                <div
                  className="absolute inset-0 pointer-events-none"
                  style={{
                    width: endX + 105,
                    borderRadius: 3,
                    background: 'rgba(59, 130, 246, 0.08)',
                  }}
                />
              )}
              {/* Transparent clickable area over the canvas label text */}
              <div
                className="cursor-pointer select-none"
                style={{ width: endX, height: 16 }}
                onClick={(e) => {
                  e.stopPropagation();
                  setClickedIndicatorKey(prev => prev === spKey ? null : spKey);
                  setHoveredIndicatorKey(spKey);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setClickedIndicatorKey(spKey);
                  setIndicatorContextMenu({ visible: true, x: e.clientX, y: e.clientY, key, title });
                }}
              />
              {/* Inline icon toolbar, only visible when CLICKED (not hover), matching TradingView */}
              {isSelected && (
                <div className="flex items-center gap-[3px] ml-1.5" style={{ height: 16 }}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const cfg = (indicators as any)[key];
                      if (cfg) onIndicatorsChange({ ...indicators, [key]: { ...cfg, enabled: false } });
                      setHoveredIndicatorKey(null);
                      setClickedIndicatorKey(null);
                    }}
                    className="w-[22px] h-[18px] flex items-center justify-center rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors"
                    title={`Hide ${title}`}
                  >
                    <Eye className="w-[15px] h-[15px]" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedIndicator({ type: key as IndicatorType, position: { x: endX, y: bounds.top } });
                    }}
                    className="w-[22px] h-[18px] flex items-center justify-center rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors"
                    title={`${title} Settings`}
                  >
                    <Settings className="w-[15px] h-[15px]" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const cfg = (indicators as any)[key];
                      if (cfg) onIndicatorsChange({ ...indicators, [key]: { ...cfg, enabled: false } });
                      setHoveredIndicatorKey(null);
                      setClickedIndicatorKey(null);
                    }}
                    className="w-[22px] h-[18px] flex items-center justify-center rounded hover:bg-white/10 text-muted-foreground hover:text-red-400 transition-colors"
                    title={`Remove ${title}`}
                  >
                    <Trash2 className="w-[15px] h-[15px]" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setClickedIndicatorKey(spKey);
                      setIndicatorContextMenu({ visible: true, x: e.clientX, y: e.clientY, key, title });
                    }}
                    className="w-[22px] h-[18px] flex items-center justify-center rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors"
                    title="More options"
                  >
                    <MoreHorizontal className="w-[15px] h-[15px]" />
                  </button>
                </div>
              )}
            </div>
          );
        });
      })()}

      {/* Overlay indicator settings buttons are now handled by the hover toolbar system above */}

      {/* Y-axis drag zone for price scale (right side) - z-40 sits above SL/TP overlay */}
      <div
        ref={yAxisRef}
        className="absolute top-0 cursor-ns-resize z-40"
        style={{
          right: 0,
          width: PRICE_AXIS_WIDTH,
          height: mainChartHeightForHandle,
        }}
        onMouseDown={handleYAxisMouseDown}
        onTouchStart={handleYAxisTouchStart}
        title="Drag to stretch/compress, Scroll to pan up/down"
      />

      {/* TradingView-style navigation buttons - positioned above x-axis */}
      <div
        className="absolute z-10 flex items-center gap-1 opacity-60 hover:opacity-100 transition-opacity duration-200"
        style={{
          bottom: TIME_AXIS_HEIGHT + 8,
          left: `calc(50% - ${PRICE_AXIS_WIDTH / 2}px)`,
          transform: 'translateX(-50%)',
        }}
      >
        <div className="flex items-center bg-card/90 backdrop-blur-sm rounded-lg border border-border/40 shadow-lg overflow-hidden">
          <button
            onClick={handleZoomOut}
            className="w-8 h-7 lg:w-10 lg:h-9 flex items-center justify-center hover:bg-primary/10 text-muted-foreground hover:text-foreground transition-all text-lg lg:text-xl font-light border-r border-border/30"
            title="Zoom out (show more candles)"
          >
            −
          </button>
          <button
            onClick={handleZoomIn}
            className="w-8 h-7 lg:w-10 lg:h-9 flex items-center justify-center hover:bg-primary/10 text-muted-foreground hover:text-foreground transition-all text-lg lg:text-xl font-light border-r border-border/30"
            title="Zoom in (show fewer candles)"
          >
            +
          </button>
          <button
            onClick={handleMoveLeft}
            className="w-7 h-7 lg:w-9 lg:h-9 flex items-center justify-center hover:bg-primary/10 text-muted-foreground hover:text-foreground transition-all text-base lg:text-lg border-r border-border/30"
            title="Move left (older)"
          >
            ‹
          </button>
          <button
            onClick={handleMoveRight}
            className="w-7 h-7 lg:w-9 lg:h-9 flex items-center justify-center hover:bg-primary/10 text-muted-foreground hover:text-foreground transition-all text-base lg:text-lg border-r border-border/30"
            title="Move right (newer)"
          >
            ›
          </button>
          <button
            onClick={handleResetView}
            className="w-8 h-7 lg:w-10 lg:h-9 flex items-center justify-center hover:bg-primary/10 text-muted-foreground hover:text-foreground transition-all"
            title="Reset view"
          >
            <svg viewBox="0 0 14 14" className="w-3.5 h-3.5 lg:w-4 lg:h-4" fill="currentColor">
              <path d="M7 1.5c-3.04 0-5.5 2.46-5.5 5.5s2.46 5.5 5.5 5.5c2.41 0 4.46-1.55 5.2-3.71l-1.41-.49c-.53 1.51-1.96 2.6-3.79 2.6-2.13 0-3.9-1.77-3.9-3.9s1.77-3.9 3.9-3.9c1.08 0 2.05.44 2.75 1.15L8 6h4.5V1.5L10.96 3C9.93 1.97 8.54 1.5 7 1.5z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Y-axis free mode indicator - show reset button on price axis */}
      {isYAxisFreeMode && (
        <div
          className="absolute z-50 flex items-center justify-center"
          style={{
            top: 4,
            // Desktop reserves the RIGHT_TOOLBAR_WIDTH gap; phone/tablet
            // have no toolbar overlay so the reset button uses full axis width.
            right: rightOffset ?? (cfg.yAxisResetUsesToolbarGap ? RIGHT_TOOLBAR_WIDTH : 0),
            width: (rightOffset !== undefined ? PRICE_AXIS_WIDTH - rightOffset : (cfg.yAxisResetUsesToolbarGap ? PRICE_AXIS_WIDTH - RIGHT_TOOLBAR_WIDTH : PRICE_AXIS_WIDTH)),
          }}
        >
          <button
            onClick={handleResetYAxis}
            className="flex items-center gap-1 px-1.5 py-0.5 bg-primary/20 hover:bg-primary/30 text-primary text-[10px] rounded border border-primary/30 transition-all"
            title="Reset price scale to auto"
          >
            <svg viewBox="0 0 14 14" className="w-2.5 h-2.5" fill="currentColor">
              <path d="M7 1.5c-3.04 0-5.5 2.46-5.5 5.5s2.46 5.5 5.5 5.5c2.41 0 4.46-1.55 5.2-3.71l-1.41-.49c-.53 1.51-1.96 2.6-3.79 2.6-2.13 0-3.9-1.77-3.9-3.9s1.77-3.9 3.9-3.9c1.08 0 2.05.44 2.75 1.15L8 6h4.5V1.5L10.96 3C9.93 1.97 8.54 1.5 7 1.5z" />
            </svg>
            Auto
          </button>
        </div>
      )}

      {/* TradingView-style resize handle for indicator panels */}
      {hasIndicators && (
        <div
          className="absolute left-0 h-3 flex items-center justify-center cursor-ns-resize z-10 group hover:h-4 transition-all duration-150"
          style={{
            top: mainChartHeightForHandle - 6,
            right: PRICE_AXIS_WIDTH,
            left: 0
          }}
          onMouseDown={handleResizeStart}
          onTouchStart={handleResizeStart}
        >
          {/* Full-width hover zone with subtle separator line */}
          <div className="w-full h-[1px] bg-border/20 group-hover:bg-primary/40 transition-all duration-150" />

          {/* TradingView-style small centered slider grip - appears on hover */}
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 
            opacity-0 group-hover:opacity-100
            transition-all duration-150">
            <div className="flex items-center justify-center w-10 h-2.5 rounded-sm bg-muted/80 border border-border/60 hover:bg-primary/30 hover:border-primary/50">
              {/* Three horizontal lines - TradingView grip style */}
              <div className="flex flex-col gap-[2px]">
                <div className="w-5 h-[1px] bg-muted-foreground/60 group-hover:bg-primary/80" />
                <div className="w-5 h-[1px] bg-muted-foreground/60 group-hover:bg-primary/80" />
              </div>
            </div>
          </div>
        </div>
      )}


      {/* Indicator Panel Settings Popup */}
      {selectedIndicator && indicators && onIndicatorsChange && dimensions && (
        <IndicatorPanelSettings
          type={selectedIndicator.type}
          config={indicators}
          onConfigChange={onIndicatorsChange}
          position={selectedIndicator.position}
          onClose={() => setSelectedIndicator(null)}
        />
      )}

      {/* ═══ TradingView-style right-click context menu for indicator labels ═══ */}
      {indicatorContextMenu && indicatorContextMenu.visible && indicators && onIndicatorsChange && (() => {
        const chartRect = overlayCanvasRef.current?.getBoundingClientRect();
        if (!chartRect) return null;
        const menuX = indicatorContextMenu.x - chartRect.left;
        const menuY = indicatorContextMenu.y - chartRect.top;
        const menuKey = indicatorContextMenu.key;

        return ReactDOM.createPortal(
          (() => {
            // Shell chrome by the terminal's own vars, identical to the menu
            // ProChart draws. This is the BACKTEST tab's chart, so a menu
            // styled differently here would reintroduce exactly the mismatch
            // the MARKETS one was just fixed for. See style.css's header:
            // neutral only, 2px corners, never hardcode a hex.
            const menuText = 'var(--text)';
            const menuHover = 'var(--hover)';
            const menuBorder = 'var(--edge)';
            const btnStyle: React.CSSProperties = {
              display: 'block', width: '100%', padding: '3px 10px',
              border: 'none', cursor: 'pointer', background: 'transparent',
              textAlign: 'left' as const, fontSize: '12px',
              fontFamily: 'inherit', color: menuText, lineHeight: '1.5',
            };
            return (
              <div
                style={{
                  position: 'fixed', zIndex: 9999, minWidth: '150px',
                  padding: '2px 0 6px',
                  background: 'var(--panel)', border: '1px solid var(--edge)',
                  borderRadius: '2px', boxShadow: '0 6px 20px var(--shadow)',
                  left: Math.min(indicatorContextMenu.x, window.innerWidth - 170),
                  top: Math.min(indicatorContextMenu.y, window.innerHeight - 140),
                }}
              >
                {/* Invisible backdrop */}
                <div
                  style={{ position: 'fixed', inset: 0, zIndex: -1 }}
                  onClick={() => { setIndicatorContextMenu(null); setClickedIndicatorKey(null); }}
                  onContextMenu={(e) => { e.preventDefault(); setIndicatorContextMenu(null); setClickedIndicatorKey(null); }}
                />
                {/* Name of what the menu is acting on, quiet dim caption. */}
                <div style={{ padding: '5px 10px 3px', fontSize: '11px', color: 'var(--dim)', whiteSpace: 'nowrap' }}>
                  {indicatorContextMenu.title}
                </div>
                {/* Text-only rows: glyph prefixes were dropped from the
                    terminal's chrome for reading as decoration. */}
                <button
                  style={btnStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.background = menuHover; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  onClick={() => {
                    setSelectedIndicator({ type: menuKey as IndicatorType, position: { x: menuX, y: menuY } });
                    setIndicatorContextMenu(null);
                  }}
                >Settings...</button>
                <button
                  style={btnStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.background = menuHover; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  onClick={() => {
                    const cfg = (indicators as any)[menuKey];
                    if (cfg) onIndicatorsChange({ ...indicators, [menuKey]: { ...cfg, enabled: false } });
                    setIndicatorContextMenu(null);
                    setClickedIndicatorKey(null);
                  }}
                >Hide</button>
                {/* Separator above the destructive row only. */}
                <div style={{ margin: '3px 0', borderTop: `1px solid ${menuBorder}` }} />
                <button
                  style={{ ...btnStyle, color: 'var(--err)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = menuHover; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  onClick={() => {
                    const cfg = (indicators as any)[menuKey];
                    if (cfg) onIndicatorsChange({ ...indicators, [menuKey]: { ...cfg, enabled: false } });
                    setIndicatorContextMenu(null);
                    setClickedIndicatorKey(null);
                  }}
                >Remove</button>
              </div>
            );
          })(),
          document.body
        );
      })()}

      {/* Watermark deliberately removed: the terminal is the user's own
          workspace, no LSE logo on the canvas. (Site charts keep theirs;
          this is the terminal's copy of the file.) */}
    </div>
  );
};

export default ProChart;
