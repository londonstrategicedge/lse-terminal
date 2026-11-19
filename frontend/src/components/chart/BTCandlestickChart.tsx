import React, { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { api } from "@/lib/api";
import { EconomicEvent } from "./ChartLeftSidebar";
// Backtester-specific chart copy: isolated from ProChart so backtester
// changes never affect the live trading charts.
import ProChart from "./BTChart";
import { useChartDataCache, getOptimalCandleLimit, getInitialLoadCount, clearChartCache } from "@/hooks/useChartDataCache";
import { isUSMarketOpen as checkUSMarketOpenForTimestamp, isUSHoliday, isUSEarlyClose, isMarketOpenForPair } from "@/lib/marketHours";
import { useLiveTick } from "@/contexts/WebSocketContext";
// Data fetching utilities, aggregation, and symbol resolution extracted into reusable hooks.
// The actual fetch orchestration stays in this file because it is tightly coupled to
// component state (setCandles, setLoading, etc). The hooks contain pure functions only.
import {
  type CandleData,
  BACKTEST_API,
  TF_MINUTES,
  CRYPTO_BASES,
  CRYPTO_QUOTES,
  FIAT_QUOTES,
  parseTickCount,
  isTickTimeframe,
  parseSecondCount,
  isSecondTimeframe,
  timeframeToMinutes,
  isStock,
  isCommodity,
  isCrypto,
  isForex,
  formatPairForTable,
  formatPairForSymbol,
  buildSymbolVariants,
  mapCandleData,
  aggregateCandles,
  aggregateCandlesByMonth,
  aggregateCandlesPartial,
  aggregateTickCandles,
  aggregateTicksByTime,
  mergeCandles,
  fetchWindowedCandles,
  getHTFTableName,
  getDailyTableName,
  fetchOandaHtf,
  isLightBackground,
  useSymbolFormatters,
} from "./hooks/useCandleFetch";
import { useLiveCandleFromTicks, mergeLiveCandleWithHistory, clearTickCandleStorage, type LiveCandle } from "@/hooks/useLiveCandleFromTicks";
import { PRICE_TAG_NEUTRAL } from "./core/types";
import { useChartSettings } from '@/contexts/ChartSettingsContext';



interface ProCandlestickChartProps {
  pair: string;
  timeframe: string;
  customColors?: {
    upColor: string;
    downColor: string;
    upBorderColor: string;
    downBorderColor: string;
    wickUpColor: string;
    wickDownColor: string;
    backgroundColor: string;
    backgroundOpacity?: number;
    gridColor: string;
    gridOpacity?: number;
    axisLabelColor?: string;
    axisLineColor?: string;
    priceTickerBullish?: string;
    priceTickerBearish?: string;
  };
  timezone?: string;
  onStats?: (stats: {
    count?: number;
    price?: number | null;
    time?: number | null;
    dayChange?: number;
    countdown?: string;
  }) => void;
  indicators?: any;
  onIndicatorsChange?: (config: any) => void;
  onConverterReady?: (converter: {
    timeToX: (time: number) => number | null;
    xToTime: (x: number) => number | null;
    priceToY: (price: number) => number;
    yToPrice: (y: number) => number;
  }) => void;
  onVisibleRangeChange?: (range: {
    startIndex: number;
    endIndex: number;
    totalCandles: number;
  }) => void;
  onPriceUpdate?: (price: number, high?: number, low?: number) => void;
  // Backtest mode props (only used when startDate is provided)
  startDate?: string;
  startTime?: string;
  replayTimestamp?: string;
  onReplayDataReady?: (totalCandles: number, timestamps: string[]) => void;
  replayPriceOverride?: number;
  chartType?: 'candlestick' | 'line' | 'area' | 'renko';
  // Crosshair sync props
  onCrosshairMove?: (price: number | null, time: number | null) => void;
  syncedCrosshairTime?: number | null;
  // Time sync props (viewport position)
  onViewportTimeChange?: (centerTime: number) => void;
  syncedViewportTime?: number | null;
  // Scroll sync for drawing overlay (ref-based, no state updates)
  onScrollSync?: () => void;
  // Scroll offset ref for CSS transform-based scroll sync (eliminates jitter)
  scrollOffsetRef?: React.MutableRefObject<number>;
  // External raw data for multi-panel sync (if provided, skip internal fetch)
  externalRawCandles?: CandleData[];
  // Callback to export raw candles to parent (for multi-panel sharing)
  onRawCandlesReady?: (candles: CandleData[]) => void;
  onChartCandlesReady?: (candles: { time: number; open: number; high: number; low: number; close: number; volume?: number }[]) => void;
  // Options PDF toggle (probability wave visualization)
  optionsPdfEnabled?: boolean;
  // L2 Order Book Heatmap wrapper toggle
  heatmapEnabled?: boolean;
  // Economic events to display on chart
  economicEvents?: EconomicEvent[];
  // Custom indicator editor
  onOpenCustomEditor?: () => void;
  positionLines?: Array<{ id: string; price: number; side: 'buy' | 'sell'; quantity: number; symbol: string; pnl?: number; stopLoss?: number; takeProfit?: number }>;
  onPositionModify?: (positionId: string, stopLoss?: number, takeProfit?: number) => void;
  onPositionClose?: (positionId: string) => void;
  autoSelectPositionId?: string | null;
  l2DepthData?: { bids: { price: number; size: number }[]; asks: { price: number; size: number }[] } | null;
  onOpenSettings?: (tab?: string) => void;
  showBidAskSpread?: boolean;
  showSessions?: boolean; // Show trading session background boxes (Tokyo, London, NY)
  // Data source: 'default' uses candles_* tables; the FX/CFD source (the type's other value) uses
  // its own views and its own higher-timeframe candle tables, named with its prefix,
  // 'ftmo' fetches from /prop/candles/public (public prop demo feed, no login needed),
  // 'prop' fetches from /prop/candles (private firm feed, needs X-Prop-Session auth for live accounts).
  dataSource?: 'default' | 'oanda';
  // Override right offset for positioning components like the Reset Y-axis button 
  // and dynamically squishing the Price Axis when Trade UI separates it from RightToolbar
  // Override right offset for positioning components like the RightToolbar
  rightOffset?: number; 
  drawings?: any[];
  selectedDrawingId?: string | null;
  // Ref holding array of badge points for drawing cursor preview (anchor + live cursor).
  // Written by ChartDrawingOverlay, read by ProChart to render blue price/time badges.
  drawingCursorRef?: React.MutableRefObject<Array<{ price: number | null; time: number | null; x: number | null }>>;
  // Ref populated by ProChart with its drawChart function. ChartDrawingOverlay calls
  // this after updating drawingCursorRef to trigger a canvas repaint for real-time badges.
  requestRedrawRef?: React.MutableRefObject<(() => void) | null>;
  isDrawingDragging?: boolean;
}
const ProCandlestickChart = ({
  pair,
  timeframe,
  customColors,
  timezone = 'UTC',
  onStats,
  indicators,
  onIndicatorsChange,
  onConverterReady,
  onVisibleRangeChange,
  onPriceUpdate,
  startDate,
  startTime = '00:00',
  replayTimestamp,
  onReplayDataReady,
  replayPriceOverride,
  chartType = 'candlestick',
  onCrosshairMove,
  syncedCrosshairTime,
  onViewportTimeChange,
  syncedViewportTime,
  onScrollSync,
  scrollOffsetRef,
  externalRawCandles,
  onRawCandlesReady,
  onChartCandlesReady,
  optionsPdfEnabled = false,
  heatmapEnabled = false,
  economicEvents,
  onOpenCustomEditor,
  positionLines,
  onPositionModify,
  onPositionClose,
  autoSelectPositionId,
  l2DepthData,
  onOpenSettings,
  showBidAskSpread = false,
  showSessions = false,
  dataSource = 'default',
  rightOffset,
  drawings,
  selectedDrawingId,
  drawingCursorRef,
  requestRedrawRef,
  isDrawingDragging,
}: ProCandlestickChartProps) => {
  const [rawCandles, setRawCandles] = useState<CandleData[]>([]); // Raw 1m data for backtesting
  const [candles, setCandles] = useState<CandleData[]>([]);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [countdown, setCountdown] = useState<string>('');
  const [loadedTimeframe, setLoadedTimeframe] = useState<string>('');
  const [loadedResolution, setLoadedResolution] = useState<'minute' | 'hourly' | null>(null); // Track what resolution is loaded
  // Background loading: true while phase-2 full history is being fetched silently after
  // phase-1 already rendered the chart with the most recent ~2000 candles.
  const [isBackgroundLoading, setIsBackgroundLoading] = useState(false);
  // Incremented at the start of every fetchCandleData call. Phase-2 background fetches
  // check this before committing; if the value changed, the user switched TF/pair and
  // the stale result is discarded rather than overwriting fresh data.
  const fetchGenerationRef = useRef(0);
  const channelRef = useRef<any>(null);
  const onStatsRef = useRef(onStats);
  const backtestDataLoadedRef = useRef(false);
  const fetchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isInitialLoadRef = useRef(true);

  // Chart colors come from ChartSettingsContext, re-renders automatically
  // when the user changes settings. Was localStorage + chartSettingsChanged
  // event listener; now plain React context consumption.
  const savedChartSettings = useChartSettings();

  // REMOVED: Old liveCandleRef - now using useLiveCandleFromTicks hook

  // Chart data cache for faster switching between pairs/timeframes
  const { getCachedData, setCachedData, updateCacheWithNewCandles, clearCache, handlePairChange } = useChartDataCache();

  // Track previous pair to detect navigation
  const prevPairRef = useRef<string>(pair);

  // CRITICAL: Clear ALL state when pair changes to prevent stale data conflicts
  useEffect(() => {
    if (prevPairRef.current !== pair) {
      console.log('[Chart] Pair changed from', prevPairRef.current, 'to', pair, '- clearing all state');

      // Clear chart data cache for old pair
      clearChartCache(prevPairRef.current);

      // Clear tick candle storage for old pair  
      clearTickCandleStorage(prevPairRef.current);

      // Clear component state
      setCandles([]);
      setRawCandles([]);
      setLivePrice(null);

      // Notify cache system of pair change
      handlePairChange(pair);

      prevPairRef.current = pair;
    }
  }, [pair, handlePairChange]);

  // CRITICAL: Clear all state on unmount to prevent stale data on return
  useEffect(() => {
    return () => {
      console.log('[Chart] Unmounting - clearing all caches for', pair);
      // Clear cache for this pair
      clearChartCache(pair);
      // Clear tick storage for this pair
      clearTickCandleStorage(pair);
    };
  }, [pair]);

  // Provides memoized formatPairForTable/formatPairForSymbol bound to the current
  // dataSource and the symbol table map from x_pricecache.
  const { formatPairForTable, formatPairForSymbol, tableMapLoaded } = useSymbolFormatters(dataSource);

  // Backtest sliding window state
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreData, setHasMoreData] = useState(true);
  const MAX_RAW_CANDLES = 50000;

  // INFINITE SCROLLBACK: State for loading older candles when user scrolls to the left edge.
  // Chart loads 1K -> 5K -> 10K progressively, then fetches 5K more chunks on demand
  // as the user scrolls back through history, up to 100K candles total.
  const [isLoadingMoreHistory, setIsLoadingMoreHistory] = useState(false);
  // The prepend-shift bucket math must use the timeframe at the moment the
  // fetched page LANDS, not the one captured when the fetch launched: a page
  // in flight across a timeframe switch used to compute its shift in the old
  // timeframe's buckets (5001 one-minute bars is ~1000 5m buckets but ~3
  // daily buckets) and blow the new view's startIndex out of the array.
  const shiftTimeframeRef = useRef(timeframe);
  shiftTimeframeRef.current = timeframe;
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  // Cumulative count of candles prepended by loadMoreHistory. Passed to ProChart
  // so it can shift viewState.startIndex by the delta to keep the view stable.
  const [historyPrependShift, setHistoryPrependShift] = useState(0);
  const MAX_HISTORY_CANDLES = 100000;
  // Tracks which data source was used for the current chart so loadMoreHistory
  // knows which API/table to query for older candles. Set at the end of each fetch path.
  const loadMoreInfoRef = useRef<{
    type: 'raw_1m' | 'htf' | 'rpc' | 'none';
    tableName: string; // per-symbol table (e.g. candles_btc_usd) or HTF table (candles_5m)
    symbol: string; // symbol for HTF tables (e.g. BTC/USD)
    tfMinutes: number; // timeframe in minutes for RPC aggregation
  } | null>(null);
  const loadMoreRetryCountRef = useRef(0);


  // Check if timestamp is within US market hours (9:30 AM - 4:00 PM ET)
  // Uses centralized market hours logic with holiday support
  const isUSMarketOpen = (timestamp: string | number) => {
    const date = new Date(timestamp);

    // Check if it's a US holiday
    if (isUSHoliday(date)) return false;

    const utcTime = date.getTime();

    // Calculate ET offset: EST = UTC-5, EDT = UTC-4
    // Approximate DST: March second Sunday to November first Sunday
    const year = date.getUTCFullYear();
    const marchSecondSunday = new Date(Date.UTC(year, 2, 8 + (7 - new Date(Date.UTC(year, 2, 1)).getUTCDay()) % 7, 7, 0, 0));
    const novFirstSunday = new Date(Date.UTC(year, 10, 1 + (7 - new Date(Date.UTC(year, 10, 1)).getUTCDay()) % 7, 6, 0, 0));

    const isDST = utcTime >= marchSecondSunday.getTime() && utcTime < novFirstSunday.getTime();
    const etOffset = isDST ? -4 : -5; // hours from UTC

    // Convert to ET by adding offset
    const etDate = new Date(utcTime + etOffset * 3600000);
    const etHour = etDate.getUTCHours();
    const etMinute = etDate.getUTCMinutes();
    const etDay = etDate.getUTCDay();

    // Weekend check (0 = Sunday, 6 = Saturday)
    if (etDay === 0 || etDay === 6) return false;

    const timeInMinutes = etHour * 60 + etMinute;

    // Market hours: 9:30 AM (570 mins) to 4:00 PM (960 mins) ET
    // On early close days, market closes at 1:00 PM (780 mins)
    const marketClose = isUSEarlyClose(date) ? 780 : 960;

    return timeInMinutes >= 570 && timeInMinutes < marketClose;
  };


  // BACKTEST: Load more candles when approaching end of buffer
  // Always loads minute data for proper partial candle display
  const loadMoreRetryRef = useRef(0);
  const loadMoreCandles = useCallback(async () => {
    if (isLoadingMore || !hasMoreData || !startDate || rawCandles.length === 0) return;
    setIsLoadingMore(true);
    const lastTimestamp = rawCandles[rawCandles.length - 1]?.timestamp;

    try {
      const fullTableName = formatPairForTable(pair);
      const data = await fetchWindowedCandles(fullTableName, {
        gt: lastTimestamp,
        limit: 30000,
        order: 'asc'
      });

      const newCandles: CandleData[] = (data || []).map((c: any) => ({
        timestamp: c.timestamp,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: c.volume != null ? Number(c.volume) : undefined
      }));

      if (newCandles.length === 0) {
        setHasMoreData(false);
      } else {
        loadMoreRetryRef.current = 0; // Reset retry counter on success
        // Computed from the closure value (rawCandles is in this callback's deps),
        // not a functional updater: the eviction accounting below is a side effect
        // and must run exactly once, while React may re-invoke updaters.
        const combined = [...rawCandles, ...newCandles];
        let next = combined;
        if (combined.length > MAX_RAW_CANDLES) {
          const kept = combined.slice(combined.length - MAX_RAW_CANDLES);
          const evicted = combined.slice(0, combined.length - MAX_RAW_CANDLES);
          // Evicting from the front moves every remaining candle's index down, so
          // the prepend-shift ledger ProChart follows must move down by the same
          // number of RENDERED candles or the viewport silently drifts forward
          // after the user scrolled back. Same display-bucket keying as the
          // scrollback prepend in loadMoreHistory; the seam bucket survives in the
          // kept range so it is not counted.
          const tfMin = timeframeToMinutes(timeframe);
          if (tfMin > 0 && kept.length > 0) {
            const bucketKey = (iso: string) => {
              const d = new Date(iso);
              return tfMin >= 1440
                ? new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
                : Math.floor(d.getTime() / (tfMin * 60_000)) * (tfMin * 60_000);
            };
            const gone = new Set<number>();
            for (const c of evicted) gone.add(bucketKey(c.timestamp));
            gone.delete(bucketKey(kept[0].timestamp));
            if (gone.size > 0) setHistoryPrependShift(p => Math.max(0, p - gone.size));
          }
          next = kept;
        }
        setRawCandles(next);
      }
    } catch (err) {
      console.error('[Backtest] Error loading more candles:', err);
      loadMoreRetryRef.current++;
      // Stop retrying after 3 failures to prevent infinite error spam
      if (loadMoreRetryRef.current >= 3) {
        setHasMoreData(false);
      }
    } finally {
      setIsLoadingMore(false);
    }
  }, [pair, startDate, rawCandles, timeframe, isLoadingMore, hasMoreData]);

  // INFINITE SCROLLBACK: Fetches 5K older candles when user scrolls to the left edge.
  // Called by ProChart via onLoadMore callback when startIndex < 50.
  // Handles all timeframe paths: raw 1m, HTF pre-aggregated tables, and RPC aggregation.
  // Prepends results to the candles array; ProChart detects the prepend and shifts viewState
  // so the visible chart doesn't jump. Stops at MAX_HISTORY_CANDLES (100K).
  const loadMoreHistory = useCallback(async () => {
    // Guard: skip if already loading, no more data, background phase-2
    // still running, or no info about which data source to query
    if (isLoadingMoreHistory || !hasMoreHistory || isBackgroundLoading) return;

    // BACKTEST MODE: scrolling to the left edge loads older bars into rawCandles.
    // This was fully disabled (early return on startDate), which left the replay
    // window as a hard wall: the user could not scroll back past the initially
    // loaded history to analyse what came before. Prepend a page of older bars;
    // the aggregation memos recompute from rawCandles so every timeframe view
    // extends backward together.
    if (startDate) {
      if (rawCandles.length === 0 || rawCandles.length >= MAX_HISTORY_CANDLES) return;
      const oldest = rawCandles[0].timestamp;
      setIsLoadingMoreHistory(true);
      try {
        const table = formatPairForTable(pair);
        const older = await fetchWindowedCandles(table, {
          lte: oldest,
          limit: 5001,
          order: 'asc'
        });
        // The inclusive lte bound re-returns the oldest bar we already hold.
        const fresh = older.filter(c => c.timestamp < oldest).map((c: any) => ({
          timestamp: c.timestamp,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: c.volume != null ? Number(c.volume) : undefined,
        }));
        if (fresh.length === 0) {
          setHasMoreHistory(false);
        } else {
          // ProChart's prependShift is measured in candles of the RENDERED array,
          // which is the tf-aggregated series, not raw bars. Counting raw bars here
          // overshifted the viewport by the aggregation ratio (5000 raw 1m bars are
          // only ~83 rendered 1H candles) and snapped the view outside the loaded
          // range. Count the distinct display buckets the fresh bars add, using the
          // same bucket keying as aggregateCandles (local midnight for >= 1D, epoch
          // floor otherwise), minus the seam bucket when it merges into the candle
          // we already render.
          const tfMin = timeframeToMinutes(shiftTimeframeRef.current);
          let shift = fresh.length;
          if (tfMin > 0) {
            const bucketKey = (iso: string) => {
              const d = new Date(iso);
              return tfMin >= 1440
                ? new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
                : Math.floor(d.getTime() / (tfMin * 60_000)) * (tfMin * 60_000);
            };
            const added = new Set<number>();
            for (const c of fresh) added.add(bucketKey(c.timestamp));
            if (added.has(bucketKey(oldest))) added.delete(bucketKey(oldest));
            shift = added.size;
          }
          setHistoryPrependShift(prev => prev + shift);
          setRawCandles(prev => [...fresh, ...prev]);
        }
      } catch (err) {
        console.error('[Backtest] Error loading older history:', err);
      } finally {
        setIsLoadingMoreHistory(false);
      }
      return;
    }

    if (!loadMoreInfoRef.current || loadMoreInfoRef.current.type === 'none') return;
    if (candles.length >= MAX_HISTORY_CANDLES) {
      setHasMoreHistory(false);
      return;
    }

    const info = loadMoreInfoRef.current;
    const oldestTimestamp = candles[0]?.timestamp;
    if (!oldestTimestamp) return;

    setIsLoadingMoreHistory(true);
    // 5k chunk size matches the phase-2 load size, so each scrollback
    // extends history by the same amount as the initial background load.
    const CHUNK_SIZE = 5000;

    try {
      let newCandles: CandleData[] = [];

      if (info.type === 'raw_1m') {
        // Raw 1m candles from per-symbol table (e.g. candles_btc_usd)
        const data = await api.getCandlesLt(info.tableName, oldestTimestamp, {
          limit: CHUNK_SIZE,
          order: 'desc',
          select: 'timestamp,open,high,low,close,volume'
        });
        newCandles = (data || []).reverse().map((c: any) => ({
          timestamp: c.timestamp,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: c.volume != null ? Number(c.volume) : undefined,
        }));
      } else if (info.type === 'htf') {
        // HTF pre-aggregated tables (candles_5m, candles_15m, candles_1h, candles_4h, candles_1d)
        // These have a symbol column, so we filter by symbol + timestamp < oldest
        const data = await api.getCandlesHTFBefore(info.tableName, info.symbol, oldestTimestamp, {
          limit: CHUNK_SIZE,
        });
        newCandles = (data || []).reverse().map((c: any) => ({
          timestamp: c.timestamp,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: c.volume != null ? Number(c.volume) : undefined,
        }));
      } else if (info.type === 'rpc') {
        // RPC aggregation path (custom timeframes like 2m, 3m, 6h, 23h, 90m)
        // Uses the p_before parameter we added to get_aggregated_candles
        const data = await api.rpc('get_aggregated_candles', {
          p_table_name: info.tableName,
          p_timeframe_minutes: info.tfMinutes,
          p_limit: CHUNK_SIZE,
          p_before: oldestTimestamp,
        });
        newCandles = (data || []).map((c: any) => ({
          timestamp: c.bucket_time,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: c.volume != null ? Number(c.volume) : undefined,
        }));
      }

      if (newCandles.length === 0) {
        // No more historical data available for this symbol/timeframe
        setHasMoreHistory(false);
        console.log('[Chart] No more history available, stopping scrollback');
      } else {
        loadMoreRetryCountRef.current = 0;
        // Increment the prepend shift counter BEFORE updating candles so ProChart
        // can shift viewState.startIndex by the delta to keep the view stable.
        setHistoryPrependShift(prev => prev + newCandles.length);
        // Prepend older candles to existing array.
        setCandles(prev => {
          const combined = [...newCandles, ...prev];
          // Cap at MAX_HISTORY_CANDLES to prevent unbounded memory growth
          if (combined.length >= MAX_HISTORY_CANDLES) {
            setHasMoreHistory(false);
            console.log(`[Chart] Reached ${MAX_HISTORY_CANDLES} candle cap, stopping scrollback`);
            // MUST slice from the RIGHT to preserve LIVE candles!
            return combined.slice(-MAX_HISTORY_CANDLES);
          }
          return combined;
        });
        console.log(`[Chart] Loaded ${newCandles.length} more candles (total: ${candles.length + newCandles.length})`);
      }
    } catch (err) {
      console.error('[Chart] Error loading more history:', err);
      loadMoreRetryCountRef.current++;
      // Stop after 3 consecutive failures to prevent infinite error spam
      if (loadMoreRetryCountRef.current >= 3) {
        setHasMoreHistory(false);
        console.warn('[Chart] Too many loadMore failures, stopping scrollback');
      }
    } finally {
      setIsLoadingMoreHistory(false);
    }
  }, [candles, rawCandles, pair, formatPairForTable, isLoadingMoreHistory, hasMoreHistory, startDate, isBackgroundLoading, timeframe]);

  const fetchCandleData = async (useProgressiveLoad = false) => {
    // Capture this fetch's generation. Phase-2 background loads use this to self-cancel
    // if the user switches timeframe/pair before the background fetch completes.
    const myGeneration = ++fetchGenerationRef.current;
    // Reset any in-progress background load indicator from a previous fetch
    setIsBackgroundLoading(false);
    // Reset infinite scrollback state when starting a fresh fetch (new pair or timeframe)
    setIsLoadingMoreHistory(false);
    setHasMoreHistory(true);
    setHistoryPrependShift(0);
    loadMoreInfoRef.current = null;
    loadMoreRetryCountRef.current = 0;

    // DISABLED: Cache-first approach was causing visual gaps due to incomplete cached data
    // Always fetch fresh data from API to ensure complete chart data
    // The cache is still updated after fetch for future use, but not trusted as primary source
    // if (!startDate) {
    //   const cached = getCachedData(pair, timeframe);
    //   if (cached && cached.length > 0) {
    //     setCandles(cached);
    //     setLoading(false);
    //     setLoadedTimeframe(timeframe);
    //     fetchFreshDataInBackground();
    //     return;
    //   }
    // }

    // Only show loading spinner on initial load, not periodic tick refreshes.
    // Tick refreshes call fetchCandleData silently to update candle data without blanking the chart.
    const isTickRefresh = parseTickCount(timeframe) > 0 && candles.length > 0;
    if (!isTickRefresh) {
      setLoading(true);
      setLoadedTimeframe('');
      setHasMoreData(true);
    }

    // SECOND TIMEFRAMES (1s, 5s, 10s, 30s): read pre-computed candles_Ns tables on S1.
    // Server-side aggregation written by tick-listener every 1s; pruner keeps 7-day
    // tail per symbol. Same shape as the 10tick/100tick/1000tick path below.
    const secondCount = parseSecondCount(timeframe);
    if (secondCount > 0) {
      try {
        const tickSymbol = formatPairForSymbol(pair);
        const tableName = `candles_${secondCount}s`;
        const data = await api.getTickCandles(tableName, tickSymbol, 5000);
        if (data && data.length > 0) {
          const candles: CandleData[] = data.reverse().map((c: any) => ({
            timestamp: c.ts,
            open: Number(c.open),
            high: Number(c.high),
            low: Number(c.low),
            close: Number(c.close),
            volume: c.volume != null ? Number(c.volume) : undefined,
          }));
          setCandles(candles);
          setLivePrice(candles[candles.length - 1]?.close || null);
        } else {
          setCandles([]);
        }
      } catch (err) {
        console.error('[Chart] Error fetching second candle data:', err);
        setCandles([]);
      } finally {
        setLoading(false);
        setLoadedTimeframe(timeframe);
      }
      return;
    }

    // TICK MODE: Two paths depending on aggregation level
    // - 10tick/100tick/1000tick: read from pre-computed server-side tables (candles_Nticks)
    //   These are maintained server-side from a recent-ticks store, pruned after 1 hour.
    //   Much more efficient than fetching raw ticks for client-side aggregation.
    // - tick/5tick: fetch raw ticks and aggregate client-side (data volume is small enough)
    const tickCount = parseTickCount(timeframe);
    if (tickCount > 0) {
      try {
        const tickSymbol = formatPairForSymbol(pair);

        // SERVER-SIDE TICK CANDLES: For 10tick, 100tick, and 1000tick, use pre-computed tables
        if (tickCount >= 10) {
          const tableName = `candles_${tickCount}ticks`;
          const data = await api.getTickCandles(tableName, tickSymbol, 5000);
          if (data && data.length > 0) {
            // Reverse since API returns desc order, we need asc for chart
            const candles: CandleData[] = data.reverse().map((c: any) => ({
              timestamp: c.ts,
              open: Number(c.open),
              high: Number(c.high),
              low: Number(c.low),
              close: Number(c.close),
              volume: c.volume != null ? Number(c.volume) : undefined
            }));
            setCandles(candles);
            setLivePrice(candles[candles.length - 1]?.close || null);
          } else {
            setCandles([]);
          }
        } else {
          // CLIENT-SIDE AGGREGATION: For tick/5tick, fetch raw ticks
          const data = await api.getTickHistory(tickSymbol, 5000);
          if (data && data.length > 0) {
            // Reverse since API returns desc order, we need asc for chart
            const rawTicks: CandleData[] = data.reverse().map((t: any) => ({
              timestamp: t.ts,
              // Map each tick as a pseudo-candle where OHLC all equal the trade price
              open: Number(t.price),
              high: Number(t.price),
              low: Number(t.price),
              close: Number(t.price),
              volume: t.volume != null ? Number(t.volume) : undefined
            }));

            // For N-tick candles (5tick, 10tick), aggregate raw ticks into candles
            // For 1-tick, pass through as-is (renders as line chart)
            const displayData = tickCount > 1
              ? aggregateTickCandles(rawTicks, tickCount)
              : rawTicks;

            setCandles(displayData);
            setLivePrice(rawTicks[rawTicks.length - 1]?.close || null);
          } else {
            setCandles([]);
          }
        }
      } catch (err) {
        console.error('[Chart] Error fetching tick data:', err);
        setCandles([]);
      } finally {
        setLoading(false);
        setLoadedTimeframe(timeframe);
      }
      return;
    }

    // Device-aware limits
    const TARGET_CANDLES = useProgressiveLoad ? getInitialLoadCount() : getOptimalCandleLimit();

    try {
      const tfMinutes = timeframeToMinutes(timeframe);
      const fullTableName = formatPairForTable(pair);

      // BACKTESTING MODE: Always load minute data for proper partial candle display
      // This ensures timeframe switching shows consistent data (e.g., 1m at 02:05 = 1H partial at 02:05)
      if (startDate) {
        const startDateObj = new Date(`${startDate}T${startTime}:00Z`);

        // ANCHORED AT THE REPLAY START, by BAR COUNT, not by minutes. The old
        // window was `start - 25000 minutes`, which assumed every dataset is
        // 1-minute data; on the hourly/daily sample parquets that window holds a
        // few hundred bars pinned at its left edge and the chart rendered a
        // squashed sliver. Walking backward from the start date returns the same
        // depth of context on any dataset interval, and guarantees the window
        // CONTAINS the replay point, so scrollback has real history behind it.
        console.log('[Backtest] Fetching', MAX_RAW_CANDLES, 'bars ending', startDateObj.toISOString(), 'from', fullTableName);
        const data = await fetchWindowedCandles(fullTableName, {
          lte: startDateObj.toISOString(),
          limit: MAX_RAW_CANDLES,
          order: 'asc'
        });

        const mapped: CandleData[] = (data || []).map((c: any) => ({
          timestamp: c.timestamp,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: c.volume != null ? Number(c.volume) : undefined
        }));

        setRawCandles(mapped);
        setLoadedResolution('minute'); // Always minute-resolution for backtesting
        backtestDataLoadedRef.current = true;
        const aggregated = tfMinutes > 1 ? aggregateCandles(mapped, tfMinutes) : mapped;
        setCandles(aggregated);
      } else {
        // LIVE CHART MODE


        // Helper function to fetch 15m data - PARALLEL queries for speed
        const fetch15mData = async (pairName: string, tfMins: number): Promise<CandleData[]> => {
          const isLargeTest = new URLSearchParams(window.location.search).get('largeCandleTest') === '1';
          const LIVE_TARGET = isLargeTest
            ? (tfMins === 15 ? 1000000 : Math.min((tfMins / 15) * 1000000, 5000000))
            : (tfMins === 15 ? 10000 : Math.min((tfMins / 15) * 10000, 40000));
          console.log(`[Chart] 15m fetch target: ${LIVE_TARGET.toLocaleString()} (test mode: ${isLargeTest})`);
          if (dataSource === 'oanda') return fetchOandaHtf('oanda_candles_15m', pairName, LIVE_TARGET);

          const symbolVariants = buildSymbolVariants(pairName);
          console.log('[Chart] 15m query symbols to try (parallel):', symbolVariants, 'from pair:', pairName);

          // Fire all queries in parallel, take first successful result
          const results = await Promise.allSettled(
            symbolVariants.map(symbolToTry =>
              api.getCandles15m(symbolToTry, { limit: LIVE_TARGET })
                .then(data => ({ symbol: symbolToTry, data }))
            )
          );

          // Find first successful result with data
          for (const result of results) {
            if (result.status === 'fulfilled' && result.value.data && result.value.data.length > 0) {
              console.log('[Chart] 15m data found with symbol:', result.value.symbol, 'count:', result.value.data.length);
              return mapCandleData(result.value.data);
            }
          }

          console.warn('[Chart] No 15m data found for any symbol variant');
          return [];
        };

        // Helper function to fetch 1h data - PARALLEL queries for speed
        const fetchHourlyData = async (pairName: string, tfMins: number): Promise<CandleData[]> => {
          const isLargeTest = new URLSearchParams(window.location.search).get('largeCandleTest') === '1';
          const LIVE_TARGET = isLargeTest
            ? (tfMins === 60 ? 1000000 : Math.min((tfMins / 60) * 1000000, 5000000))
            : (tfMins === 60 ? 10000 : Math.min((tfMins / 60) * 10000, 50000));
          console.log(`[Chart] 1H fetch target: ${LIVE_TARGET.toLocaleString()} (test mode: ${isLargeTest})`);
          if (dataSource === 'oanda') return fetchOandaHtf('oanda_candles_1h', pairName, LIVE_TARGET);

          const symbolVariants = buildSymbolVariants(pairName);
          console.log('[Chart] 1H query symbols to try (parallel):', symbolVariants, 'from pair:', pairName);

          // Fire all queries in parallel, take first successful result
          const results = await Promise.allSettled(
            symbolVariants.map(symbolToTry =>
              api.getCandles1h(symbolToTry, { limit: LIVE_TARGET })
                .then(data => ({ symbol: symbolToTry, data }))
            )
          );

          // Find first successful result with data
          for (const result of results) {
            if (result.status === 'fulfilled' && result.value.data && result.value.data.length > 0) {
              console.log('[Chart] 1H data found with symbol:', result.value.symbol, 'count:', result.value.data.length);
              return mapCandleData(result.value.data);
            }
          }

          console.warn('[Chart] No 1H data found for any symbol variant');
          return [];
        };

        // Fallback to raw 1m candles and aggregate
        const fallbackToRawCandles = async (tableName: string, tfMins: number, pairName: string, tf: string) => {
          console.log('[Chart] Falling back to raw candle aggregation');
          // TEST MODE: ?largeCandleTest=1 allows 1M candle loads for backtest quality testing
          const isLargeTest = new URLSearchParams(window.location.search).get('largeCandleTest') === '1';
          const rawLimit = isLargeTest ? Math.min(tfMins * 5000, 1000000) : Math.min(tfMins * 5000, 100000);
          console.log(`[Chart] Loading candles with limit: ${rawLimit.toLocaleString()} (test mode: ${isLargeTest})`);
          const data = await api.getCandles(tableName, {
            limit: rawLimit,
            order: 'desc',
            select: 'timestamp,open,high,low,close,volume'
          });

          const mapped: CandleData[] = (data || []).reverse().map((c: any) => ({
            timestamp: c.timestamp,
            open: Number(c.open),
            high: Number(c.high),
            low: Number(c.low),
            close: Number(c.close),
            volume: c.volume != null ? Number(c.volume) : undefined
          }));

          const aggregatedData = aggregateCandles(mapped, tfMins);
          setCandles(aggregatedData);
          setCachedData(pairName, tf, aggregatedData);
        };

        // LIVE CHART: Tiered aggregated tables for optimal performance
        // 1D+ (1440+ mins) -> candles_1d
        // 1H to 1D (60-1439 mins) -> candles_1h  
        // 15m to 1H (15-59 mins) -> candles_15m
        // 1m to 15m (1-14 mins) -> candles_xxx (raw 1m data)
        if (tfMinutes >= 1440) {
          // 1D, 1W, 1M timeframes: Use candles_1d table
          // PARALLEL queries for daily data
          const fetchDailyData = async (): Promise<CandleData[]> => {
            const LIVE_TARGET = Math.min((tfMinutes / 1440) * 5000, 10000);
            if (dataSource === 'oanda') return fetchOandaHtf('oanda_candles_1d', pair, LIVE_TARGET);

            const symbolVariants = buildSymbolVariants(pair);
            console.log('[Chart] 1D query symbols to try (parallel):', symbolVariants, 'from pair:', pair);


            // Fire all queries in parallel, take first successful result
            const results = await Promise.allSettled(
              symbolVariants.map(symbolToTry =>
                api.getCandles1d(symbolToTry, { limit: LIVE_TARGET })
                  .then(data => ({ symbol: symbolToTry, data }))
              )
            );

            // Find first successful result with data
            for (const result of results) {
              if (result.status === 'fulfilled' && result.value.data && result.value.data.length > 0) {
                console.log('[Chart] 1D data found with symbol:', result.value.symbol, 'count:', result.value.data.length);
                return result.value.data.reverse().map((c: any) => ({
                  timestamp: c.timestamp,
                  open: Number(c.open),
                  high: Number(c.high),
                  low: Number(c.low),
                  close: Number(c.close),
                  volume: c.volume != null ? Number(c.volume) : undefined
                }));
              }
            }

            console.warn('[Chart] No 1D data found for any symbol variant');
            return [];
          };

          try {
            let mapped = await fetchDailyData();

            if (mapped.length === 0) {
              // Fallback to candles_1h and aggregate
              console.log('[Chart] No 1D data found, falling back to 1H aggregation');
              mapped = await fetchHourlyData(pair, tfMinutes);
            }

            // If still no data, fall back to raw 1m candles
            if (mapped.length === 0) {
              console.log('[Chart] No 1H data found for 1D+, falling back to raw candle aggregation');
              await fallbackToRawCandles(fullTableName, tfMinutes, pair, timeframe);
              return;
            }


            // 1D candles come directly from candles_1d table
            // The repair service keeps them up-to-date every 15 minutes

            if (tfMinutes === 1440) {
              setCandles(mapped);
              setCachedData(pair, timeframe, mapped);
            } else if (timeframe === '1M') {
              // 1M: Use true calendar month aggregation (Jan 1-31, Feb 1-28, etc.)
              const aggregatedData = aggregateCandlesByMonth(mapped);
              setCandles(aggregatedData);
              setCachedData(pair, timeframe, aggregatedData);
            } else {
              // 1W: Aggregate daily candles (7 days per candle)
              const aggregatedData = aggregateCandles(mapped, tfMinutes / 1440);
              setCandles(aggregatedData);
              setCachedData(pair, timeframe, aggregatedData);
            }
            // Store for infinite scrollback: daily/weekly/monthly uses candles_1d table
            const dailySymbol = formatPairForSymbol(pair);
            loadMoreInfoRef.current = { type: 'htf', tableName: 'x_candles_1d', symbol: dailySymbol, tfMinutes };
          } catch (error) {
            console.warn('[Chart] Daily fetch failed:', error);
            await fallbackToRawCandles(fullTableName, tfMinutes, pair, timeframe);
          }
        }
        else if (tfMinutes >= 5) {
          // 5m, 15m, 30m, 1H, 4H timeframes: Use pre-aggregated tables
          // Map timeframe to table name (the FX/CFD source's tables carry its own prefix)
          const htfTableMap: Record<number, string> = dataSource === 'oanda' ? {
            5: 'oanda_candles_5m',
            15: 'oanda_candles_15m',
            30: 'oanda_candles_15m',  // 30m aggregated from 15m
            60: 'oanda_candles_1h',
            240: 'oanda_candles_4h',
          } : {
            5: 'x_candles_5m',
            15: 'x_candles_15m',
            30: 'x_candles_15m',
            60: 'x_candles_1h',
            240: 'x_candles_4h',
          };

          const htfTable = htfTableMap[tfMinutes];


          if (htfTable) {
            // PROGRESSIVE LOAD: HTF pre-aggregated tables (5m, 15m, 30m, 1h, 4h)
            // 3-phase strategy using timestamp-based pagination (no overlap, no re-downloading):
            //   Phase 1: 1k most recent candles, render immediately (~150ms)
            //   Phase 2: next 4k older candles, prepend in background (total 5k)
            //   Phase 3: next 5k older candles, prepend in background (total 10k)
            // Each phase fetches candles OLDER than the previous batch's oldest timestamp,
            // so no data is downloaded twice. Scrollback then fetches 5k chunks on demand.
            const symbol = formatPairForSymbol(pair);
            console.log('[Chart] Using pre-aggregated table:', htfTable, 'for symbol:', symbol);

            const mapHTF = (raw: any[]): CandleData[] =>
              (raw || []).reverse().map((c: any) => ({
                timestamp: c.timestamp,
                open: Number(c.open),
                high: Number(c.high),
                low: Number(c.low),
                close: Number(c.close),
                volume: c.volume != null ? Number(c.volume) : undefined,
              }));

            // Phase 1: 1k most recent candles for instant render
            const phase1Raw = await api.getCandlesHTF(htfTable, symbol, { limit: 1000 });
            const phase1 = mapHTF(phase1Raw);

            if (phase1.length === 0) {
              console.log('[Chart] No data in HTF table, falling back to RPC');
              await fallbackToRawCandles(fullTableName, tfMinutes, pair, timeframe);
              return;
            }

            // Render phase 1 immediately so user sees chart
            let accumulated = phase1;
            if (fetchGenerationRef.current === myGeneration) {
              setCandles(accumulated);
              setLoading(false);
              setLoadedTimeframe(timeframe);
              if (phase1.length >= 1000) {
                setIsBackgroundLoading(true);
              }
            }

            // Phase 2: fetch next 4k older candles (timestamp < oldest from phase 1)
            // No setHistoryPrependShift here: during initial load the auto-follow-latest
            // effect in ProChart keeps the view anchored to the right edge. prependShift
            // is only for scrollback when the user has manually scrolled left.
            if (phase1.length >= 1000) {
              const oldest1 = accumulated[0].timestamp;
              const phase2Raw = await api.getCandlesHTFBefore(htfTable, symbol, oldest1, { limit: 4000 });
              if (fetchGenerationRef.current !== myGeneration) return;
              const phase2 = mapHTF(phase2Raw);
              if (phase2.length > 0) {
                accumulated = [...phase2, ...accumulated];
                setCandles(accumulated);
              }

              // Phase 3: fetch next 5k older candles (timestamp < oldest from phase 2)
              if (phase2.length >= 4000) {
                const oldest2 = accumulated[0].timestamp;
                const phase3Raw = await api.getCandlesHTFBefore(htfTable, symbol, oldest2, { limit: 5000 });
                if (fetchGenerationRef.current !== myGeneration) return;
                const phase3 = mapHTF(phase3Raw);
                if (phase3.length > 0) {
                  accumulated = [...phase3, ...accumulated];
                  setCandles(accumulated);
                }
              }
              setCachedData(pair, timeframe, accumulated);
              setIsBackgroundLoading(false);
              loadMoreInfoRef.current = { type: 'htf', tableName: htfTable, symbol, tfMinutes };
            } else {
              // Fewer rows than 1k: no more history to fetch
              setCachedData(pair, timeframe, accumulated);
              loadMoreInfoRef.current = { type: 'htf', tableName: htfTable, symbol, tfMinutes };
            }
          } else {
            // PROGRESSIVE LOAD: Custom timeframe via RPC aggregation (e.g. 23H, 6H, 90m)
            // RPC aggregates from raw 1m candles server-side, so large p_limit is slow.
            // 3-phase with p_before pagination (no overlap):
            //   Phase 1: 300 candles (RPC is slow, 300 is enough for initial screen)
            //   Phase 2: next 700 older (total 1k)
            //   Phase 3: next 4k older (total 5k)
            console.log('[Chart] Custom timeframe, using RPC aggregation for', tfMinutes, 'min');

            const mapRPC = (raw: any[]): CandleData[] =>
              (raw || []).map((c: any) => ({
                timestamp: c.bucket_time,
                open: Number(c.open),
                high: Number(c.high),
                low: Number(c.low),
                close: Number(c.close),
                volume: c.volume != null ? Number(c.volume) : undefined,
              }));

            // Phase 1: 300 candles for instant render
            const rpcP1 = await api.rpc('get_aggregated_candles', {
              p_table_name: fullTableName,
              p_timeframe_minutes: tfMinutes,
              p_limit: 300,
            });
            let rpcAccum = mapRPC(rpcP1);

            if (fetchGenerationRef.current === myGeneration && rpcAccum.length > 0) {
              setCandles(rpcAccum);
              setLoading(false);
              setLoadedTimeframe(timeframe);
              if (rpcAccum.length >= 300) {
                setIsBackgroundLoading(true);
              }
            }

            // Phase 2: next 700 older candles (total ~1k)
            if (rpcAccum.length >= 300) {
              const rpcP2 = await api.rpc('get_aggregated_candles', {
                p_table_name: fullTableName,
                p_timeframe_minutes: tfMinutes,
                p_limit: 700,
                p_before: rpcAccum[0].timestamp,
              });
              if (fetchGenerationRef.current !== myGeneration) return;
              const rpcP2Mapped = mapRPC(rpcP2);
              if (rpcP2Mapped.length > 0) {
                rpcAccum = [...rpcP2Mapped, ...rpcAccum];
                setCandles(rpcAccum);
              }

              // Phase 3: next 4k older candles (total ~5k)
              if (rpcP2Mapped.length >= 700) {
                const rpcP3 = await api.rpc('get_aggregated_candles', {
                  p_table_name: fullTableName,
                  p_timeframe_minutes: tfMinutes,
                  p_limit: 4000,
                  p_before: rpcAccum[0].timestamp,
                });
                if (fetchGenerationRef.current !== myGeneration) return;
                const rpcP3Mapped = mapRPC(rpcP3);
                if (rpcP3Mapped.length > 0) {
                  rpcAccum = [...rpcP3Mapped, ...rpcAccum];
                  setCandles(rpcAccum);
                }
              }
              setCachedData(pair, timeframe, rpcAccum);
              setIsBackgroundLoading(false);
              loadMoreInfoRef.current = { type: 'rpc', tableName: fullTableName, symbol: '', tfMinutes };
            } else {
              setCachedData(pair, timeframe, rpcAccum);
              loadMoreInfoRef.current = { type: 'rpc', tableName: fullTableName, symbol: '', tfMinutes };
            }
          }
        }
        // PROGRESSIVE LOAD: 2m-4m timeframes via RPC aggregation from raw 1m candles
        // 3-phase with p_before pagination (no overlap, no re-downloading):
        //   Phase 1: 1k candles (instant render)
        //   Phase 2: next 4k older (total 5k)
        //   Phase 3: next 5k older (total 10k)
        else if (tfMinutes > 1) {
          const mapRPC = (raw: any[]): CandleData[] =>
            (raw || []).map((c: any) => ({
              timestamp: c.bucket_time,
              open: Number(c.open),
              high: Number(c.high),
              low: Number(c.low),
              close: Number(c.close),
              volume: c.volume != null ? Number(c.volume) : undefined,
            }));

          try {
            // Phase 1: 1k candles for instant render
            const p1Rpc = await api.rpc('get_aggregated_candles', {
              p_table_name: fullTableName,
              p_timeframe_minutes: tfMinutes,
              p_limit: 1000,
            });
            let rpcAccum = mapRPC(p1Rpc);

            if (fetchGenerationRef.current === myGeneration && rpcAccum.length > 0) {
              setCandles(rpcAccum);
              setLoading(false);
              setLoadedTimeframe(timeframe);
              if (rpcAccum.length >= 1000) {
                setIsBackgroundLoading(true);
              }
            }

            // Phase 2: next 4k older candles (total ~5k)
            if (rpcAccum.length >= 1000) {
              const p2Rpc = await api.rpc('get_aggregated_candles', {
                p_table_name: fullTableName,
                p_timeframe_minutes: tfMinutes,
                p_limit: 4000,
                p_before: rpcAccum[0].timestamp,
              });
              if (fetchGenerationRef.current !== myGeneration) return;
              const p2Mapped = mapRPC(p2Rpc);
              if (p2Mapped.length > 0) {
                rpcAccum = [...p2Mapped, ...rpcAccum];
                setCandles(rpcAccum);
              }

              // Phase 3: next 5k older candles (total ~10k)
              if (p2Mapped.length >= 4000) {
                const p3Rpc = await api.rpc('get_aggregated_candles', {
                  p_table_name: fullTableName,
                  p_timeframe_minutes: tfMinutes,
                  p_limit: 5000,
                  p_before: rpcAccum[0].timestamp,
                });
                if (fetchGenerationRef.current !== myGeneration) return;
                const p3Mapped = mapRPC(p3Rpc);
                if (p3Mapped.length > 0) {
                  rpcAccum = [...p3Mapped, ...rpcAccum];
                  setCandles(rpcAccum);
                }
              }
              setCachedData(pair, timeframe, rpcAccum);
              setIsBackgroundLoading(false);
              // Store for infinite scrollback: 2m-4m RPC aggregation path
              loadMoreInfoRef.current = { type: 'rpc', tableName: fullTableName, symbol: '', tfMinutes };
            } else {
              setCachedData(pair, timeframe, rpcAccum);
              loadMoreInfoRef.current = { type: 'rpc', tableName: fullTableName, symbol: '', tfMinutes };
            }
          } catch (rpcError) {
            console.warn('[Chart] RPC failed, falling back:', rpcError);

            // Fallback: raw 1m candles + client-side aggregation (no progressive load here,
            // this path is already a last resort and data volume is predictable)
            const rawLimit = Math.min(tfMinutes * 10000, 100000);
            const data = await api.getCandles(fullTableName, {
              limit: rawLimit,
              order: 'desc',
              select: 'timestamp,open,high,low,close,volume'
            });

            const mapped: CandleData[] = (data || []).reverse().map((c: any) => ({
              timestamp: c.timestamp,
              open: Number(c.open),
              high: Number(c.high),
              low: Number(c.low),
              close: Number(c.close),
              volume: c.volume != null ? Number(c.volume) : undefined
            }));
            const aggregatedData = aggregateCandles(mapped, tfMinutes);
            setCandles(aggregatedData);
            setCachedData(pair, timeframe, aggregatedData);
          }
        } else {
          // PROGRESSIVE LOAD: 1-minute timeframe, raw candles from per-asset table
          // 3-phase with timestamp pagination (no overlap, no re-downloading):
          //   Phase 1: 1k most recent (instant render)
          //   Phase 2: next 4k older (total 5k)
          //   Phase 3: next 5k older (total 10k)
          const mapRaw = (raw: any[]): CandleData[] =>
            (raw || []).reverse().map((c: any) => ({
              timestamp: c.timestamp,
              open: Number(c.open),
              high: Number(c.high),
              low: Number(c.low),
              close: Number(c.close),
              volume: c.volume != null ? Number(c.volume) : undefined,
            }));

          // Phase 1: 1k most recent candles for instant render
          const rawP1 = await api.getCandlesRange(fullTableName, {
            limit: 1000,
            order: 'desc',
            select: 'timestamp,open,high,low,close,volume'
          });
          let rawAccum = mapRaw(rawP1);

          if (fetchGenerationRef.current === myGeneration && rawAccum.length > 0) {
            setCandles(rawAccum);
            setLoading(false);
            setLoadedTimeframe(timeframe);
            if (rawAccum.length >= 1000) {
              setIsBackgroundLoading(true);
            }
          }

          // Phase 2: next 4k older candles (total ~5k)
          // No setHistoryPrependShift during initial load: auto-follow-latest in ProChart
          // keeps the view at the right edge. prependShift is only for user-initiated scrollback.
          if (rawAccum.length >= 1000) {
            const oldest1 = rawAccum[0].timestamp;
            const rawP2 = await api.getCandlesLt(fullTableName, oldest1, {
              limit: 4000,
              order: 'desc',
              select: 'timestamp,open,high,low,close,volume'
            });
            if (fetchGenerationRef.current !== myGeneration) return;
            const rawP2Mapped = mapRaw(rawP2);
            if (rawP2Mapped.length > 0) {
              rawAccum = [...rawP2Mapped, ...rawAccum];
              setCandles(rawAccum);
            }

            // Phase 3: next 5k older candles (total ~10k)
            if (rawP2Mapped.length >= 4000) {
              const oldest2 = rawAccum[0].timestamp;
              const rawP3 = await api.getCandlesLt(fullTableName, oldest2, {
                limit: 5000,
                order: 'desc',
                select: 'timestamp,open,high,low,close,volume'
              });
              if (fetchGenerationRef.current !== myGeneration) return;
              const rawP3Mapped = mapRaw(rawP3);
              if (rawP3Mapped.length > 0) {
                rawAccum = [...rawP3Mapped, ...rawAccum];
                setCandles(rawAccum);
              }
            }
            setCachedData(pair, timeframe, rawAccum);
            setIsBackgroundLoading(false);
            // Store for infinite scrollback: raw 1m candle path
            loadMoreInfoRef.current = { type: 'raw_1m', tableName: fullTableName, symbol: '', tfMinutes: 1 };
          } else {
            setCachedData(pair, timeframe, rawAccum);
            loadMoreInfoRef.current = { type: 'raw_1m', tableName: fullTableName, symbol: '', tfMinutes: 1 };
          }
        }
      }
    } catch (err) {
      console.error("Error fetching candle data:", err);
      setCandles([]);
    } finally {
      setLoading(false);
      setLoadedTimeframe(timeframe);
      isInitialLoadRef.current = false;
    }
  };

  // Background fetch for updating cache while showing cached data
  const fetchFreshDataInBackground = async () => {
    const tfMinutes = timeframeToMinutes(timeframe);
    const fullTableName = formatPairForTable(pair);
    const TARGET_CANDLES = getOptimalCandleLimit();

    try {
      if (tfMinutes >= 60) {
        const symbol = formatPairForSymbol(pair);
        // Use pre-aggregated tables for 1h and 4h
        const htfTableMap: Record<number, string> = {
          60: 'x_candles_1h',
          240: 'x_candles_4h',
        };
        const htfTable = htfTableMap[tfMinutes];

        if (htfTable) {
          const data = await api.getCandlesHTF(htfTable, symbol, { limit: TARGET_CANDLES });
          if (data && data.length > 0) {
            const mapped: CandleData[] = data.reverse().map((c: any) => ({
              timestamp: c.timestamp,
              open: Number(c.open),
              high: Number(c.high),
              low: Number(c.low),
              close: Number(c.close),
              volume: c.volume != null ? Number(c.volume) : undefined
            }));
            setCandles(mapped);
            setCachedData(pair, timeframe, mapped);
          }
        } else if (tfMinutes === 60) {
          const data = await api.rpc('get_1h_candles_live', {
            p_table_name: fullTableName,
            p_symbol: symbol,
            p_limit: TARGET_CANDLES
          });
          if (data) {
            const mapped: CandleData[] = data.map((c: any) => ({
              timestamp: c.bucket_time,
              open: Number(c.open),
              high: Number(c.high),
              low: Number(c.low),
              close: Number(c.close),
              volume: c.volume != null ? Number(c.volume) : undefined
            }));
            setCandles(mapped);
            setCachedData(pair, timeframe, mapped);
          }
        }
      } else if (tfMinutes >= 5) {
        // Use pre-aggregated HTF tables for 5m, 15m, 30m
        const symbol = formatPairForSymbol(pair);
        const htfTableMap: Record<number, string> = {
          5: 'x_candles_5m',
          15: 'x_candles_15m',
          30: 'x_candles_15m',
        };
        const htfTable = htfTableMap[tfMinutes];

        if (htfTable) {
          const data = await api.getCandlesHTF(htfTable, symbol, { limit: TARGET_CANDLES });
          if (data && data.length > 0) {
            const mapped: CandleData[] = data.reverse().map((c: any) => ({
              timestamp: c.timestamp,
              open: Number(c.open),
              high: Number(c.high),
              low: Number(c.low),
              close: Number(c.close),
              volume: c.volume != null ? Number(c.volume) : undefined
            }));
            setCandles(mapped);
            setCachedData(pair, timeframe, mapped);
          }
        } else {
          // Fallback to RPC for custom timeframes
          const data = await api.rpc('get_aggregated_candles', {
            p_table_name: fullTableName,
            p_timeframe_minutes: tfMinutes,
            p_limit: TARGET_CANDLES
          });
          if (data) {
            const mapped: CandleData[] = data.map((c: any) => ({
              timestamp: c.bucket_time,
              open: Number(c.open),
              high: Number(c.high),
              low: Number(c.low),
              close: Number(c.close),
              volume: c.volume != null ? Number(c.volume) : undefined
            }));
            setCandles(mapped);
            setCachedData(pair, timeframe, mapped);
          }
        }
      } else if (tfMinutes > 1) {
        // Custom timeframes (2m, 3m, 4m) - use RPC aggregation
        const data = await api.rpc('get_aggregated_candles', {
          p_table_name: fullTableName,
          p_timeframe_minutes: tfMinutes,
          p_limit: TARGET_CANDLES
        });
        if (data) {
          const mapped: CandleData[] = data.map((c: any) => ({
            timestamp: c.bucket_time,
            open: Number(c.open),
            high: Number(c.high),
            low: Number(c.low),
            close: Number(c.close),
            volume: c.volume != null ? Number(c.volume) : undefined
          }));
          setCandles(mapped);
          setCachedData(pair, timeframe, mapped);
        }
      }
    } catch (err) {
      // Silent fail - we already have cached data showing
      console.debug('[Chart] Background fetch failed:', err);
    }
  };


  // WebSocket live tick subscription (only for non-backtest mode and when not using external candles)
  const symbol = formatPairForSymbol(pair);
  const { tick: wsTick, isConnected: wsConnected } = useLiveTick(symbol, !startDate && !externalRawCandles);

  // Get timeframe in minutes for live candle hook
  const tfMinutes = useMemo(() => timeframeToMinutes(timeframe), [timeframe]);

  // Use the new clean live candle formation hook
  const {
    liveCandle,
    completedCandlesVersion,
    getCompletedCandlesMap,
    processTick,
    initializeFromHistory,
    reset: resetLiveCandle,
    hardReset: hardResetLiveCandle
  } = useLiveCandleFromTicks({
    timeframeMinutes: tfMinutes,
    enabled: !startDate && !externalRawCandles,
    pair // Pass pair for storage key
  });

  // TICK MODE: Track whether we're in any tick-based timeframe
  const tickCount = useMemo(() => parseTickCount(timeframe), [timeframe]);
  const isTickMode = tickCount > 0;

  // SECOND MODE: Track whether we're in a second-based timeframe (1s, 5s, etc.)
  const secondCount = useMemo(() => parseSecondCount(timeframe), [timeframe]);
  const isSecondMode = secondCount > 0;

  // Accumulator for building N-tick candles from live WebSocket data
  // Stores raw ticks until we have enough to form one candle
  const tickAccumulatorRef = useRef<CandleData[]>([]);

  // Reset accumulator when timeframe changes
  useEffect(() => {
    tickAccumulatorRef.current = [];
  }, [timeframe]);

  // Process incoming WebSocket ticks through the new hook
  useEffect(() => {
    if (!wsTick || startDate) return;

    // Reject stale ticks (>60s old) to prevent distorted live candles
    // from WS server sending cached prices during reconnect
    const tickAgeMs = Date.now() - (wsTick.ts * 1000);
    if (tickAgeMs > 60000) return;

    // Update live price display
    setLivePrice(wsTick.price);

    // SECOND MODE (1s, 5s, 10s, 30s): Build candles by time-window using wall-clock time
    if (isSecondMode) {
      const nowMs = Date.now();
      const bucketMs = secondCount * 1000;
      const currentBucket = Math.floor(nowMs / bucketMs) * bucketMs;

      setCandles(prev => {
        const updated = [...prev];
        const lastCandle = updated.length > 0 ? updated[updated.length - 1] : null;
        const lastBucket = lastCandle ? Math.floor(new Date(lastCandle.timestamp).getTime() / bucketMs) * bucketMs : -1;

        if (lastBucket === currentBucket && lastCandle) {
          // Same bucket: update OHLC in place
          updated[updated.length - 1] = {
            ...lastCandle,
            high: Math.max(lastCandle.high, wsTick.price),
            low: Math.min(lastCandle.low, wsTick.price),
            close: wsTick.price,
          };
        } else {
          // New bucket: append new candle
          updated.push({
            timestamp: new Date(currentBucket).toISOString(),
            open: wsTick.price,
            high: wsTick.price,
            low: wsTick.price,
            close: wsTick.price,
          });
        }
        return updated.length > 5000 ? updated.slice(-5000) : updated;
      });
      return;
    }

    // TICK MODE: Handle raw and N-tick candle formation
    if (isTickMode) {
      // 100tick/1000tick: Skip WS candle building entirely.
      // These use server-side pre-computed tables with periodic refresh.
      // 10tick uses server-side tables for HISTORY but still builds the forming
      // candle via WS for real-time feel (handled in the tickCount > 1 block below).
      if (tickCount >= 100) {
        return;
      }

      // 5tick/10tick: Build candles in real-time from WS ticks.
      // Show the actively forming candle by updating the last element in the
      // candles array on every tick, appending a new candle when the accumulator resets.
      if (tickCount > 1) {
        const acc = tickAccumulatorRef.current;
        const tickPoint: CandleData = {
          timestamp: new Date(wsTick.ts * 1000).toISOString(),
          open: wsTick.price,
          high: wsTick.price,
          low: wsTick.price,
          close: wsTick.price,
          volume: (wsTick as any).volume ?? 0,
        };
        acc.push(tickPoint);

        // Derive current forming candle from all accumulated ticks
        const open = acc[0].open;
        const close = acc[acc.length - 1].close;
        let high = -Infinity;
        let low = Infinity;
        let vol = 0;
        for (const t of acc) {
          if (t.high > high) high = t.high;
          if (t.low < low) low = t.low;
          vol += (t.volume ?? 0);
        }

        const formingCandle: CandleData = {
          timestamp: acc[acc.length - 1].timestamp,
          open, high, low, close,
          volume: vol || undefined,
        };

        setCandles(prev => {
          const updated = [...prev];
          if (acc.length === 1) {
            // First tick in the new N-tick bucket: start a strictly new candle
            updated.push(formingCandle);
          } else if (updated.length > 0) {
            // Ticks 2..N: update the currently forming candle
            updated[updated.length - 1] = formingCandle;
          } else {
            updated.push(formingCandle);
          }
          return updated.length > 5000 ? updated.slice(-5000) : updated;
        });

        // When bucket is full, reset so the next tick starts a new candle
        if (acc.length >= tickCount) {
          tickAccumulatorRef.current = [];
        }
        return;
      }

      // 1-tick mode: append each trade directly as a line chart point
      const newPoint: CandleData = {
        timestamp: new Date(wsTick.ts * 1000).toISOString(),
        open: wsTick.price,
        high: wsTick.price,
        low: wsTick.price,
        close: wsTick.price,
      };
      setCandles(prev => {
        const updated = [...prev, newPoint];
        return updated.length > 5000 ? updated.slice(-5000) : updated;
      });
      return;
    }

    // Process tick through the clean candle formation logic
    processTick({
      price: wsTick.price,
      ts: wsTick.ts
    });
  }, [wsTick, startDate, processTick, isTickMode, tickCount, isSecondMode, secondCount]);

  // Initialize live candle formation when historical data loads
  useEffect(() => {
    if (startDate || candles.length === 0) return;

    const lastCandle = candles[candles.length - 1];
    const lastTime = new Date(lastCandle.timestamp).getTime();
    initializeFromHistory(lastCandle.close, lastTime);
  }, [candles.length, startDate, initializeFromHistory]);

  // RECONNECT CATCH-UP: When WS reconnects after a gap, re-fetch the latest
  // candles from DB to bridge any completed candles missed during disconnection.
  const prevWsConnectedRef = useRef<boolean>(false);
  useEffect(() => {
    if (startDate) return; // Only in live mode
    const wasConnected = prevWsConnectedRef.current;
    prevWsConnectedRef.current = wsConnected;

    // Only act on false -> true transition (reconnect event)
    if (!wasConnected && wsConnected && candles.length > 0) {
      const tfMinutes = timeframeToMinutes(timeframe);
      const fullTableName = formatPairForTable(pair);

      // Fetch latest 50 raw 1m candles and merge into existing state
      const catchUp = async () => {
        try {
          if (tfMinutes >= 5) {
            // For aggregated timeframes, fetch from the appropriate HTF table
            const htfTableMap: Record<number, string> = {
              5: 'x_candles_5m', 15: 'x_candles_15m', 30: 'x_candles_15m',
              60: 'x_candles_1h', 240: 'x_candles_4h',
            };
            const htfTable = htfTableMap[tfMinutes];
            if (htfTable) {
              const symbol = formatPairForSymbol(pair);
              const data = await api.getCandlesHTF(htfTable, symbol, { limit: 50 });
              if (data && data.length > 0) {
                const fresh: CandleData[] = data.reverse().map((c: any) => ({
                  timestamp: c.timestamp,
                  open: Number(c.open), high: Number(c.high),
                  low: Number(c.low), close: Number(c.close),
                  volume: c.volume != null ? Number(c.volume) : undefined
                }));
                setCandles(prev => mergeCandles(prev, fresh));
              }
            }
          } else {
            // For 1m (and sub-5m) fetch raw candles
            const data = await api.getCandlesRange(fullTableName, {
              limit: 50, order: 'desc',
              select: 'timestamp,open,high,low,close,volume'
            });
            if (data && data.length > 0) {
              const fresh: CandleData[] = data.reverse().map((c: any) => ({
                timestamp: c.timestamp,
                open: Number(c.open), high: Number(c.high),
                low: Number(c.low), close: Number(c.close),
                volume: c.volume != null ? Number(c.volume) : undefined
              }));
              setCandles(prev => mergeCandles(prev, fresh));
            }
          }
        } catch {
          // Silent fail, we still have the old data
        }
      };
      catchUp();
    }
  }, [wsConnected, startDate, candles.length, timeframe, pair]);

  // Reset live candle when pair or timeframe changes
  // The reset() function already clears completedCandles array
  useEffect(() => {
    resetLiveCandle();
    setLivePrice(null);
  }, [pair, timeframe, resetLiveCandle]);

  // Main data fetch effect with debouncing for rapid timeframe changes
  useEffect(() => {
    // If external raw candles provided (multi-panel sync / L3 replay), use them directly - skip fetching
    if (externalRawCandles && externalRawCandles.length > 0) {
      setRawCandles(externalRawCandles);
      setCandles(externalRawCandles); // Also set display candles for live-mode aggregation path
      backtestDataLoadedRef.current = true;
      setLoading(false);
      setLoadedTimeframe(timeframe);
      return;
    }

    // Wait for symbol table map to be loaded before fetching to ensure correct table name resolution
    if (!tableMapLoaded) return;

    // In backtest mode, ALWAYS use minute data for proper partial candle display
    // This ensures that when viewing 1H at 02:05, we see partial data up to 02:05
    // Previously we used hourly data for 1H+ which couldn't show partial candles
    const neededResolution = 'minute'; // Always use minute data for backtesting

    // Use the tracked loadedResolution state instead of detecting from data
    const dataMatchesTimeframeCategory = loadedResolution === neededResolution;

    console.log('[Chart Debug] TF:', timeframe, 'loadedRes:', loadedResolution,
      'neededRes:', neededResolution, 'matches:', dataMatchesTimeframeCategory,
      'rawLen:', rawCandles.length, 'loaded:', backtestDataLoadedRef.current);

    // If data matches what we need and is already loaded, skip fetching
    if (startDate && backtestDataLoadedRef.current && rawCandles.length > 0 && dataMatchesTimeframeCategory) {
      setLoadedTimeframe(timeframe);
      setLoading(false);
      return;
    }

    // Reset if resolution doesn't match - need to refetch
    if (startDate && loadedResolution !== null && !dataMatchesTimeframeCategory) {
      console.log('[Chart] Resolution mismatch! Refetching. Need:', neededResolution, 'Have:', loadedResolution);
      backtestDataLoadedRef.current = false;
      setLoadedResolution(null); // Clear resolution state
      setRawCandles([]); // Clear stale data immediately
    }

    // Clear any pending fetch timeout (debounce rapid changes)
    if (fetchTimeoutRef.current) {
      clearTimeout(fetchTimeoutRef.current);
    }

    // Debounce: wait 50ms before fetching to avoid multiple rapid fetches
    fetchTimeoutRef.current = setTimeout(() => {
      setLivePrice(null);
      fetchCandleData();
    }, isInitialLoadRef.current ? 0 : 50); // No delay on initial load

    // 10tick/100tick/1000tick: periodic re-fetch from server-side pre-computed tables.
    // These modes use PostgreSQL trigger-built candles, so we poll every 5 seconds
    // to pick up newly completed candles. The WS handler still shows the forming
    // candle in real-time between refreshes for 10tick.
    // 5tick gets real-time updates via WS candle building only (no server table).
    // 1-tick mode appends live points directly via WS (no refresh needed).
    const tickCountForRefresh = parseTickCount(timeframe);
    let tickRefreshInterval: ReturnType<typeof setInterval> | null = null;
    if (tickCountForRefresh >= 10) {
      tickRefreshInterval = setInterval(() => {
        fetchCandleData();
      }, 5000);
    }

    return () => {
      if (fetchTimeoutRef.current) {
        clearTimeout(fetchTimeoutRef.current);
      }
      // Clean up tick refresh interval when timeframe changes or component unmounts
      if (tickRefreshInterval) {
        clearInterval(tickRefreshInterval);
      }
    };
  }, [pair, timeframe, startDate, loadedResolution, externalRawCandles, tableMapLoaded]);

  // Aggregated candles for display
  // Stage 1: Pre-compute raw candle timestamps for fast binary search during playback
  // For backtesting: stores RAW candle data (1-min resolution) + Float64Array timestamps
  // Partial aggregation happens in Stage 2 so higher-TF candles form minute-by-minute
  const preComputed = useMemo(() => {
    if (!startDate || rawCandles.length === 0) return null;
    const tfMinutes = timeframeToMinutes(timeframe);

    // Detect source data resolution
    let sourceMinutes = 1;
    if (rawCandles.length > 1) {
      const t0 = new Date(rawCandles[0].timestamp).getTime();
      const t1 = new Date(rawCandles[1].timestamp).getTime();
      sourceMinutes = Math.round((t1 - t0) / 60000);
    }

    // Pre-compute numeric timestamps on RAW candles for O(1) binary search
    const rawTimestamps = new Float64Array(rawCandles.length);
    for (let i = 0; i < rawCandles.length; i++) {
      rawTimestamps[i] = new Date(rawCandles[i].timestamp).getTime();
    }

    return { rawTimestamps, sourceMinutes, tfMinutes };
  }, [rawCandles, timeframe, startDate]);

  // Stage 2: aggregated, partial aggregation of raw candles up to replay timestamp
  // In backtest mode: aggregates raw 1m candles into HTF candles with partial last candle
  // This makes higher-TF candles (15m, 1H, 4H) form minute-by-minute during playback
  // In live mode: aggregates from the live candle stream
  const aggregated = useMemo(() => {
    // Backtest mode: use aggregateCandlesPartial for forming candles
    if (startDate && preComputed && rawCandles.length > 0) {
      const upToTs = replayTimestamp
        || `${startDate}T${startTime || '00:00'}:00Z`;
      const { sourceMinutes, tfMinutes } = preComputed;

      // If source is already at or above target resolution, just slice
      if (sourceMinutes >= tfMinutes) {
        const upToMs = new Date(upToTs).getTime();
        const ts = preComputed.rawTimestamps;
        let lo = 0, hi = ts.length - 1, cutoff = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >>> 1;
          if (ts[mid] <= upToMs) { cutoff = mid; lo = mid + 1; }
          else { hi = mid - 1; }
        }
        if (cutoff < 0) return [];
        return rawCandles.slice(0, cutoff + 1);
      }

      // Source is finer (e.g., 1m raw -> 15m display): use partial aggregation
      // This produces completed buckets + a forming last candle
      return aggregateCandlesPartial(rawCandles, tfMinutes, upToTs, sourceMinutes);
    }
    // Live mode
    const tfMinutes = timeframeToMinutes(timeframe);
    // TICK MODE: Skip aggregation, tick data is already in display-ready form
    // (raw ticks for 1-tick, or N-tick candles aggregated during fetch)
    // aggregateCandles(candles, 0) would cause division by zero (bucketMs = 0)
    if (tfMinutes === 0) return candles;
    return aggregateCandles(candles, tfMinutes);
  }, [candles, rawCandles, preComputed, timeframe, pair, startDate, startTime, replayTimestamp]);

  // Notify parent with candle data (for backtesting)
  // Send RAW timestamps for boundary checking: these contain all available data including "future" candles
  useEffect(() => {
    if (!onReplayDataReady || !startDate || rawCandles.length === 0) return;
    const timestamps = rawCandles.map(c => c.timestamp);
    onReplayDataReady(rawCandles.length, timestamps);
  }, [rawCandles.length, onReplayDataReady, startDate]);

  // Live mode: notify parent when aggregated data changes
  useEffect(() => {
    if (!onReplayDataReady || startDate) return;
    if (aggregated.length === 0 || loadedTimeframe !== timeframe) return;
    const timestamps = aggregated.map(c => c.timestamp);
    onReplayDataReady(aggregated.length, timestamps);
  }, [aggregated.length, onReplayDataReady, loadedTimeframe, timeframe, startDate]);

  // Export raw candles to parent for multi-panel sharing
  useEffect(() => {
    if (onRawCandlesReady && rawCandles.length > 0 && !externalRawCandles) {
      onRawCandlesReady(rawCandles);
    }
  }, [rawCandles, onRawCandlesReady, externalRawCandles]);


  // Auto-load more data for backtest sliding window
  useEffect(() => {
    if (!startDate || !replayTimestamp || rawCandles.length === 0 || isLoadingMore || !hasMoreData) return;
    if (!preComputed) return;
    const currentTs = new Date(replayTimestamp).getTime();
    const ts = preComputed.rawTimestamps;
    // Binary search for first candle after current position
    let lo = 0, hi = ts.length - 1, firstAfter = ts.length;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (ts[mid] > currentTs) { firstAfter = mid; hi = mid - 1; }
      else { lo = mid + 1; }
    }
    const remainingCandles = ts.length - firstAfter;
    if (remainingCandles < 5000 && hasMoreData) {
      loadMoreCandles();
    }
  }, [replayTimestamp, rawCandles, startDate, isLoadingMore, hasMoreData, loadMoreCandles, preComputed]);

  // Chart candles: the array passed to ProChart for rendering
  // In backtest mode, derives from `aggregated` (which uses partial aggregation)
  const chartCandles = useMemo(() => {
    // Backtest mode: convert aggregated (partial) candles to chart format
    if (startDate && preComputed) {
      let lastTime = 0;
      return aggregated.map(c => {
        let t = new Date(c.timestamp).getTime();
        // Force strictly ascending timestamps to prevent Lightweight Charts crash
        if (t <= lastTime) t = lastTime + 1;
        lastTime = t;
        return {
          time: t,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: c.volume
        };
      });
    }

    // Live mode: convert aggregated candles to chart format
    let lastTime = 0;
    const mapped = aggregated.map(c => {
      let t = new Date(c.timestamp).getTime();
      // Force strictly ascending timestamps to prevent Lightweight Charts crash
      if (t <= lastTime) t = lastTime + 1;
      lastTime = t;
      return {
        time: t,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: c.volume
      };
    });

    // TICK MODE: Skip live candle merge since each ws tick is appended directly
    // to the candles array in the useEffect above
    if (isTickMode) {
      return mapped;
    }

    // Merge tick-formed completed candles AND current live candle
    const tickFormedMap = getCompletedCandlesMap();
    const tickFormedCandles = Array.from(tickFormedMap.values());
    return mergeLiveCandleWithHistory(mapped, liveCandle, tickFormedCandles);
  }, [aggregated, liveCandle, startDate, startTime, preComputed, replayTimestamp, completedCandlesVersion, getCompletedCandlesMap]);

  // Export aggregated chart candles (numeric time matching converter)
  // for drawing overlay long/short TP/SL hit detection
  useEffect(() => {
    if (onChartCandlesReady && chartCandles.length > 0) {
      onChartCandlesReady(chartCandles);
    }
  }, [chartCandles, onChartCandlesReady]);

  // Price update callback, sends close/high/low to parent for SL/TP wick checking
  // For backtesting: scans ALL raw candles between previous and current timestamp
  // to ensure SL/TP triggers even when stepping over multiple candles at high speed
  const prevReplayTimestampRef = useRef<string | null>(null);

  useEffect(() => {
    if (!onPriceUpdate) return;

    if (startDate && rawCandles.length > 0 && replayTimestamp) {
      const currentTs = new Date(replayTimestamp).getTime();
      const prevTs = prevReplayTimestampRef.current
        ? new Date(prevReplayTimestampRef.current).getTime()
        : currentTs;

      // Binary search on raw candles for the stepped range
      // Using rawCandles directly (not preComputed) since raw = 1min granularity for accurate SL/TP
      let lo = 0, hi = rawCandles.length - 1, rangeStart = rawCandles.length;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const midTs = new Date(rawCandles[mid].timestamp).getTime();
        if (midTs > prevTs) { rangeStart = mid; hi = mid - 1; }
        else { lo = mid + 1; }
      }
      lo = rangeStart; hi = rawCandles.length - 1;
      let rangeEnd = rangeStart - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const midTs = new Date(rawCandles[mid].timestamp).getTime();
        if (midTs <= currentTs) { rangeEnd = mid; lo = mid + 1; }
        else { hi = mid - 1; }
      }

      if (rangeEnd >= rangeStart) {
        let rangeHigh = -Infinity, rangeLow = Infinity;
        for (let i = rangeStart; i <= rangeEnd; i++) {
          const h = Number(rawCandles[i].high);
          const l = Number(rawCandles[i].low);
          if (h > rangeHigh) rangeHigh = h;
          if (l < rangeLow) rangeLow = l;
        }
        // Use the DISPLAYED chart candle's close for the fill price so it matches
        // what the user visually sees (the blue price tag on Y-axis).
        // Raw candle high/low are still used for accurate SL/TP wick checking.
        const closePrice = chartCandles.length > 0
          ? chartCandles[chartCandles.length - 1].close
          : Number(rawCandles[rangeEnd].close);
        onPriceUpdate(closePrice, rangeHigh, rangeLow);
      } else if (chartCandles.length > 0) {
        const lastCandle = chartCandles[chartCandles.length - 1];
        onPriceUpdate(lastCandle.close, lastCandle.high, lastCandle.low);
      }

      prevReplayTimestampRef.current = replayTimestamp;
    } else if (chartCandles.length > 0) {
      const lastCandle = chartCandles[chartCandles.length - 1];
      onPriceUpdate(lastCandle.close, lastCandle.high, lastCandle.low);
    }
  }, [chartCandles, rawCandles, onPriceUpdate, startDate, replayTimestamp]);

  // Stats callback
  useEffect(() => {
    const cb = onStatsRef.current;
    if (!cb) return;
    const last = aggregated[aggregated.length - 1];
    const price = livePrice ?? (last ? Number(last.close) : null);
    let dayChange = 0;
    if (price && aggregated.length > 0) {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const todayStart = today.getTime();
      const todayOpenCandle = aggregated.find(c => new Date(c.timestamp).getTime() >= todayStart);
      if (todayOpenCandle) {
        dayChange = (price - Number(todayOpenCandle.open)) / Number(todayOpenCandle.open) * 100;
      }
    }
    cb({
      count: aggregated.length,
      price,
      time: Date.now(),
      dayChange,
      countdown
    });
  }, [aggregated, livePrice, countdown]);
  useEffect(() => {
    onStatsRef.current = onStats;
  }, [onStats]);

  // Countdown timer (disabled in tick mode since ticks have no candle-close concept)
  useEffect(() => {
    if (startDate || isTickMode) return; // No countdown in backtest or tick mode

    const updateCountdown = () => {
      const now = Date.now();

      // Check if market is open for this pair
      if (!isMarketOpenForPair(pair, now)) {
        setCountdown(''); // Clear countdown when market is closed
        return;
      }

      const msPerCandle = timeframeToMinutes(timeframe) * 60000;
      const nextClose = Math.ceil(now / msPerCandle) * msPerCandle;
      const diff = nextClose - now;
      const seconds = Math.floor(diff / 1000);
      const minutes = Math.floor(seconds / 60);
      const remainingSecs = seconds % 60;
      setCountdown(minutes > 0 ? `${minutes}:${remainingSecs.toString().padStart(2, '0')}` : `0:${remainingSecs.toString().padStart(2, '0')}`);
    };
    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [timeframe, startDate, pair]);
  if (loading || !tableMapLoaded) return (
    <div className="flex flex-col items-center justify-center h-full bg-background gap-3">
      <div className="relative">
        <div className="w-10 h-10 border-2 border-primary/20 rounded-full" />
        <div className="absolute inset-0 w-10 h-10 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
      <div className="text-muted-foreground animate-pulse text-sm">
        {startDate ? 'Loading historical data...' : 'Loading chart data...'}
      </div>
      {startDate && (
        <div className="text-xs text-muted-foreground/60">
          This may take a few seconds for large date ranges
        </div>
      )}
    </div>
  );
  if (candles.length === 0 && rawCandles.length === 0) return <div className="flex items-center justify-center h-full bg-background"><div className="text-muted-foreground">No data available</div></div>;
  const isDark = typeof document !== 'undefined' ? document.documentElement.classList.contains('dark') : true;

  const proChartColors = (() => {
    // If explicit customColors prop, use those
    if (customColors) {
      const bg = customColors.backgroundColor || (isDark ? '#000000' : '#ffffff');
      // Derive OHLC text color from actual background luminance, not page theme.
      // Prevents invisible white-on-white text when user has a light background in dark mode.
      const bgIsLight = isLightBackground(bg);
      return {
        background: bg,
        backgroundOpacity: customColors.backgroundOpacity ?? 100,
        grid: customColors.gridColor || (isDark ? '#1a1a1a' : '#f0f0f0'),
        gridOpacity: customColors.gridOpacity ?? 100,
        text: bgIsLight ? '#000000' : '#ffffff',
        textDim: bgIsLight ? '#999999' : '#666666',
        bullish: customColors.upColor || '#22c55e',
        bearish: customColors.downColor || '#ef5350',
        bullishBorder: customColors.upBorderColor || '#000000',
        bearishBorder: customColors.downBorderColor || '#000000',
        bullishWick: customColors.wickUpColor || '#000000',
        bearishWick: customColors.wickDownColor || '#000000',
        crosshair: bgIsLight ? '#00000040' : '#ffffff40',
        priceLine: '#3b82f6',
        priceTickerBullish: customColors.priceTickerBullish || PRICE_TAG_NEUTRAL,
        priceTickerBearish: customColors.priceTickerBearish || PRICE_TAG_NEUTRAL,
        // Axis labels must contrast with the actual background color.
        // Ignore theme-derived axisLabelColor (e.g. #b2b5be in dark mode) when
        // background is light, as it would be nearly invisible on white.
        axisLabel: bgIsLight ? '#000000' : '#b2b5be',
        axisLine: bgIsLight ? '#999999' : (customColors.axisLineColor || '#666666'),
      };
    }
    // Otherwise, read from ChartSettingsContext (was localStorage, now context-backed)
    if (savedChartSettings) {
      const cs = savedChartSettings.candles || {};
      const ch = savedChartSettings.chart || {};
      const savedBg = ch.backgroundColor || (isDark ? '#000000' : '#ffffff');
      // Derive text color from actual background, same logic as customColors path above
      const savedBgIsLight = isLightBackground(savedBg);
      return {
        background: savedBg,
        backgroundOpacity: ch.backgroundOpacity ?? 100,
        grid: ch.gridColor || (isDark ? '#2a2e39' : '#e0e3eb'),
        gridOpacity: ch.gridOpacity ?? 30,
        text: savedBgIsLight ? '#000000' : '#ffffff',
        textDim: savedBgIsLight ? '#999999' : '#666666',
        bullish: cs.bodyBullish || '#22c55e',
        bearish: cs.bodyBearish || '#ef4444',
        bullishBorder: cs.bordersBullish || '#16a34a',
        bearishBorder: cs.bordersBearish || '#dc2626',
        bullishWick: cs.wickBullish || '#22c55e',
        bearishWick: cs.wickBearish || '#ef4444',
        crosshair: savedBgIsLight ? '#00000040' : '#ffffff40',
        priceLine: '#3b82f6',
        priceTickerBullish: ch.priceTickerBullish || PRICE_TAG_NEUTRAL,
        priceTickerBearish: ch.priceTickerBearish || PRICE_TAG_NEUTRAL,
        // Force axis label contrast based on background luminance, same as customColors path
        axisLabel: savedBgIsLight ? '#000000' : '#b2b5be',
        axisLine: savedBgIsLight ? '#e0e3eb' : (ch.axisLineColor || '#2a2e39'),
      };
    }
    return undefined;
  })();
  const displayPrice = startDate ? replayPriceOverride || (chartCandles.length > 0 ? chartCandles[chartCandles.length - 1].close : null) : livePrice;
  return <div className="relative w-full h-full">
    {/* Phase-2 background loading indicator: thin animated bar at the top of the chart.
        Appears only after the chart is already visible (phase 1 complete) while the
        full historical dataset loads in the background. Disappears automatically when done.
        Uses the same primary color as the active timeframe button for visual consistency. */}
    {(isBackgroundLoading || isLoadingMoreHistory) && (
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        zIndex: 50,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}>
        <div style={{
          height: '100%',
          width: '40%',
          background: 'linear-gradient(90deg, transparent, var(--primary), transparent)',
          animation: 'lse-progress-sweep 1.4s ease-in-out infinite',
        }} />
        <style>{`
          @keyframes lse-progress-sweep {
            0%   { transform: translateX(-100%); }
            100% { transform: translateX(350%); }
          }
        `}</style>
      </div>
    )}
    <ProChart
      candles={chartCandles}
      livePrice={displayPrice}
      symbol={formatPairForSymbol(pair)}
      colors={proChartColors}
      indicators={indicators}
      onIndicatorsChange={onIndicatorsChange}
      onConverterReady={onConverterReady}
      timezone={timezone}
      onVisibleRangeChange={onVisibleRangeChange}
      disableAutoFollow={!!startDate}
      chartType={chartType}
      countdown={!startDate ? countdown : undefined}
      onCrosshairMove={onCrosshairMove}
      syncedCrosshairTime={syncedCrosshairTime}
      onViewportTimeChange={onViewportTimeChange}
      syncedViewportTime={syncedViewportTime}
      onScrollSync={onScrollSync}
      scrollOffsetRef={scrollOffsetRef}
      optionsPdfEnabled={optionsPdfEnabled}
      heatmapEnabled={heatmapEnabled}
      economicEvents={economicEvents}
      positionLines={positionLines}
      onPositionModify={onPositionModify}
      onPositionClose={onPositionClose}
      autoSelectPositionId={autoSelectPositionId}
      onOpenCustomEditor={onOpenCustomEditor}
      l2DepthData={l2DepthData}
      onOpenSettings={onOpenSettings}
      showBidAskSpread={showBidAskSpread}
      showSessions={showSessions}
      timeframe={timeframe}
      rightOffset={rightOffset}
      onLoadMore={loadMoreHistory}
      isLoadingMore={isLoadingMoreHistory}
      prependShift={historyPrependShift}
      drawings={drawings}
      selectedDrawingId={selectedDrawingId}
      drawingCursorRef={drawingCursorRef}
      requestRedrawRef={requestRedrawRef}
      isDrawingDragging={isDrawingDragging}
    />
  </div>;
};
// Re-export commonly used utilities so existing consumers (ChartPage.tsx) do not break.
// New consumers should import directly from ./hooks/useCandleFetch instead.
export { timeframeToMinutes, parseTickCount, isTickTimeframe, parseSecondCount, isSecondTimeframe } from "./hooks/useCandleFetch";

export default React.memo(ProCandlestickChart);