import React, { useState, useEffect, useRef, memo, useCallback, useId, Fragment } from 'react';
import { flushSync } from 'react-dom';

export type DrawingTool = 'trend' | 'trendRay' | 'parallelChannel' | 'line' | 'horizontal' | 'horizontalRay' | 'straightArrow' | 'vertical' | 'text' | 'fibonacci' | 'fibExtension' | 'rectangle' | 'square' | 'circle' | 'oval' | 'triangle' | 'freeTriangle' | 'parallelogram' | 'octagon' | 'diamond' | 'pentagon' | 'hexagon' | 'star' | 'cross' | 'arrowBlock' | 'wedge' | 'heart' | 'brush' | 'highlighter' | 'arrow' | 'long' | 'short' | 'measure' | null;

// Brush-like tools that share the same freehand drawing behavior
const BRUSH_TOOLS: DrawingTool[] = ['brush', 'highlighter', 'arrow'];
const isBrushTool = (tool: DrawingTool): boolean => BRUSH_TOOLS.includes(tool);

// Get default color for brush tools
const getBrushToolColor = (tool: DrawingTool): string => {
  switch (tool) {
    case 'highlighter': return '#FBBF24'; // Yellow
    default: return '#000000'; // Default black
  }
};

// Get default opacity for brush tools
const getBrushToolOpacity = (tool: DrawingTool): number => {
  switch (tool) {
    case 'highlighter': return 40; // Semi-transparent
    default: return 100;
  }
};

// Get default stroke width for brush tools
const getBrushToolStrokeWidth = (tool: DrawingTool): number => {
  switch (tool) {
    case 'highlighter': return 12; // Thick like a highlighter
    default: return 2;
  }
};

// Default drawing color and stroke width
const DEFAULT_DRAWING_COLOR = '#000000';
const DEFAULT_STROKE_WIDTH = 2;

// Point in price/time coordinates (anchored to chart data)
export type ChartPoint = {
  time: number;  // timestamp in milliseconds
  price: number; // price value
};

// Point in pixel coordinates (for rendering)
export type PixelPoint = {
  x: number;
  y: number;
};

export type Drawing = {
  id: string;
  type: DrawingTool;
  points: ChartPoint[];  // Now stores price/time coordinates
  text?: string;
  color?: string;
  opacity?: number;  // 0-100, default 100
  fillColor?: string;  // Fill color for shapes like rectangles (null/undefined = transparent)
  fillOpacity?: number;  // 0-100, default 100
  borderColor?: string; // Border color for long/short positions
  fibLevels?: number[];
  stopLoss?: ChartPoint;  // Also price/time coordinates
  stopLossPointIndex?: number;
  strokeWidth?: number;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  // Inline text-label styling for drawings that carry a `text` payload (trend, line, rectangle). Separate from the type='text' drawing, which reuses strokeWidth as fontSize.
  textFontSize?: number;
  textBold?: boolean;
  textItalic?: boolean;
  textColor?: string; // Defaults to drawing.color when unset.
  // For brush drawings: store pixel offsets relative to anchor point for smooth lines (legacy)
  pixelOffsets?: PixelPoint[];
  // For brush drawings: store all points in chart coordinates for proper zoom scaling
  brushChartPoints?: ChartPoint[]; // All brush points in chart coordinates (time/price)
  // For brush drawings: store original pixel points for smooth rendering
  brushPixelPoints?: PixelPoint[]; // Original pixel coordinates for smooth curve preservation
  // For brush drawings: store pixel offsets from anchor (scales with zoom)
  brushPixelOffsets?: PixelPoint[]; // Pixel offsets from first point - preserves curve shape
};

export type CoordinateConverter = {
  timeToX: (time: number) => number | null;
  xToTime: (x: number) => number | null;
  priceToY: (price: number) => number;
  yToPrice: (y: number) => number;
  priceAxisWidth?: number; // Exact value from ProChart canvas
};

type Props = {
  activeTool: DrawingTool;
  drawings: Drawing[];
  onDrawingsChange: (drawings: Drawing[]) => void;
  onToolSelect?: (tool: DrawingTool) => void;
  className?: string;
  converter: CoordinateConverter;
  selectedDrawingId?: string | null;
  onSelectDrawing?: (id: string | null, position?: { x: number; y: number }) => void;
  // Callback when drawing dragging starts/stops, used to pause parent canvas rasterization
  onDraggingStateChange?: (isDragging: boolean) => void;
  chartBounds?: { priceAxisWidth: number; timeAxisHeight: number; indicatorHeight?: number };
  scrollSyncRef?: React.MutableRefObject<() => void>; // Ref-based scroll sync (no re-renders)
  scrollOffsetRef?: React.MutableRefObject<number>; // Scroll offset in pixels for CSS transform sync
  isLocked?: boolean; // When true, drawings cannot be moved
  isHidden?: boolean; // When true, drawings are not rendered
  currentSymbol?: string; // For measure tool calculations
  timeframeMs?: number; // Timeframe in milliseconds for candle counting
  currentPrice?: number; // Live price for badge collision avoidance
  candles?: { time: number; open: number; high: number; low: number; close: number }[]; // For long/short TP/SL hit detection
  // Pre-placement tool settings from the settings bar (color, strokeWidth, lineStyle, etc.)
  // When provided, new drawings use these instead of hardcoded defaults
  toolSettings?: { color: string; strokeWidth: number; lineStyle: 'solid' | 'dashed' | 'dotted'; opacity: number; fillColor?: string; fillOpacity?: number };
  // Ref-based cursor signal for the chart canvas to render TradingView-style blue
  // price/time badges on the axes during drawing preview. The overlay writes to this
  // ref on every pointer move (no React re-renders), and the chart's RAF loop reads
  // it to draw the badge on the canvas in the same frame.
  // Array of badge points: [anchor, cursor] or [cursor] before first click.
  drawingCursorRef?: React.MutableRefObject<Array<{ price: number | null; time: number | null; x: number | null }>>;
  // Ref populated by the chart with its drawChart function. Called after writing to
  // drawingCursorRef to trigger a canvas repaint so the cursor badges actually render.
  requestRedrawRef?: React.MutableRefObject<(() => void) | null>;
  // Opaque version counter from MultiPanelChartGrid: bumped when the underlying
  // converter updates after an overlay render. Accepted purely so React.memo's
  // shallow compare detects the change and allows a re-render, which forces SVG
  // drawing positions to recompute via the now-correct proxy converter.
  converterVersion?: number;
};

const ChartDrawingOverlayComponent = ({
  activeTool,
  drawings,
  onDrawingsChange,
  onToolSelect,
  className,
  converter,
  selectedDrawingId,
  onSelectDrawing,
  chartBounds = { priceAxisWidth: 70, timeAxisHeight: 30 },
  scrollSyncRef,
  scrollOffsetRef,
  isLocked = false,
  isHidden = false,
  currentSymbol,
  timeframeMs = 3600000, // Default 1H
  currentPrice,
  candles: candlesProp,
  toolSettings,
  drawingCursorRef,
  requestRedrawRef,
  onDraggingStateChange,
}: Props) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const clipId = useId().replace(/:/g, '_'); // Unique clip ID per overlay instance
  // Stable ref so all callbacks (scrollSync, RAF, event handlers) always have access
  // to the unique instance prefix without stale-closure issues across re-renders.
  // Critical for multi-panel layouts: each panel renders the same drawings with the
  // same drawing IDs. Without a per-instance prefix every getElementById call returns
  // panel 0's element (first match in DOM), so dragging on panels 1+ moves the wrong
  // SVG group and the crosshair lands on the wrong overlay.
  const clipIdRef = useRef(clipId);
  const [tempPoints, setTempPoints] = useState<PixelPoint[]>([]);
  const [previewPoint, setPreviewPoint] = useState<PixelPoint | null>(null);
  const [textInput, setTextInput] = useState<{ x: number; y: number; value: string } | null>(null);
  const [hoveredDrawingId, setHoveredDrawingId] = useState<string | null>(null);
  // Inline text label editor state for trend, line, and rectangle drawings. labelDraft holds the current text until Enter or blur commits it.
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState('');
  // Ref-based focus on the inline label input. autoFocus on inputs mounted inside foreignObject is flaky in React; if the input is not focused, the user's keystrokes bubble to ChartPage's window keydown handler and open the symbol search.
  const labelInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editingLabelId && labelInputRef.current) {
      labelInputRef.current.focus();
      labelInputRef.current.select();
    }
  }, [editingLabelId]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  const [dragPointIndex, setDragPointIndex] = useState<number | null>(null);
  const [brushPath, setBrushPath] = useState<PixelPoint[]>([]);
  // Ref to track active brush drawing - true only while actively drawing NEW brush
  const isDrawingBrushRef = useRef(false);
  const [measureState, setMeasureState] = useState<{
    start: PixelPoint;
    current: PixelPoint;
    frozen: boolean;
  } | null>(null);
  const justFinishedDragging = useRef(false);
  const isDraggingRef = useRef(false); // Synchronous tracking of dragging state
  const [cursorPosition, setCursorPosition] = useState<PixelPoint | null>(null); // Track cursor for crosshair

  // Helper: get drawing properties from the pre-placement settings bar if available,
  // otherwise fall back to the hardcoded defaults. This lets users configure color,
  // stroke width, line style, etc. BEFORE placing a drawing (like TradingView).
  const getNewDrawingColor = () => toolSettings?.color ?? DEFAULT_DRAWING_COLOR;
  const getNewDrawingStrokeWidth = () => toolSettings?.strokeWidth ?? DEFAULT_STROKE_WIDTH;
  const getNewDrawingLineStyle = () => toolSettings?.lineStyle ?? 'solid';
  const getNewDrawingOpacity = () => toolSettings?.opacity ?? 100;
  const getNewDrawingFillColor = (fallback?: string) => toolSettings?.fillColor ?? fallback;
  const getNewDrawingFillOpacity = () => toolSettings?.fillOpacity ?? 100;

  // Performance optimization: Use refs for smooth dragging without React re-renders
  const rafIdRef = useRef<number | null>(null);
  const pendingDrawingUpdateRef = useRef<Drawing[] | null>(null);
  const lastPointerPosRef = useRef<{ x: number; y: number } | null>(null);
  // Live drag transform - applied directly to DOM via CSS transform3d for GPU-accelerated, instant visual feedback
  const dragTransformRef = useRef<{ deltaX: number; deltaY: number }>({ deltaX: 0, deltaY: 0 });
  const dragStartPosRef = useRef<{ x: number; y: number } | null>(null);
  // Chart coordinates at drag start, captured ONCE to avoid drift from
  // auto-scroll or live price changes shifting the coordinate mapping
  const dragStartChartRef = useRef<ChartPoint | null>(null);
  // Scroll offset at drag start: if chart auto-scrolls during drag, we
  // adjust the final pixel position by the scroll delta so the commit
  // produces the correct chart-coordinate delta
  const dragStartScrollOffsetRef = useRef<number>(0);
  // Cached bounding rect to avoid layout thrashing during dragging
  const cachedRectRef = useRef<DOMRect | null>(null);
  // RAF ID for crosshair updates (separate from drawing updates to avoid conflicts)
  const crosshairRafRef = useRef<number | null>(null);
  // Drawing-preview rAF throttle: setCursorPosition + setPreviewPoint fire on every
  // mousemove (~120 Hz), each triggering a full overlay re-render that diffs every
  // existing drawing. Throttling to one React commit per frame collapses 2 mouse
  // events that fall in the same frame into a single render.
  const previewRafRef = useRef<number | null>(null);
  const pendingPreviewPtRef = useRef<PixelPoint | null>(null);
  // Touch device detection: used to show midpoint grab dot on selected drawings.
  // Mobile has no hover cursor so the dot provides visual feedback for drag affordance.
  const isTouchDeviceRef = useRef(typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0));

  // Container dimensions for clipping
  const [containerDims, setContainerDims] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  // Force update mechanism for scroll sync (avoids parent re-renders)
  const [, forceUpdate] = useState(0);

  // Live refs for drag state, used inside the scroll-sync callback so the
  // closure always sees current values without having to re-register on every
  // drag state change.
  const draggingIdLiveRef = useRef(draggingId);
  const dragPointIndexLiveRef = useRef(dragPointIndex);
  const drawingsLiveRef = useRef(drawings);
  const onDrawingsChangeLiveRef = useRef(onDrawingsChange);
  draggingIdLiveRef.current = draggingId;
  dragPointIndexLiveRef.current = dragPointIndex;
  drawingsLiveRef.current = drawings;
  onDrawingsChangeLiveRef.current = onDrawingsChange;

  // Register the scroll sync callback - uses flushSync for zero-lag drawing updates.
  // Drawings MUST update in the exact same frame as the chart canvas to prevent
  // visible drift during horizontal panning. Any RAF or throttle delay causes
  // drawings to visibly slide relative to candles.
  useEffect(() => {
    if (scrollSyncRef) {
      scrollSyncRef.current = () => {
        const dId = draggingIdLiveRef.current;
        // Skip entirely if no drawings AND no active drag, a major optimization
        // for the common case. During a drag we must run even with 0 drawings
        // (defensive; drawings always includes the dragged one in practice).
        if (drawings.length === 0 && !dId) return;

        // flushSync forces React to process this state update synchronously,
        // so the drawing overlay re-renders in the same frame as the chart canvas.
        flushSync(() => {
          // During scroll-zoom with an active drag, re-sync the dragged state
          // to the live cursor position using the live converter. The canvas
          // repaints at 60fps via paintedScrollStateRef; timeToX/xToTime read
          // that state live inside their bodies. Without this sync, the dragged
          // point's chart coord is frozen at the last mousemove value and drifts
          // off-cursor as zoom changes the pixel↔chart mapping.
          const pos = lastPointerPosRef.current;
          if (dId && pos) {
            const dIdx = dragPointIndexLiveRef.current;
            if (dIdx !== null && dIdx >= 0 && dIdx <= 99) {
              // Endpoint drag: recompute cursor's chart coord and overwrite the
              // dragged point. Indices 980+ are bespoke long/short corner handles
              // with their own constraint math; don't bypass them.
              const chartPoint = pixelToChart(pos);
              const d = drawingsLiveRef.current.find(dd => dd.id === dId);
              if (chartPoint && d && dIdx < d.points.length) {
                const cur = d.points[dIdx];
                if (cur && (cur.time !== chartPoint.time || cur.price !== chartPoint.price)) {
                  const updatedPoints = d.points.map((p, i) => i === dIdx ? chartPoint : p);
                  onDrawingsChangeLiveRef.current(
                    drawingsLiveRef.current.map(dd => dd.id === dId ? { ...dd, points: updatedPoints } : dd)
                  );
                }
              }
            } else if (dIdx === null && dragStartChartRef.current) {
              // Whole-drawing drag (CSS translate3d): re-anchor dragStartPosRef
              // to the live pixel of the original drag-start chart coord, then
              // reapply the transform so the drawing keeps following the cursor.
              const newPixel = chartToPixel(dragStartChartRef.current);
              if (newPixel) {
                const prev = dragStartPosRef.current;
                if (!prev || prev.x !== newPixel.x || prev.y !== newPixel.y) {
                  dragStartPosRef.current = newPixel;
                  const deltaX = pos.x - newPixel.x;
                  const deltaY = pos.y - newPixel.y;
                  const dr = drawingsLiveRef.current.find(dd => dd.id === dId);
                  const effectiveDeltaX = dr?.type === 'horizontal' ? 0 : deltaX;
                  const el = document.getElementById(`${clipIdRef.current}_drawing-${dId}`);
                  if (el) el.style.transform = `translate3d(${effectiveDeltaX}px, ${deltaY}px, 0)`;
                }
              }
            }
          }

          forceUpdate(v => v + 1);
        });
      };
    }
  }, [scrollSyncRef, drawings.length]);

  // Touch drawing state - for tap-hold-drag behavior
  const [touchDrawing, setTouchDrawing] = useState<{ startPoint: PixelPoint; currentPoint: PixelPoint } | null>(null);
  const touchHoldTimerRef = useRef<NodeJS.Timeout | null>(null);
  const touchStartPointRef = useRef<PixelPoint | null>(null);

  // Track container size for clipping
  useEffect(() => {
    if (!containerRef.current) return;

    const updateDims = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setContainerDims({ width: rect.width, height: rect.height });
      }
    };

    updateDims();

    const resizeObserver = new ResizeObserver(updateDims);
    resizeObserver.observe(containerRef.current);

    return () => resizeObserver.disconnect();
  }, []);

  // iOS Safari fix: Attach non-passive touch event listener to prevent scroll during drawing
  // React's touch handlers are passive by default, so preventDefault() doesn't work on iOS
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const preventTouchScroll = (e: TouchEvent) => {
      // Only prevent scrolling when actively drawing/dragging
      if (activeTool !== null || draggingId !== null || touchDrawing !== null || isDrawingBrushRef.current || measureState !== null) {
        e.preventDefault();
      }
    };

    // Add with { passive: false } to allow preventDefault() on iOS Safari
    container.addEventListener('touchmove', preventTouchScroll, { passive: false });
    container.addEventListener('touchstart', preventTouchScroll, { passive: false });

    return () => {
      container.removeEventListener('touchmove', preventTouchScroll);
      container.removeEventListener('touchstart', preventTouchScroll);
    };
  }, [activeTool, draggingId, touchDrawing, measureState]);

  // iOS Safari: Add class to html element to prevent body scroll during drawing
  useEffect(() => {
    const isActivelyDrawing = activeTool !== null || draggingId !== null || touchDrawing !== null || isDrawingBrushRef.current || measureState !== null;

    if (isActivelyDrawing) {
      document.documentElement.classList.add('chart-drawing-active');
    } else {
      document.documentElement.classList.remove('chart-drawing-active');
    }

    return () => {
      document.documentElement.classList.remove('chart-drawing-active');
    };
  }, [activeTool, draggingId, touchDrawing, measureState]);

  // Desktop ESC key handler: cancel in-progress drawings or delete selected drawings
  useEffect(() => {
    // Only for desktop (no touch devices)
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (isTouchDevice) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Backspace') return;

      // Don't interfere with text input fields
      if (textInput) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

      // Priority 1: Cancel in-progress drawing
      if (tempPoints.length > 0 || brushPath.length > 0 || touchDrawing) {
        e.preventDefault();
        setTempPoints([]);
        setPreviewPoint(null);
        setBrushPath([]);
        setTouchDrawing(null);
        setMeasureState(null);
        // Clear the tool after canceling
        onToolSelect?.(null);
        return;
      }

      // Priority 2: Delete selected drawing
      if (selectedDrawingId) {
        e.preventDefault();
        const newDrawings = drawings.filter(d => d.id !== selectedDrawingId);
        onDrawingsChange(newDrawings);
        onSelectDrawing?.(null);
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [tempPoints, brushPath, touchDrawing, textInput, selectedDrawingId, drawings, onDrawingsChange, onSelectDrawing, onToolSelect]);

  // Helper: Check if a point is within the chart drawing area (excludes axis and indicator panels)
  const isPointInChartArea = useCallback((x: number, y: number): boolean => {
    if (!containerRef.current) return true;
    const { width, height } = containerRef.current.getBoundingClientRect();
    const chartWidth = width - chartBounds.priceAxisWidth;
    // Exclude indicator panel area at the bottom
    const indicatorHeight = chartBounds.indicatorHeight ?? 0;
    const drawableHeight = height - chartBounds.timeAxisHeight - indicatorHeight;
    return x >= 0 && x <= chartWidth && y >= 0 && y <= drawableHeight;
  }, [chartBounds]);

  // Helper: Clamp a point to the main chart area (excludes indicator panels)
  const clampToChartArea = useCallback((point: PixelPoint): PixelPoint => {
    if (!containerRef.current) return point;
    const { width, height } = containerRef.current.getBoundingClientRect();
    const chartWidth = width - chartBounds.priceAxisWidth;
    // Exclude indicator panel area at the bottom
    const indicatorHeight = chartBounds.indicatorHeight ?? 0;
    const drawableHeight = height - chartBounds.timeAxisHeight - indicatorHeight;
    return {
      x: Math.max(0, Math.min(chartWidth, point.x)),
      y: Math.max(0, Math.min(drawableHeight, point.y))
    };
  }, [chartBounds]);

  // Helper: Convert pixel point to chart point
  const pixelToChart = (pixel: PixelPoint): ChartPoint | null => {
    const time = converter.xToTime(pixel.x);
    if (time === null) return null;
    const price = converter.yToPrice(pixel.y);
    return { time, price };
  };

  // Helper: Convert chart point to pixel point
  const chartToPixel = (chart: ChartPoint): PixelPoint | null => {
    const x = converter.timeToX(chart.time);
    if (x === null) return null;
    const y = converter.priceToY(chart.price);
    return { x, y };
  };

  // Helper function to get stroke dash array from lineStyle
  const getStrokeDashArray = (style?: 'solid' | 'dashed' | 'dotted'): string | undefined => {
    switch (style) {
      case 'dashed': return '8,4';
      case 'dotted': return '2,4';
      default: return undefined;
    }
  };

  // Helper to start dragging
  const startDragging = (id: string) => {
    isDraggingRef.current = true; // Set synchronously to prevent brush additions
    setDraggingId(id);
    onDraggingStateChange?.(true);
  };

  useEffect(() => {
    setTempPoints([]);
    setPreviewPoint(null);
    setCursorPosition(null); // Clear crosshair when tool changes
    setTextInput(null);
    setBrushPath([]);
    isDrawingBrushRef.current = false;
    setTouchDrawing(null);
    // Clear any pending touch timer
    if (touchHoldTimerRef.current) {
      clearTimeout(touchHoldTimerRef.current);
      touchHoldTimerRef.current = null;
    }
  }, [activeTool]);

  // RAF-based update for silky smooth dragging - processes pending updates at 60fps
  const processRAFUpdate = useCallback(() => {
    if (pendingDrawingUpdateRef.current) {
      onDrawingsChange(pendingDrawingUpdateRef.current);
      pendingDrawingUpdateRef.current = null;
    }
    rafIdRef.current = null;
  }, [onDrawingsChange]);

  // Schedule a RAF update if not already scheduled
  const scheduleRAFUpdate = useCallback((updatedDrawings: Drawing[]) => {
    pendingDrawingUpdateRef.current = updatedDrawings;
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(processRAFUpdate);
    }
  }, [processRAFUpdate]);

  // Cleanup RAF on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
      if (crosshairRafRef.current !== null) {
        cancelAnimationFrame(crosshairRafRef.current);
      }
      if (previewRafRef.current !== null) {
        cancelAnimationFrame(previewRafRef.current);
      }
    };
  }, []);

  // Global mouseup safety net: catches mouseUp events that miss the SVG overlay
  // (e.g., double-click, mouse leaving overlay during brush draw)
  useEffect(() => {
    const globalMouseUp = () => {
      if (isDrawingBrushRef.current) {
        setBrushPath([]);
        isDrawingBrushRef.current = false;
      }
    };
    window.addEventListener('mouseup', globalMouseUp);
    return () => window.removeEventListener('mouseup', globalMouseUp);
  }, []);

  const hideCrosshair = () => {
    const hLine = document.getElementById(`${clipIdRef.current}_drawing-crosshair-h`);
    const vLine = document.getElementById(`${clipIdRef.current}_drawing-crosshair-v`);
    if (hLine) hLine.style.display = 'none';
    if (vLine) vLine.style.display = 'none';
    // Clear canvas cursor badges by emptying the array and triggering redraw.
    // The canvas checks drawingCursorRef.current.length during drawChart()
    // and skips badge rendering when the array is empty.
    if (drawingCursorRef) {
      drawingCursorRef.current = [];
    }
    for (let i = 0; i < 4; i++) {
        const priceBadge = document.getElementById(`${clipIdRef.current}_dom-price-badge-${i}`);
        const timeBadge = document.getElementById(`${clipIdRef.current}_dom-time-badge-${i}`);
        if (priceBadge) priceBadge.style.display = 'none';
        if (timeBadge) timeBadge.style.display = 'none';
    }
  };

  // Write cursor position to the shared ref so the chart renders blue preview
  // badges on the canvas axes during drawing. Also triggers a fast chart redraw
  // so the badges appear on the same frame as the pointer move.
  // Optional `allPoints` param: when dragging, pass all drawing points (displaced
  // by drag delta) so every point gets axis badges, not just the cursor.
  const updateCursorBadges = (pt: PixelPoint, allPoints?: PixelPoint[]) => {
    if (!drawingCursorRef) return;
    const badges: Array<{ price: number | null; time: number | null; x: number | null; y: number | null }> = [];

    if (allPoints && allPoints.length > 0) {
      // Drag mode: show badges for every provided point (all displaced drawing points)
      for (const p of allPoints) {
        const pPrice = converter.yToPrice(p.y);
        const pTime = converter.xToTime(p.x);
        badges.push({ price: pPrice ?? null, time: pTime ?? null, x: p.x, y: p.y });
      }
    } else {
      // Drawing/preview mode: anchor points (already-clicked tempPoints) + live cursor
      for (const tp of tempPoints) {
        const tpPrice = converter.yToPrice(tp.y);
        const tpTime = converter.xToTime(tp.x);
        badges.push({ price: tpPrice ?? null, time: tpTime ?? null, x: tp.x, y: tp.y });
      }
      const price = converter.yToPrice(pt.y);
      const time = converter.xToTime(pt.x);
      badges.push({ price: price ?? null, time: time ?? null, x: pt.x, y: pt.y });
    }

    drawingCursorRef.current = badges;
    
    // Update up to 4 DOM badges for zero-latency dragging overhead
    for (let i = 0; i < 4; i++) {
        const bdg = badges[i];
        const priceBadge = document.getElementById(`${clipIdRef.current}_dom-price-badge-${i}`);
        const timeBadge = document.getElementById(`${clipIdRef.current}_dom-time-badge-${i}`);
        
        if (bdg && bdg.price !== null && bdg.y !== null && priceBadge) {
            priceBadge.textContent = bdg.price.toFixed(5);
            priceBadge.style.top = `${bdg.y}px`;
            priceBadge.style.display = 'block';
        } else if (priceBadge) {
            priceBadge.style.display = 'none';
        }

        if (bdg && bdg.time !== null && bdg.x !== null && timeBadge) {
            const date = new Date(bdg.time);
            const str = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
            timeBadge.textContent = str;
            timeBadge.style.left = `${bdg.x}px`;
            timeBadge.style.display = 'block';
        } else if (timeBadge) {
            timeBadge.style.display = 'none';
        }
    }
  };

  // Unified pointer handler for both mouse and touch
  const handlePointerMove = (x: number, y: number) => {
    if (!containerRef.current) return;

    // Store last pointer position for smooth tracking
    lastPointerPosRef.current = { x, y };

    // Handle measure tool dragging - only update if not frozen
    if (activeTool === 'measure' && measureState && !measureState.frozen) {
      const clampedPoint = clampToChartArea({ x, y });
      setMeasureState(prev => prev ? { ...prev, current: clampedPoint } : null);
      updateCursorBadges(clampedPoint);
      return;
    }

    if (draggingId && dragOffset && dragPointIndex === null) {
      // SILKY SMOOTH DRAGGING: Use CSS transform3d ONLY during drag
      // No React state updates = no lag, instant visual feedback

      // Track drag start position + scroll offset. If the chart auto-scrolls
      // during drag, the scroll delta is added to the final position so both
      // start and end are in the same coordinate frame.
      if (!dragStartPosRef.current) {
        dragStartPosRef.current = { x, y };
        dragStartChartRef.current = pixelToChart({ x, y });
        dragStartScrollOffsetRef.current = scrollOffsetRef?.current ?? 0;
      }

      // Store current cursor position for commit on mouse up
      lastPointerPosRef.current = { x, y };

      // Calculate delta from drag start
      const deltaX = x - dragStartPosRef.current.x;
      const deltaY = y - dragStartPosRef.current.y;

      // Apply CSS transform directly to DOM - GPU accelerated, instant visual feedback
      // For 'horizontal' type: only allow vertical movement (lock deltaX to 0, line is edge-to-edge)
      // All other line types (including 'line'/straight line) allow free movement in both axes
      const draggedDrawing = drawings.find(d => d.id === draggingId);
      const effectiveDeltaX = draggedDrawing?.type === 'horizontal' ? 0 : deltaX;
      const effectiveDeltaY = deltaY;
      const svgGroup = document.getElementById(`${clipIdRef.current}_drawing-${draggingId}`);
      if (svgGroup) {
        svgGroup.style.transform = `translate3d(${effectiveDeltaX}px, ${effectiveDeltaY}px, 0)`;
      }
      // Update crosshair via direct DOM manipulation, ZERO React re-renders
      const clampedPoint = clampToChartArea({ x, y });
      const hLine = document.getElementById(`${clipIdRef.current}_drawing-crosshair-h`);
      const vLine = document.getElementById(`${clipIdRef.current}_drawing-crosshair-v`);
      if (hLine && vLine) {
        hLine.setAttribute('y1', String(clampedPoint.y));
        hLine.setAttribute('y2', String(clampedPoint.y));
        vLine.setAttribute('x1', String(clampedPoint.x));
        vLine.setAttribute('x2', String(clampedPoint.x));
        hLine.style.display = '';
        vLine.style.display = '';
      }
      // Compute all drawing points displaced by the drag delta so each
      // point gets its own blue badge on both axes during the drag.
      if (draggedDrawing?.points) {
        const displacedPoints = draggedDrawing.points.map(pt => {
          const origX = converter.timeToX(pt.time);
          const origY = converter.priceToY(pt.price);
          if (origX === null || origY === undefined) return null;
          return { x: origX + effectiveDeltaX, y: origY + effectiveDeltaY };
        }).filter((p): p is PixelPoint => p !== null);
        updateCursorBadges(clampedPoint, displacedPoints);
      } else {
        updateCursorBadges(clampedPoint);
      }
      if (!hLine || !vLine) {
        // Fallback: update React state but only once per frame
        if (!crosshairRafRef.current) {
          crosshairRafRef.current = requestAnimationFrame(() => {
            crosshairRafRef.current = null;
            setCursorPosition(clampedPoint);
          });
        }
      }

      return;
    }

    if (draggingId && dragPointIndex !== null) {
      // Update crosshair via direct DOM during point dragging, no React re-renders
      const clampedPoint = clampToChartArea({ x, y });
      const hLine = document.getElementById(`${clipIdRef.current}_drawing-crosshair-h`);
      const vLine = document.getElementById(`${clipIdRef.current}_drawing-crosshair-v`);
      if (hLine && vLine) {
        hLine.setAttribute('y1', String(clampedPoint.y));
        hLine.setAttribute('y2', String(clampedPoint.y));
        vLine.setAttribute('x1', String(clampedPoint.x));
        vLine.setAttribute('x2', String(clampedPoint.x));
        hLine.style.display = '';
        vLine.style.display = '';
      }
      // Show badges for all drawing points: the dragged point at cursor position,
      // other points at their original (undragged) positions.
      const pointDragDrawing = drawings.find(d => d.id === draggingId);
      if (pointDragDrawing?.points) {
        const allPts = pointDragDrawing.points.map((pt, idx) => {
          if (idx === dragPointIndex) {
            // This is the point being dragged, use cursor position
            return clampedPoint;
          }
          // Other points stay at their original pixel positions
          const origX = converter.timeToX(pt.time);
          const origY = converter.priceToY(pt.price);
          if (origX === null || origY === undefined) return null;
          return { x: origX, y: origY };
        }).filter((p): p is PixelPoint => p !== null);
        updateCursorBadges(clampedPoint, allPts);
      } else {
        updateCursorBadges(clampedPoint);
      }

      const drawing = drawings.find((d) => d.id === draggingId);

      // iOS Safari magnetic snap: when dragging position corner handles near the
      // price axis edge (within 30px), snap X to the chart boundary. On real iOS
      // Safari, touch coordinates can never physically reach the rightmost pixels
      // because the finger is too wide, so this lets users drag to the edge.
      let snapX = x;
      if (containerRef.current && dragPointIndex >= 980 && dragPointIndex <= 985) {
        const chartWidth = containerRef.current.clientWidth - chartBounds.priceAxisWidth;
        const SNAP_DISTANCE = 30; // px, snap zone near price axis
        if (x >= chartWidth - SNAP_DISTANCE) {
          snapX = chartWidth;
        }
        // Also snap to left edge
        if (x <= SNAP_DISTANCE) {
          snapX = 0;
        }
      }

      const chartPoint = pixelToChart({ x: snapX, y });
      if (!drawing || !chartPoint) return;

      if (dragPointIndex === 999 && drawing.stopLoss) {
        // This shouldn't be reached anymore since we use 997/998 for stop loss corners
        const updatedDrawings = drawings.map((d) =>
          d.id === draggingId ? { ...d, stopLoss: chartPoint } : d
        );
        scheduleRAFUpdate(updatedDrawings);
      } else if (dragPointIndex >= 980 && dragPointIndex <= 988) {
        // Long/short position corner handles and line drags
        const updatedDrawings = drawings.map((d) => {
          if (d.id !== draggingId || (d.type !== 'long' && d.type !== 'short')) return d;

          const [p0, p1] = d.points;
          const minTimePoint = p0.time < p1.time ? 0 : 1;
          const maxTimePoint = p0.time < p1.time ? 1 : 0;

          if (dragPointIndex === 980) {
            // Entry left handle - adjust left edge time AND entry price
            const updatedPoints = d.points.map((p, i) =>
              i === minTimePoint ? { ...p, time: chartPoint.time } : p
            );
            updatedPoints[0] = { ...updatedPoints[0], price: chartPoint.price };
            // Keep stopLoss aligned with left edge
            if (d.stopLoss) {
              return { ...d, points: updatedPoints, stopLoss: { ...d.stopLoss, time: chartPoint.time } };
            }
            return { ...d, points: updatedPoints };
          } else if (dragPointIndex === 981) {
            // Entry right handle - adjust right edge time AND entry price
            const updatedPoints = d.points.map((p, i) =>
              i === maxTimePoint ? { ...p, time: chartPoint.time } : p
            );
            updatedPoints[0] = { ...updatedPoints[0], price: chartPoint.price };
            // Keep stopLoss aligned with right edge
            if (d.stopLoss) {
              return { ...d, points: updatedPoints, stopLoss: { ...d.stopLoss, time: chartPoint.time } };
            }
            return { ...d, points: updatedPoints };
          } else if (dragPointIndex === 982) {
            // Top-left corner - adjust left time and target price
            const updatedPoints = d.points.map((p, i) =>
              i === minTimePoint ? { ...p, time: chartPoint.time } : p
            );
            // Clamp TP so it can never cross entry price. For longs TP must
            // stay above entry; for shorts TP must stay below entry. Without
            // this clamp, dragging TP past entry inverts the green/red zones
            // and glitches the chart rendering.
            const entryPrice982 = d.points[0].price;
            const clampedTP982 = d.type === 'long'
              ? Math.max(chartPoint.price, entryPrice982)
              : Math.min(chartPoint.price, entryPrice982);
            updatedPoints[1] = { ...updatedPoints[1], price: clampedTP982 };
            // Also update stopLoss time to keep box aligned
            if (d.stopLoss) {
              const updatedSL = { ...d.stopLoss, time: Math.min(d.stopLoss.time, chartPoint.time) };
              return { ...d, points: updatedPoints, stopLoss: updatedSL };
            }
            return { ...d, points: updatedPoints };
          } else if (dragPointIndex === 983) {
            // Top-right corner - adjust right time and target price
            const updatedPoints = d.points.map((p, i) =>
              i === maxTimePoint ? { ...p, time: chartPoint.time } : p
            );
            // Clamp TP so it can never cross entry (same logic as 982)
            const entryPrice983 = d.points[0].price;
            const clampedTP983 = d.type === 'long'
              ? Math.max(chartPoint.price, entryPrice983)
              : Math.min(chartPoint.price, entryPrice983);
            updatedPoints[1] = { ...updatedPoints[1], price: clampedTP983 };
            // Also update stopLoss time to keep box aligned
            if (d.stopLoss) {
              const updatedSL = { ...d.stopLoss, time: Math.max(d.stopLoss.time, chartPoint.time) };
              return { ...d, points: updatedPoints, stopLoss: updatedSL };
            }
            return { ...d, points: updatedPoints };
          } else if (dragPointIndex === 984 && d.stopLoss) {
            // Bottom-left corner - adjust left time and stop loss price.
            // Clamp SL so it can never cross entry price. For longs SL must
            // stay at or below entry; for shorts SL must stay at or above
            // entry. This prevents the red/green zones from inverting.
            const entryPrice984 = d.points[0].price;
            const clampedSL984 = d.type === 'long'
              ? Math.min(chartPoint.price, entryPrice984)
              : Math.max(chartPoint.price, entryPrice984);
            const updatedPoints = d.points.map((p, i) =>
              i === minTimePoint ? { ...p, time: chartPoint.time } : p
            );
            return { ...d, points: updatedPoints, stopLoss: { ...d.stopLoss, time: chartPoint.time, price: clampedSL984 } };
          } else if (dragPointIndex === 985 && d.stopLoss) {
            // Bottom-right corner - adjust right time and stop loss price.
            // Clamp SL so it can never cross entry (same logic as 984)
            const entryPrice985 = d.points[0].price;
            const clampedSL985 = d.type === 'long'
              ? Math.min(chartPoint.price, entryPrice985)
              : Math.max(chartPoint.price, entryPrice985);
            const updatedPoints = d.points.map((p, i) =>
              i === maxTimePoint ? { ...p, time: chartPoint.time } : p
            );
            return { ...d, points: updatedPoints, stopLoss: { ...d.stopLoss, time: chartPoint.time, price: clampedSL985 } };
          } else if (dragPointIndex === 986) {
            // Dragging the TARGET LINE - only adjust target price (vertical).
            // Clamp so TP can never cross entry price and invert the position
            const entryPrice986 = d.points[0].price;
            const clampedTP986 = d.type === 'long'
              ? Math.max(chartPoint.price, entryPrice986)
              : Math.min(chartPoint.price, entryPrice986);
            const updatedPoints = [...d.points];
            updatedPoints[1] = { ...updatedPoints[1], price: clampedTP986 };
            return { ...d, points: updatedPoints };
          } else if (dragPointIndex === 987 && d.stopLoss) {
            // Dragging the STOP LOSS LINE - only adjust stop loss price (vertical).
            // Clamp so SL can never cross entry price and invert the position
            const entryPrice987 = d.points[0].price;
            const clampedSL987 = d.type === 'long'
              ? Math.min(chartPoint.price, entryPrice987)
              : Math.max(chartPoint.price, entryPrice987);
            return { ...d, stopLoss: { ...d.stopLoss, price: clampedSL987 } };
          } else if (dragPointIndex === 988) {
            // Dragging the ENTRY LINE - only adjust entry price (vertical movement)
            const updatedPoints = [...d.points];
            updatedPoints[0] = { ...updatedPoints[0], price: chartPoint.price };
            return { ...d, points: updatedPoints };
          }
          return d;
        });
        scheduleRAFUpdate(updatedDrawings);
      } else if (dragPointIndex === 997 || dragPointIndex === 998) {
        // Legacy stop loss corner handles (keeping for compatibility)
        const updatedDrawings = drawings.map((d) => {
          if (d.id !== draggingId || !d.stopLoss) return d;

          const [p0, p1] = d.points;
          const minTimePoint = p0.time < p1.time ? 0 : 1;
          const maxTimePoint = p0.time < p1.time ? 1 : 0;

          // Clamp SL so it can never cross entry price (same rule as 984/985/987)
          const entryPriceLegacy = d.points[0].price;
          const clampedSLLegacy = d.type === 'long'
            ? Math.min(chartPoint.price, entryPriceLegacy)
            : d.type === 'short'
              ? Math.max(chartPoint.price, entryPriceLegacy)
              : chartPoint.price;

          if (dragPointIndex === 997) {
            const updatedPoints = d.points.map((p, i) =>
              i === minTimePoint ? { ...p, time: chartPoint.time } : p
            );
            return { ...d, points: updatedPoints, stopLoss: { time: chartPoint.time, price: clampedSLLegacy } };
          } else {
            const updatedPoints = d.points.map((p, i) =>
              i === maxTimePoint ? { ...p, time: chartPoint.time } : p
            );
            return { ...d, points: updatedPoints, stopLoss: { time: chartPoint.time, price: clampedSLLegacy } };
          }
        });
        scheduleRAFUpdate(updatedDrawings);
      } else if (dragPointIndex >= 990 && dragPointIndex <= 993) {
        // Dragging shape corners (rectangle, square, circle, oval, parallelogram, octagon, etc.)
        const shapeTypes = ['rectangle', 'square', 'circle', 'oval', 'parallelogram', 'octagon', 'diamond', 'pentagon', 'hexagon', 'star', 'cross', 'arrowBlock', 'wedge', 'heart'];
        const updatedDrawings = drawings.map((d) => {
          if (d.id !== draggingId || !shapeTypes.includes(d.type as string)) return d;

          const [p0, p1] = d.points;
          const minTimePoint = p0.time < p1.time ? p0 : p1;
          const maxTimePoint = p0.time < p1.time ? p1 : p0;
          const minPricePoint = p0.price < p1.price ? p0 : p1;
          const maxPricePoint = p0.price < p1.price ? p1 : p0;

          let newP0, newP1;

          // When dragging a corner, that corner moves to cursor position
          // and the opposite corner stays fixed
          if (dragPointIndex === 990) {
            newP0 = { time: chartPoint.time, price: chartPoint.price };
            newP1 = { time: maxTimePoint.time, price: minPricePoint.price };
          } else if (dragPointIndex === 991) {
            newP0 = { time: minTimePoint.time, price: minPricePoint.price };
            newP1 = { time: chartPoint.time, price: chartPoint.price };
          } else if (dragPointIndex === 992) {
            newP0 = { time: chartPoint.time, price: chartPoint.price };
            newP1 = { time: maxTimePoint.time, price: maxPricePoint.price };
          } else {
            newP0 = { time: minTimePoint.time, price: maxPricePoint.price };
            newP1 = { time: chartPoint.time, price: chartPoint.price };
          }

          // For square/circle: enforce equal pixel width and height by adjusting
          // the moved point's price so the vertical pixel span matches horizontal.
          // We keep time (horizontal) as the user dragged it, and adjust price (vertical)
          // because the price axis can be converted back precisely via pixelToChart.
          if (d.type === 'square' || d.type === 'circle') {
            const px0 = chartToPixel(newP0);
            const px1 = chartToPixel(newP1);
            if (px0 && px1) {
              const dx = Math.abs(px1.x - px0.x);
              const dy = Math.abs(px1.y - px0.y);
              const size = Math.max(dx, dy);
              // Determine which point was moved (the cursor point) and adjust it
              // Keep the fixed corner unchanged, adjust the dragged corner
              if (dragPointIndex === 990 || dragPointIndex === 992) {
                // p0 is the moved point. Adjust its x/y pixel position to enforce size.
                const fixedPx = px1;
                const adjustedX = fixedPx.x > px0.x ? fixedPx.x - size : fixedPx.x + size;
                const adjustedY = fixedPx.y > px0.y ? fixedPx.y - size : fixedPx.y + size;
                const adjusted = pixelToChart({ x: adjustedX, y: adjustedY });
                if (adjusted) newP0 = adjusted;
              } else {
                // p1 is the moved point
                const fixedPx = px0;
                const adjustedX = fixedPx.x > px1.x ? fixedPx.x - size : fixedPx.x + size;
                const adjustedY = fixedPx.y > px1.y ? fixedPx.y - size : fixedPx.y + size;
                const adjusted = pixelToChart({ x: adjustedX, y: adjustedY });
                if (adjusted) newP1 = adjusted;
              }
            }
          }

          return { ...d, points: [newP0, newP1] };
        });
        scheduleRAFUpdate(updatedDrawings);
      } else if (dragPointIndex >= 994 && dragPointIndex <= 996) {
        // Dragging triangle corners
        const updatedDrawings = drawings.map((d) => {
          if (d.id !== draggingId || d.type !== 'triangle') return d;

          const [p0, p1] = d.points;
          const minTimePoint = p0.time < p1.time ? p0 : p1;
          const maxTimePoint = p0.time < p1.time ? p1 : p0;
          const minPricePoint = p0.price < p1.price ? p0 : p1;
          const maxPricePoint = p0.price < p1.price ? p1 : p0;

          let newP0, newP1;

          if (dragPointIndex === 994) {
            // Bottom-left corner - adjust minTime and minPrice
            newP0 = { time: chartPoint.time, price: chartPoint.price };
            newP1 = { time: maxTimePoint.time, price: maxPricePoint.price };
          } else if (dragPointIndex === 995) {
            // Top-center corner - adjust the top (maxPrice), keep width
            const midTime = (minTimePoint.time + maxTimePoint.time) / 2;
            const timeDiff = chartPoint.time - midTime;
            newP0 = { time: minTimePoint.time + timeDiff, price: minPricePoint.price };
            newP1 = { time: maxTimePoint.time + timeDiff, price: chartPoint.price };
          } else {
            // Bottom-right corner - adjust maxTime and minPrice
            newP0 = { time: minTimePoint.time, price: maxPricePoint.price };
            newP1 = { time: chartPoint.time, price: chartPoint.price };
          }

          return { ...d, points: [newP0, newP1] };
        });
        scheduleRAFUpdate(updatedDrawings);
      } else {
        // Dragging regular corner point
        const updatedDrawingsRegular = drawings.map((d) => {
          if (d.id !== draggingId) return d;

          const updatedPoints = d.points.map((p, i) => {
            if (i !== dragPointIndex) return p;
            // Allow free movement of endpoints for all line types including 'line' (straight line)
            return chartPoint;
          });

          // For long/short, if dragging entry point (index 0), update stop loss time too
          if ((d.type === 'long' || d.type === 'short') && dragPointIndex === 0 && d.stopLoss) {
            return {
              ...d,
              points: updatedPoints,
              stopLoss: { ...d.stopLoss, time: chartPoint.time }
            };
          }

          return { ...d, points: updatedPoints };
        });
        scheduleRAFUpdate(updatedDrawingsRegular);
      }
      return;
    }

    // Only add brush points if we're actively drawing a NEW brush (not dragging an existing one)
    // Use direct state update for immediate visual feedback
    if (isBrushTool(activeTool) && isDrawingBrushRef.current && !isDraggingRef.current) {
      const clampedPoint = clampToChartArea({ x, y });
      // Add point smoothing - only add if moved enough to reduce jitter
      // Use smaller threshold for smoother lines (especially important on mobile)
      setBrushPath(prev => {
        if (prev.length === 0) return [clampedPoint];
        const lastPoint = prev[prev.length - 1];
        const dist = Math.sqrt((clampedPoint.x - lastPoint.x) ** 2 + (clampedPoint.y - lastPoint.y) ** 2);
        // Use 1px threshold for smoother curves (was 2px)
        if (dist >= 1) {
          return [...prev, clampedPoint];
        }
        return prev;
      });
      // Update crosshair position while drawing brush
      setCursorPosition(clampedPoint);
      return;
    }

    // Handle touch drawing (tap-hold-drag behavior)
    if (touchDrawing) {
      const clampedPoint = clampToChartArea({ x, y });
      setTouchDrawing({ ...touchDrawing, currentPoint: clampedPoint });
      return;
    }

    // Show crosshair and preview when a drawing tool is active
    const drawingTools: DrawingTool[] = ['trend', 'trendRay', 'parallelChannel', 'line', 'straightArrow', 'fibonacci', 'fibExtension', 'rectangle', 'square', 'circle', 'oval', 'triangle', 'freeTriangle', 'parallelogram', 'octagon', 'diamond', 'pentagon', 'hexagon', 'star', 'cross', 'arrowBlock', 'wedge', 'heart', 'long', 'short', 'horizontal', 'brush', 'highlighter', 'arrow', 'measure'];
    if (activeTool && drawingTools.includes(activeTool)) {
      const clampedPoint = clampToChartArea({ x, y });

      // #DO-NOT-FUCK-WITH-THIS  (commit 88b3536c)
      // This block is what makes the drawing-tool preview feel silky. If you replace
      // any of the imperative DOM writes below with React state, or remove the rAF
      // throttle, the preview goes back to stuttering at high mouse rates. We tried
      // it the React way; it diffs the entire overlay on every mousemove and blows
      // the frame budget once you have a few drawings on screen.
      //
      // Crosshair is positioned imperatively at full mouse rate (no React re-render).
      // The crosshair <line> elements have stable IDs from renderCrosshair() and were
      // previously driven by setCursorPosition state, which forced an overlay re-render
      // (diffing every existing drawing) on every mousemove. Direct setAttribute is free.
      const hLine = document.getElementById(`${clipIdRef.current}_drawing-crosshair-h`);
      const vLine = document.getElementById(`${clipIdRef.current}_drawing-crosshair-v`);
      if (hLine && vLine) {
        hLine.setAttribute('y1', String(clampedPoint.y));
        hLine.setAttribute('y2', String(clampedPoint.y));
        vLine.setAttribute('x1', String(clampedPoint.x));
        vLine.setAttribute('x2', String(clampedPoint.x));
        hLine.style.display = '';
        vLine.style.display = '';
      }

      // Badges are also imperative (DOM textContent + style) inside updateCursorBadges.
      updateCursorBadges(clampedPoint);

      // Preview shape (the in-progress trend/line/rect/etc.) still goes through React
      // because the shape varies per tool. rAF-throttle so we render at most once per
      // frame regardless of how fast mousemove fires. The state sync also keeps
      // cursorPosition fresh so any external re-render (live tick, prop change) keeps
      // the crosshair at the current cursor instead of snapping to a stale position.
      pendingPreviewPtRef.current = clampedPoint;
      if (previewRafRef.current === null) {
        previewRafRef.current = requestAnimationFrame(() => {
          previewRafRef.current = null;
          const pt = pendingPreviewPtRef.current;
          if (!pt) return;
          setCursorPosition(pt);
          if (tempPoints.length >= 1) setPreviewPoint(pt);
        });
      }
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    // Cache bounding rect during drags to avoid layout thrashing
    if (!cachedRectRef.current || !draggingId) {
      cachedRectRef.current = containerRef.current.getBoundingClientRect();
    }
    const rect = cachedRectRef.current;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    handlePointerMove(x, y);
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    e.preventDefault(); // Prevent scrolling while drawing
    const touch = e.touches[0];
    // Cache bounding rect during touch drags to avoid layout thrashing.
    // On iOS Safari, getBoundingClientRect() shifts by 2-3px mid-touch as
    // the toolbar slides or the viewport rubber-bands, causing drawings to
    // "snap" to a slightly different position. Caching prevents this drift.
    if (!cachedRectRef.current || !draggingId) {
      cachedRectRef.current = containerRef.current.getBoundingClientRect();
    }
    const rect = cachedRectRef.current;
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;
    handlePointerMove(x, y);
  };

  // Unified pointer down handler for both mouse and touch
  const handlePointerDown = (x: number, y: number, clientX: number, clientY: number) => {
    if (!containerRef.current) return false;

    // If drawings are locked, don't allow dragging/resizing existing drawings
    if (isLocked) return false;

    // PRIORITY: If user has an active drawing tool selected, skip existing drawing detection
    // This allows placing new drawings on top of existing ones
    // Exception: brush tool should start drawing immediately in handlePointerDown
    const drawingTools: DrawingTool[] = ['trend', 'trendRay', 'parallelChannel', 'line', 'straightArrow', 'fibonacci', 'fibExtension', 'rectangle', 'square', 'circle', 'oval', 'triangle', 'freeTriangle', 'parallelogram', 'octagon', 'diamond', 'pentagon', 'hexagon', 'star', 'cross', 'arrowBlock', 'wedge', 'heart', 'long', 'short', 'horizontal', 'text'];
    if (activeTool && drawingTools.includes(activeTool)) {
      return false; // Let handleClick/handleTap handle the new drawing creation
    }

    // Handle brush tool immediately - start drawing on pointer down
    // BUT only if we're not clicking on an existing drawing (to allow selecting brush drawings)
    if (isBrushTool(activeTool)) {
      // First check if we clicked on any existing brush drawing
      for (let i = drawings.length - 1; i >= 0; i--) {
        const drawing = drawings[i];
        if (!isBrushTool(drawing.type)) continue;

        const pixels = drawing.points.map(chartToPixel).filter((p): p is PixelPoint => p !== null);
        const anchorPixel = pixels[0];
        if (!anchorPixel) continue;

        // Compute brush pixels based on storage format - prioritize chart coordinates
        let smoothPixels: PixelPoint[];

        if (drawing.brushChartPoints && drawing.brushChartPoints.length > 0) {
          // Primary format: ALL points in chart coordinates - scales with zoom
          smoothPixels = drawing.brushChartPoints.map(cp => chartToPixel(cp)).filter((p): p is PixelPoint => p !== null);
        } else if (drawing.brushPixelOffsets && drawing.brushPixelOffsets.length > 0) {
          // Legacy format: pixel offsets (won't scale properly)
          smoothPixels = drawing.brushPixelOffsets.map(offset => ({
            x: anchorPixel.x + offset.x,
            y: anchorPixel.y + offset.y
          }));
        } else if (drawing.pixelOffsets && drawing.pixelOffsets.length > 0) {
          smoothPixels = drawing.pixelOffsets.map(offset => ({
            x: anchorPixel.x + offset.x,
            y: anchorPixel.y + offset.y
          }));
        } else if (drawing.brushPixelPoints && drawing.brushPixelPoints.length > 0) {
          const originalAnchor = drawing.brushPixelPoints[0];
          smoothPixels = drawing.brushPixelPoints.map(p => ({
            x: anchorPixel.x + (p.x - originalAnchor.x),
            y: anchorPixel.y + (p.y - originalAnchor.y)
          }));
        } else {
          smoothPixels = pixels;
        }

        if (smoothPixels.length < 2) continue;

        // Check if click is near any segment of the brush path
        for (let j = 1; j < smoothPixels.length; j++) {
          const p1 = smoothPixels[j - 1];
          const p2 = smoothPixels[j];
          const lineLength = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
          if (lineLength === 0) continue;

          const distToLine = Math.abs((p2.y - p1.y) * x - (p2.x - p1.x) * y + p2.x * p1.y - p2.y * p1.x) / lineLength;
          if (distToLine < 16) {
            const dotProduct = ((x - p1.x) * (p2.x - p1.x) + (y - p1.y) * (p2.y - p1.y)) / (lineLength * lineLength);
            if (dotProduct >= 0 && dotProduct <= 1) {
              // Clicked on existing brush - select and start dragging
              const firstPointPixel = chartToPixel(drawing.points[0]);
              startDragging(drawing.id);
              setDragOffset({ x: x - (firstPointPixel?.x || 0), y: y - (firstPointPixel?.y || 0) });
              onSelectDrawing?.(drawing.id, { x: clientX, y: clientY });
              return true;
            }
          }
        }
      }

      // Start new brush drawing on empty area
      const clampedPoint = clampToChartArea({ x, y });
      isDrawingBrushRef.current = true;
      setBrushPath([clampedPoint]);
      return true;
    }

    // Track if we hit ANY drawing
    let hitAnyDrawing = false;

    // Check drawings in reverse order (top-most first)
    for (let i = drawings.length - 1; i >= 0; i--) {
      const drawing = drawings[i];
      const pixels = drawing.points.map(chartToPixel).filter((p): p is PixelPoint => p !== null);

      // First check if clicking on resize handles (corners/points)
      // Special handling for rectangles and shapes - check all 4 corners (or 3 for triangle)
      if ((drawing.type === 'rectangle' || drawing.type === 'square' || drawing.type === 'circle' || drawing.type === 'oval' || drawing.type === 'parallelogram' || drawing.type === 'octagon' || drawing.type === 'diamond' || drawing.type === 'pentagon' || drawing.type === 'hexagon' || drawing.type === 'star' || drawing.type === 'cross' || drawing.type === 'arrowBlock' || drawing.type === 'wedge' || drawing.type === 'heart') && pixels.length >= 2) {
        const [p1, p2] = pixels;
        const minX = Math.min(p1.x, p2.x);
        const maxX = Math.max(p1.x, p2.x);
        const minY = Math.min(p1.y, p2.y);
        const maxY = Math.max(p1.y, p2.y);

        // For square/circle, use size-based corners to maintain equal proportions
        const isFixedProportion = drawing.type === 'square' || drawing.type === 'circle';
        const size = isFixedProportion ? Math.max(maxX - minX, maxY - minY) : 0;
        const actualMaxX = isFixedProportion ? minX + size : maxX;
        const actualMaxY = isFixedProportion ? minY + size : maxY;

        const corners = [
          { x: minX, y: minY, index: 990 }, // Top-left
          { x: actualMaxX, y: minY, index: 991 }, // Top-right
          { x: minX, y: actualMaxY, index: 992 }, // Bottom-left
          { x: actualMaxX, y: actualMaxY, index: 993 }, // Bottom-right
        ];

        for (const corner of corners) {
          const dist = Math.sqrt((x - corner.x) ** 2 + (y - corner.y) ** 2);
          if (dist < 15) { // Larger hit area for touch
            startDragging(drawing.id);
            setDragPointIndex(corner.index);
            return true;
          }
        }
      }

      // Special handling for triangle - 3 corners
      if (drawing.type === 'triangle' && pixels.length >= 2) {
        const [p1, p2] = pixels;
        const minX = Math.min(p1.x, p2.x);
        const minY = Math.min(p1.y, p2.y);
        const size = Math.max(Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
        const height = size * Math.sqrt(3) / 2;

        // Triangle corners: bottom-left, top-center, bottom-right
        const triangleCorners = [
          { x: minX, y: minY + height, index: 994 }, // Bottom-left
          { x: minX + size / 2, y: minY, index: 995 }, // Top-center
          { x: minX + size, y: minY + height, index: 996 }, // Bottom-right
        ];

        for (const corner of triangleCorners) {
          const dist = Math.sqrt((x - corner.x) ** 2 + (y - corner.y) ** 2);
          if (dist < 15) {
            startDragging(drawing.id);
            setDragPointIndex(corner.index);
            return true;
          }
        }
      }

      // Regular point checking for other drawing types (skip for rectangles and shapes - already handled above)
      if (drawing.type !== 'rectangle' && drawing.type !== 'square' && drawing.type !== 'circle' && drawing.type !== 'oval' && drawing.type !== 'triangle' && drawing.type !== 'diamond' && drawing.type !== 'pentagon' && drawing.type !== 'hexagon' && drawing.type !== 'star' && drawing.type !== 'cross' && drawing.type !== 'arrowBlock' && drawing.type !== 'wedge' && drawing.type !== 'heart') {
        for (let j = 0; j < pixels.length; j++) {
          const pixel = pixels[j];
          const dist = Math.sqrt((x - pixel.x) ** 2 + (y - pixel.y) ** 2);
          if (dist < 15) { // Larger hit area for touch
            startDragging(drawing.id);
            setDragPointIndex(j);
            return true;
          }
        }
      }

      // Corner/line handles for long/short positions, ONLY when drawing is
      // already selected. Unselected drawings always get body-drag so the
      // user can reposition the whole box without accidentally grabbing a
      // handle that distorts its shape (the three horizontal lines cover
      // most of the vertical area with their 15px tolerance zones).
      const isThisDrawingSelected = selectedDrawingId === drawing.id;
      if (isThisDrawingSelected && (drawing.type === 'long' || drawing.type === 'short') && drawing.stopLoss && pixels.length >= 2) {
        const slPixel = chartToPixel(drawing.stopLoss);
        if (slPixel) {
          const minX = Math.min(pixels[0].x, pixels[1].x);
          const maxX = Math.max(pixels[0].x, pixels[1].x);
          const entryY = pixels[0].y;
          const targetY = pixels[1].y;
          const stopLossY = slPixel.y;
          const cornerHitRadius = 12; // Tight radius so corners don't steal from lines
          const lineHitTolerance = 15; // Generous hit area for lines

          // CORNER handles checked FIRST. Visible handle squares are drawn AT
          // the corners, so a click on the handle must route to corner-resize
          // (horizontal + vertical) rather than line-drag (vertical only).
          // The 12px corner radius is tight enough not to steal from clicks
          // in the middle of a line.

          // Target left corner (982) - green top-left
          if (Math.sqrt((x - minX) ** 2 + (y - targetY) ** 2) < cornerHitRadius) {
            startDragging(drawing.id);
            setDragPointIndex(982);
            return true;
          }
          // Target right corner (983) - green top-right
          if (Math.sqrt((x - maxX) ** 2 + (y - targetY) ** 2) < cornerHitRadius) {
            startDragging(drawing.id);
            setDragPointIndex(983);
            return true;
          }
          // Stop loss left corner (984) - red bottom-left
          if (Math.sqrt((x - minX) ** 2 + (y - stopLossY) ** 2) < cornerHitRadius) {
            startDragging(drawing.id);
            setDragPointIndex(984);
            return true;
          }
          // Stop loss right corner (985) - red bottom-right
          if (Math.sqrt((x - maxX) ** 2 + (y - stopLossY) ** 2) < cornerHitRadius) {
            startDragging(drawing.id);
            setDragPointIndex(985);
            return true;
          }
          // Entry left handle (980) - gray middle-left
          if (Math.sqrt((x - minX) ** 2 + (y - entryY) ** 2) < cornerHitRadius) {
            startDragging(drawing.id);
            setDragPointIndex(980);
            return true;
          }
          // Entry right handle (981) - gray middle-right
          if (Math.sqrt((x - maxX) ** 2 + (y - entryY) ** 2) < cornerHitRadius) {
            startDragging(drawing.id);
            setDragPointIndex(981);
            return true;
          }

          // LINE handles checked AFTER corners, so the middle of each line
          // (away from the corner handles) drags vertically only.

          // Target LINE hit detection (986) - anywhere along the horizontal TP line
          if (x >= minX && x <= maxX && Math.abs(y - targetY) < lineHitTolerance) {
            startDragging(drawing.id);
            setDragPointIndex(986);
            return true;
          }

          // Stop loss LINE hit detection (987) - anywhere along the horizontal SL line
          if (x >= minX && x <= maxX && Math.abs(y - stopLossY) < lineHitTolerance) {
            startDragging(drawing.id);
            setDragPointIndex(987);
            return true;
          }

          // Entry LINE hit detection (988) - anywhere along the horizontal entry line
          if (x >= minX && x <= maxX && Math.abs(y - entryY) < lineHitTolerance) {
            startDragging(drawing.id);
            setDragPointIndex(988);
            return true;
          }
        }
      }

      // Triangle body drag: test against the ACTUAL rendered equilateral polygon, not p1/p2 bbox.
      // Why: render at line ~3219 uses size = max(|dx|, |dy|) and height = size * sqrt(3)/2, so the
      // visible triangle extends well beyond the two stored points' bbox. A horizontal draw
      // (dy = 0) produces a zero-height bbox and the body becomes ungrabbable.
      if (drawing.type === 'triangle' && pixels.length >= 2) {
        const [p1, p2] = pixels;
        const minX = Math.min(p1.x, p2.x);
        const minY = Math.min(p1.y, p2.y);
        const size = Math.max(Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
        const height = size * Math.sqrt(3) / 2;
        const a = { x: minX, y: minY + height };
        const b = { x: minX + size / 2, y: minY };
        const c = { x: minX + size, y: minY + height };
        const sign = (px: { x: number; y: number }, py: { x: number; y: number }, pz: { x: number; y: number }) =>
          (px.x - pz.x) * (py.y - pz.y) - (py.x - pz.x) * (px.y - pz.y);
        const d1 = sign({ x, y }, a, b);
        const d2 = sign({ x, y }, b, c);
        const d3 = sign({ x, y }, c, a);
        const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
        const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
        if (!(hasNeg && hasPos)) {
          hitAnyDrawing = true;
          const firstPointPixel = chartToPixel(drawing.points[0]);
          startDragging(drawing.id);
          setDragOffset({ x: x - (firstPointPixel?.x || 0), y: y - (firstPointPixel?.y || 0) });
          onSelectDrawing?.(drawing.id, { x: clientX, y: clientY });
          return true;
        }
      }

      // Check if clicking on drawing body (for moving entire shape)
      if ((drawing.type === 'rectangle' || drawing.type === 'square' || drawing.type === 'circle' || drawing.type === 'oval' || drawing.type === 'parallelogram' || drawing.type === 'octagon' || drawing.type === 'diamond' || drawing.type === 'pentagon' || drawing.type === 'hexagon' || drawing.type === 'star' || drawing.type === 'cross' || drawing.type === 'arrowBlock' || drawing.type === 'wedge' || drawing.type === 'heart' || drawing.type === 'long' || drawing.type === 'short') && pixels.length >= 2) {
        const pixels0 = pixels[0];
        const pixels1 = pixels[1];
        if (pixels0 && pixels1) {
          const minX = Math.min(pixels0.x, pixels1.x);
          const maxX = Math.max(pixels0.x, pixels1.x);
          let minY = Math.min(pixels0.y, pixels1.y);
          let maxY = Math.max(pixels0.y, pixels1.y);

          // For long/short, include stop loss in the body bounds
          if ((drawing.type === 'long' || drawing.type === 'short') && drawing.stopLoss) {
            const slPixel = chartToPixel(drawing.stopLoss);
            if (slPixel) {
              minY = Math.min(minY, slPixel.y);
              maxY = Math.max(maxY, slPixel.y);
            }
          }

          if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
            hitAnyDrawing = true;
            // For selected drawings, allow dragging (don't deselect on click)
            // Store offset from cursor to first point for precise dragging
            const firstPointPixel = chartToPixel(drawing.points[0]);
            startDragging(drawing.id);
            setDragOffset({ x: x - (firstPointPixel?.x || 0), y: y - (firstPointPixel?.y || 0) });
            // Select this drawing and show toolbar at click position
            onSelectDrawing?.(drawing.id, { x: clientX, y: clientY });
            return true;
          }
        }
      }

      // Check trendRay body (ray from p1 through p2)
      if (drawing.type === 'trendRay' && pixels.length >= 2) {
        const [p1, p2] = pixels;
        const lineLength = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
        if (lineLength > 0) {
          const distToLine = Math.abs((p2.y - p1.y) * x - (p2.x - p1.x) * y + p2.x * p1.y - p2.y * p1.x) / lineLength;
          const cw = containerRef.current?.clientWidth || 1000;
          const ch = containerRef.current?.clientHeight || 600;
          if (distToLine < 12 && x >= 0 && x <= cw && y >= 0 && y <= ch) {
            const dotProduct = ((x - p1.x) * (p2.x - p1.x) + (y - p1.y) * (p2.y - p1.y)) / (lineLength * lineLength);
            if (dotProduct >= -0.1) {
              hitAnyDrawing = true;
              const firstPointPixel = chartToPixel(drawing.points[0]);
              startDragging(drawing.id);
              setDragOffset({ x: x - (firstPointPixel?.x || 0), y: y - (firstPointPixel?.y || 0) });
              onSelectDrawing?.(drawing.id, { x: clientX, y: clientY });
              return true;
            }
          }
        }
      }
      // Check trend and line (finite segment) body
      if ((drawing.type === 'trend' || drawing.type === 'line') && pixels.length >= 2) {
        const [p1, p2] = pixels;
        const lineLength = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
        if (lineLength > 0) {
          const distToLine = Math.abs((p2.y - p1.y) * x - (p2.x - p1.x) * y + p2.x * p1.y - p2.y * p1.x) / lineLength;
          if (distToLine < 12) {
            const dotProduct = ((x - p1.x) * (p2.x - p1.x) + (y - p1.y) * (p2.y - p1.y)) / (lineLength * lineLength);
            if (dotProduct >= 0 && dotProduct <= 1) {
              hitAnyDrawing = true;
              const firstPointPixel = chartToPixel(drawing.points[0]);
              startDragging(drawing.id);
              setDragOffset({ x: x - (firstPointPixel?.x || 0), y: y - (firstPointPixel?.y || 0) });
              onSelectDrawing?.(drawing.id, { x: clientX, y: clientY });
              return true;
            }
          }
        }
      }
      // Check horizontal line body
      if (drawing.type === 'horizontal' && pixels.length >= 1) {
        const lineY = pixels[0].y;
        if (Math.abs(y - lineY) < 12) { // Larger hit area for touch
          hitAnyDrawing = true;
          const firstPointPixel = chartToPixel(drawing.points[0]);
          startDragging(drawing.id);
          setDragOffset({ x: x - (firstPointPixel?.x || 0), y: y - (firstPointPixel?.y || 0) });
          onSelectDrawing?.(drawing.id, { x: clientX, y: clientY });
          return true;
        }
      }

      // Check straight arrow body (line between two points)
      if (drawing.type === 'straightArrow' && pixels.length >= 2) {
        const [p1, p2] = pixels;
        const lineLength = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
        if (lineLength > 0) {
          const distToLine = Math.abs((p2.y - p1.y) * x - (p2.x - p1.x) * y + p2.x * p1.y - p2.y * p1.x) / lineLength;
          if (distToLine < 15) {
            const dotProduct = ((x - p1.x) * (p2.x - p1.x) + (y - p1.y) * (p2.y - p1.y)) / (lineLength * lineLength);
            if (dotProduct >= 0 && dotProduct <= 1) {
              hitAnyDrawing = true;
              const firstPointPixel = chartToPixel(drawing.points[0]);
              startDragging(drawing.id);
              setDragOffset({ x: x - (firstPointPixel?.x || 0), y: y - (firstPointPixel?.y || 0) });
              onSelectDrawing?.(drawing.id, { x: clientX, y: clientY });
              return true;
            }
          }
        }
      }

      // Check horizontal ray body (extends from point to right edge)
      if (drawing.type === 'horizontalRay' && pixels.length >= 1) {
        const lineY = pixels[0].y;
        const startX = pixels[0].x;
        if (Math.abs(y - lineY) < 12 && x >= startX - 10) {
          hitAnyDrawing = true;
          const firstPointPixel = chartToPixel(drawing.points[0]);
          startDragging(drawing.id);
          setDragOffset({ x: x - (firstPointPixel?.x || 0), y: y - (firstPointPixel?.y || 0) });
          onSelectDrawing?.(drawing.id, { x: clientX, y: clientY });
          return true;
        }
      }

      // Check vertical line body
      if (drawing.type === 'vertical' && pixels.length >= 1) {
        const lineX = pixels[0].x;
        if (Math.abs(x - lineX) < 12) { // Larger hit area for touch
          hitAnyDrawing = true;
          const firstPointPixel = chartToPixel(drawing.points[0]);
          startDragging(drawing.id);
          setDragOffset({ x: x - (firstPointPixel?.x || 0), y: y - (firstPointPixel?.y || 0) });
          onSelectDrawing?.(drawing.id, { x: clientX, y: clientY });
          return true;
        }
      }

      // Check fibonacci body
      if ((drawing.type === 'fibonacci' || drawing.type === 'fibExtension') && pixels.length >= 2) {
        const [p1, p2] = pixels;
        const minX = Math.min(p1.x, p2.x);
        const maxX = Math.max(p1.x, p2.x);
        const minY = Math.min(p1.y, p2.y);
        const maxY = Math.max(p1.y, p2.y);

        if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
          hitAnyDrawing = true;
          const firstPointPixel = chartToPixel(drawing.points[0]);
          startDragging(drawing.id);
          setDragOffset({ x: x - (firstPointPixel?.x || 0), y: y - (firstPointPixel?.y || 0) });
          onSelectDrawing?.(drawing.id, { x: clientX, y: clientY });
          return true;
        }
      }

      // Check freeTriangle body (point in polygon test)
      if (drawing.type === 'freeTriangle' && pixels.length >= 3) {
        const [p1, p2, p3] = pixels;

        // Point in triangle test using barycentric coordinates
        const sign = (px: PixelPoint, py: PixelPoint, pz: PixelPoint) =>
          (px.x - pz.x) * (py.y - pz.y) - (py.x - pz.x) * (px.y - pz.y);

        const d1 = sign({ x, y }, p1, p2);
        const d2 = sign({ x, y }, p2, p3);
        const d3 = sign({ x, y }, p3, p1);

        const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
        const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);

        if (!(hasNeg && hasPos)) {
          hitAnyDrawing = true;
          const firstPointPixel = chartToPixel(drawing.points[0]);
          startDragging(drawing.id);
          setDragOffset({ x: x - (firstPointPixel?.x || 0), y: y - (firstPointPixel?.y || 0) });
          onSelectDrawing?.(drawing.id, { x: clientX, y: clientY });
          return true;
        }
      }

      // Check parallelChannel body (point in parallelogram formed by the two channel lines)
      if (drawing.type === 'parallelChannel' && pixels.length >= 3) {
        const [p1, p2, p3] = pixels;
        const dx = p3.x - p1.x;
        const dy = p3.y - p1.y;
        const q1 = p1;
        const q2 = p2;
        const q3 = { x: p2.x + dx, y: p2.y + dy };
        const q4 = p3;
        // Point in quad test: split into two triangles
        const signQ = (px: PixelPoint, py: PixelPoint, pz: PixelPoint) =>
          (px.x - pz.x) * (py.y - pz.y) - (py.x - pz.x) * (px.y - pz.y);
        const inTri = (pt: PixelPoint, a: PixelPoint, b: PixelPoint, c: PixelPoint) => {
          const d1 = signQ(pt, a, b);
          const d2 = signQ(pt, b, c);
          const d3 = signQ(pt, c, a);
          return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
        };
        if (inTri({ x, y }, q1, q2, q3) || inTri({ x, y }, q1, q3, q4)) {
          hitAnyDrawing = true;
          const firstPointPixel = chartToPixel(drawing.points[0]);
          startDragging(drawing.id);
          setDragOffset({ x: x - (firstPointPixel?.x || 0), y: y - (firstPointPixel?.y || 0) });
          onSelectDrawing?.(drawing.id, { x: clientX, y: clientY });
          return true;
        }
        // Also check if near either line edge
        for (const [la, lb] of [[q1, q2], [q4, q3]]) {
          const lineLen = Math.sqrt((lb.x - la.x) ** 2 + (lb.y - la.y) ** 2);
          if (lineLen > 0) {
            const dist = Math.abs((lb.y - la.y) * x - (lb.x - la.x) * y + lb.x * la.y - lb.y * la.x) / lineLen;
            const dot = ((x - la.x) * (lb.x - la.x) + (y - la.y) * (lb.y - la.y)) / (lineLen * lineLen);
            if (dist < 12 && dot >= -0.1 && dot <= 1.1) {
              hitAnyDrawing = true;
              const firstPointPixel = chartToPixel(drawing.points[0]);
              startDragging(drawing.id);
              setDragOffset({ x: x - (firstPointPixel?.x || 0), y: y - (firstPointPixel?.y || 0) });
              onSelectDrawing?.(drawing.id, { x: clientX, y: clientY });
              return true;
            }
          }
        }
      }

      // Check text drawing (click near the text position)
      if (drawing.type === 'text' && pixels.length >= 1) {
        const p = pixels[0];
        const textWidth = (drawing.text?.length || 5) * 8;
        const textHeight = 20;
        if (x >= p.x - 5 && x <= p.x + textWidth && y >= p.y - textHeight && y <= p.y + 5) {
          hitAnyDrawing = true;
          const firstPointPixel = chartToPixel(drawing.points[0]);
          startDragging(drawing.id);
          setDragOffset({ x: x - (firstPointPixel?.x || 0), y: y - (firstPointPixel?.y || 0) });
          onSelectDrawing?.(drawing.id, { x: clientX, y: clientY });
          return true;
        }
      }

      // Check brush drawing (click near any part of the brush path)
      if (isBrushTool(drawing.type)) {
        // Compute brush pixels based on storage format
        const anchorPixel = pixels[0];
        if (!anchorPixel) continue;

        let smoothPixels: PixelPoint[];

        if (drawing.brushChartPoints && drawing.brushChartPoints.length > 0) {
          // Primary format: ALL points in chart coordinates - scales with zoom
          smoothPixels = drawing.brushChartPoints.map(cp => chartToPixel(cp)).filter((p): p is PixelPoint => p !== null);
        } else if (drawing.brushPixelOffsets && drawing.brushPixelOffsets.length > 0) {
          // Legacy format: pixel offsets (won't scale properly)
          smoothPixels = drawing.brushPixelOffsets.map(offset => ({
            x: anchorPixel.x + offset.x,
            y: anchorPixel.y + offset.y
          }));
        } else if (drawing.pixelOffsets && drawing.pixelOffsets.length > 0) {
          // Oldest legacy format: pixel offsets
          smoothPixels = drawing.pixelOffsets.map(offset => ({
            x: anchorPixel.x + offset.x,
            y: anchorPixel.y + offset.y
          }));
        } else if (drawing.brushPixelPoints && drawing.brushPixelPoints.length > 0) {
          const originalAnchor = drawing.brushPixelPoints[0];
          smoothPixels = drawing.brushPixelPoints.map(p => ({
            x: anchorPixel.x + (p.x - originalAnchor.x),
            y: anchorPixel.y + (p.y - originalAnchor.y)
          }));
        } else {
          // Fallback: chart-converted pixels
          smoothPixels = pixels;
        }

        if (smoothPixels.length < 2) continue;

        let isNearBrush = false;
        for (let j = 1; j < smoothPixels.length; j++) {
          const p1 = smoothPixels[j - 1];
          const p2 = smoothPixels[j];
          const lineLength = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
          if (lineLength === 0) continue;
          const distToLine = Math.abs((p2.y - p1.y) * x - (p2.x - p1.x) * y + p2.x * p1.y - p2.y * p1.x) / lineLength;

          if (distToLine < 20) { // Increased hit area
            const dotProduct = ((x - p1.x) * (p2.x - p1.x) + (y - p1.y) * (p2.y - p1.y)) / (lineLength * lineLength);
            if (dotProduct >= 0 && dotProduct <= 1) {
              isNearBrush = true;
              break;
            }
          }
        }

        if (isNearBrush) {
          hitAnyDrawing = true;
          const firstPointPixel = chartToPixel(drawing.points[0]);
          startDragging(drawing.id);
          setDragOffset({ x: x - (firstPointPixel?.x || 0), y: y - (firstPointPixel?.y || 0) });
          onSelectDrawing?.(drawing.id, { x: clientX, y: clientY });
          return true;
        }
      }
    }

    // If we clicked on empty space (not on any drawing), deselect any selected drawing
    if (!hitAnyDrawing && selectedDrawingId) {
      onSelectDrawing?.(null);
      return true;
    }

    // Brush is now handled at the start of this function

    return false;
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Reject clicks in the price axis area; nothing should be drawn on the Y-axis
    const chartWidth = rect.width - chartBounds.priceAxisWidth;
    if (x > chartWidth) return;

    // Clear frozen measurement on any click
    if (measureState?.frozen) {
      setMeasureState(null);
      return;
    }

    // Handle measure tool - tap logic: start -> freeze
    if (activeTool === 'measure') {
      e.preventDefault();
      if (!measureState) {
        // First tap: start measuring
        const clampedPoint = clampToChartArea({ x, y });
        setMeasureState({ start: clampedPoint, current: clampedPoint, frozen: false });
      } else {
        // Second tap: freeze the measurement and deselect tool
        setMeasureState(prev => prev ? { ...prev, frozen: true } : null);
        onToolSelect?.(null);
      }
      return;
    }

    // Try drawing hit-test FIRST, before checking the OHLC zone.
    // Previously, clicks in the top 30px were blanket-rejected to let OHLC
    // toggle clicks pass through. But this also blocked selecting/dragging
    // drawings near the top of the chart. Now we try the hit-test first;
    // if a drawing is under the cursor, handle it. Only fall through to
    // the OHLC pass-through if no drawing was hit.
    if (handlePointerDown(x, y, e.clientX, e.clientY)) {
      e.preventDefault();
      return;
    }

    // If no drawing was hit and click is in the OHLC/indicator label area
    // (top ~30px), let it pass through to ProChart's toggle button underneath.
    // This preserves OHLC toggle functionality while still allowing drawings
    // near the top of the chart to be selected and dragged.
    if (y < 30 && !activeTool && !draggingId) return;
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const touch = e.touches[0];
    // Cache rect on touch start so subsequent touchmove events use the same
    // reference frame, preventing iOS Safari toolbar/viewport shifts from
    // causing 2-3px coordinate jumps during a single touch gesture.
    cachedRectRef.current = containerRef.current.getBoundingClientRect();
    const rect = cachedRectRef.current;
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;

    // Clear frozen measurement on any tap
    if (measureState?.frozen) {
      setMeasureState(null);
      return;
    }

    // Check if touch is in chart area (not on axis)
    if (!isPointInChartArea(x, y)) {
      return; // Don't start drawing on axis areas
    }

    // Handle measure tool - tap logic: start -> freeze
    if (activeTool === 'measure') {
      e.preventDefault();
      if (!measureState) {
        // First tap: start measuring
        const clampedPoint = clampToChartArea({ x, y });
        setMeasureState({ start: clampedPoint, current: clampedPoint, frozen: false });
      } else {
        // Second tap: freeze the measurement and deselect tool
        setMeasureState(prev => prev ? { ...prev, frozen: true } : null);
        onToolSelect?.(null);
      }
      return;
    }

    // PRIORITY: If user has an active drawing tool, start drawing instead of interacting with existing drawings
    const twoPointDrawingTools: DrawingTool[] = ['trend', 'trendRay', 'line', 'straightArrow', 'fibonacci', 'fibExtension', 'rectangle', 'square', 'circle', 'oval', 'triangle', 'diamond', 'pentagon', 'hexagon', 'star', 'cross', 'arrowBlock', 'wedge', 'heart', 'long', 'short', 'parallelChannel'];
    if (activeTool && twoPointDrawingTools.includes(activeTool)) {
      // Skip existing drawing detection - proceed to drawing logic below
    } else if (handlePointerDown(x, y, touch.clientX, touch.clientY)) {
      // Check if we're interacting with existing drawings (only when no active drawing tool)
      e.preventDefault();
      return;
    }

    // For drawing tools that require two points, start tap-hold-drag behavior
    if (activeTool && twoPointDrawingTools.includes(activeTool)) {
      e.preventDefault();
      const clampedPoint = clampToChartArea({ x, y });
      touchStartPointRef.current = clampedPoint;

      // Start a timer for hold detection (150ms - quick enough to feel responsive)
      touchHoldTimerRef.current = setTimeout(() => {
        if (touchStartPointRef.current) {
          // Start drawing immediately with same start and end point
          setTouchDrawing({
            startPoint: touchStartPointRef.current,
            currentPoint: touchStartPointRef.current
          });
        }
      }, 150);
    } else if (isBrushTool(activeTool)) {
      // handlePointerDown already handles brush tool - checks for existing brush first
      // If we got here, handlePointerDown returned false which means it either:
      // 1. Started dragging an existing brush (returns true, we wouldn't be here)
      // 2. Started a new brush (returns true, we wouldn't be here)  
      // 3. Didn't handle it (returns false)
      // Since handlePointerDown now handles brush completely, we don't need to do anything here
      // The brush drawing is started in handlePointerDown
    }
  };

  // Unified pointer up handler for both mouse and touch
  const handlePointerUp = () => {
    // Flush any pending RAF updates immediately for final position accuracy
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (pendingDrawingUpdateRef.current) {
      onDrawingsChange(pendingDrawingUpdateRef.current);
      pendingDrawingUpdateRef.current = null;
    }

    // Handle brush drawing completion
    if (isBrushTool(activeTool) && isDrawingBrushRef.current && brushPath.length > 1) {
      // Convert ALL brush pixel points to chart coordinates
      // This ensures the brush scales correctly with zoom/pan
      const brushChartPoints: ChartPoint[] = brushPath
        .map(p => pixelToChart(p))
        .filter((cp): cp is ChartPoint => cp !== null);

      if (brushChartPoints.length > 1) {
        const newDrawingId = Date.now().toString();
        // Use pre-placement settings bar values if available, otherwise fall back
        // to the per-brush-type defaults (e.g. highlighter = yellow, thick, semi-transparent)
        const newDrawing: Drawing = {
          id: newDrawingId,
          type: activeTool, // Store the specific brush tool type
          points: [brushChartPoints[0]], // Store first point for compatibility
          color: toolSettings?.color ?? getBrushToolColor(activeTool),
          opacity: toolSettings?.opacity ?? getBrushToolOpacity(activeTool),
          strokeWidth: toolSettings?.strokeWidth ?? getBrushToolStrokeWidth(activeTool),
          brushChartPoints // Store ALL points in chart coordinates for proper zoom scaling
        };
        onDrawingsChange([...drawings, newDrawing]);
        // Auto-select the newly created brush drawing
        onSelectDrawing?.(newDrawingId);
      }
      setBrushPath([]);
      isDrawingBrushRef.current = false;
      onToolSelect?.(null); // Auto-deselect brush tool
    }

    // Reset brush state even if brush path was too short
    if (isDrawingBrushRef.current) {
      setBrushPath([]);
      isDrawingBrushRef.current = false;
    }

    // COMMIT FINAL POSITION on drag end (CSS transform approach)
    if (draggingId && dragStartPosRef.current && lastPointerPosRef.current && dragOffset) {
      justFinishedDragging.current = true;

      // Calculate final position based on last cursor position.
      // Adjust X by scroll delta: if chart auto-scrolled during drag,
      // the pixel coordinate frame shifted and we need to compensate.
      const scrollDelta = (scrollOffsetRef?.current ?? 0) - dragStartScrollOffsetRef.current;
      const finalX = lastPointerPosRef.current.x - scrollDelta;
      const finalY = lastPointerPosRef.current.y;

      const drawing = drawings.find((d) => d.id === draggingId);
      if (drawing) {
        const updatedDrawings = drawings.map((d) => {
          if (d.id !== draggingId) return d;

          // PIXEL-BASED MOVE for ALL drawing types (including long/short positions):
          // Convert each point to pixel, add the pixel delta, convert back to
          // chart coordinates. This guarantees the shape stays identical in pixel
          // space because every point shifts by the exact same pixel offset.
          // Chart-coordinate deltas distort long/short drawings because xToTime()
          // snaps to bar boundaries, causing the drawing to jump to discrete bar
          // positions on horizontal movement and change visual width when bars
          // have non-uniform pixel spacing (weekends, gaps).
          const pixDeltaX = finalX - (dragStartPosRef.current!.x - scrollDelta);
          let pixDeltaY = finalY - dragStartPosRef.current!.y;
          // For 'horizontal': lock X movement (line spans full width, only moves vertically)
          const effectivePixDeltaX = d.type === 'horizontal' ? 0 : pixDeltaX;
          // 'line' (straight line) allows free movement in both axes, no Y lock needed

          const updatedPoints = d.points.map(p => {
            const px = chartToPixel(p);
            if (!px) return p;
            const moved = pixelToChart({ x: px.x + effectivePixDeltaX, y: px.y + pixDeltaY });
            return moved || p;
          });

          let updatedStopLoss = d.stopLoss;
          if (d.stopLoss) {
            const slPx = chartToPixel(d.stopLoss);
            if (slPx) {
              updatedStopLoss = pixelToChart({ x: slPx.x + effectivePixDeltaX, y: slPx.y + pixDeltaY }) || d.stopLoss;
            }
          }

          let updatedBrushChartPoints = d.brushChartPoints;
          if (d.brushChartPoints && d.brushChartPoints.length > 0) {
            updatedBrushChartPoints = d.brushChartPoints.map(p => {
              const px = chartToPixel(p);
              if (!px) return p;
              return pixelToChart({ x: px.x + effectivePixDeltaX, y: px.y + pixDeltaY }) || p;
            });
          }

          let updatedBrushPixelPoints = d.brushPixelPoints;
          if (d.brushPixelPoints && d.brushPixelPoints.length > 0) {
            updatedBrushPixelPoints = d.brushPixelPoints.map(p => ({
              x: p.x + effectivePixDeltaX,
              y: p.y + pixDeltaY
            }));
          }

          return { ...d, points: updatedPoints, stopLoss: updatedStopLoss, brushChartPoints: updatedBrushChartPoints, brushPixelPoints: updatedBrushPixelPoints };
        });

        onDrawingsChange(updatedDrawings);
      }

      // Reset CSS transform AFTER committing position
      const svgGroup = document.getElementById(`${clipIdRef.current}_drawing-${draggingId}`);
      if (svgGroup) {
        svgGroup.style.transform = '';
        svgGroup.style.willChange = '';
      }
      // Reset touch grab dot transform and hide it

      setTimeout(() => {
        justFinishedDragging.current = false;
      }, 0);
    } else if (draggingId) {
      // Fallback: just reset transform if we don't have position data
      justFinishedDragging.current = true;
      const svgGroup = document.getElementById(`${clipIdRef.current}_drawing-${draggingId}`);
      if (svgGroup) {
        svgGroup.style.transform = '';
        svgGroup.style.willChange = '';
      }
      setTimeout(() => {
        justFinishedDragging.current = false;
      }, 0);
    }

    // Reset drag transform refs
    dragTransformRef.current = { deltaX: 0, deltaY: 0 };
    dragStartPosRef.current = null;
    dragStartChartRef.current = null;
    dragStartScrollOffsetRef.current = 0;
    cachedRectRef.current = null; // Invalidate cached rect after drag

    isDraggingRef.current = false;
    lastPointerPosRef.current = null;
    setDraggingId(null);
    setDragOffset(null);
    setDragPointIndex(null);
    // Pair the (true) call from startDragging at line 446. Without this, the
    // parent's isDrawingDragging stays true forever after the first drag, which
    // permanently gates ProChart's main drawChart-on-prop-change effect (the
    // `if (!isDrawingDragging) drawChart()` block). On pairs with no live tick
    // (e.g. forex/metals after market close) the canvas then freezes on the
    // next prop change because the livePrice fallback redraw never fires.
    onDraggingStateChange?.(false);

    // Hide crosshair via direct DOM to match how it was shown during dragging
    hideCrosshair();
  };

  const handleMouseUp = () => {
    // Don't auto-clear measure state - handled by tap logic
    setCursorPosition(null); // Clear crosshair on mouse up
    // Also hide via direct DOM to ensure crosshair is gone (matches how it was shown)
    hideCrosshair();
    handlePointerUp();
  };

  const handleMouseLeave = () => {
    setCursorPosition(null); // Clear crosshair when mouse leaves
    hideCrosshair();
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    // Clear the hold timer
    if (touchHoldTimerRef.current) {
      clearTimeout(touchHoldTimerRef.current);
      touchHoldTimerRef.current = null;
    }

    // If we were doing a touch drawing, create the drawing now
    if (touchDrawing && activeTool) {
      const startChart = pixelToChart(touchDrawing.startPoint);
      const endChart = pixelToChart(touchDrawing.currentPoint);

      if (startChart && endChart) {
        // Only create if user actually dragged (not just a tap)
        const distance = Math.sqrt(
          Math.pow(touchDrawing.currentPoint.x - touchDrawing.startPoint.x, 2) +
          Math.pow(touchDrawing.currentPoint.y - touchDrawing.startPoint.y, 2)
        );

        if (distance > 10) { // Minimum drag distance to create drawing
          if (activeTool === 'long' || activeTool === 'short') {
            // Create long/short position with stop loss
            const entryChart = startChart;
            const targetChart = endChart;

            // For shorts, ensure target is below entry; for longs, above
            let finalTargetPrice = targetChart.price;
            if (activeTool === 'short' && targetChart.price > entryChart.price) {
              const dist = targetChart.price - entryChart.price;
              finalTargetPrice = entryChart.price - dist;
            } else if (activeTool === 'long' && targetChart.price < entryChart.price) {
              const dist = entryChart.price - targetChart.price;
              finalTargetPrice = entryChart.price + dist;
            }

            const finalTarget: ChartPoint = { time: targetChart.time, price: finalTargetPrice };
            const priceDist = Math.abs(finalTargetPrice - entryChart.price);
            const stopLossPrice = activeTool === 'long'
              ? entryChart.price - priceDist
              : entryChart.price + priceDist;

            const stopLossChart: ChartPoint = { time: entryChart.time, price: stopLossPrice };

            const newDrawingId = Date.now().toString();
            const newDrawing: Drawing = {
              id: newDrawingId,
              type: activeTool,
              points: [entryChart, finalTarget],
              stopLoss: stopLossChart,
              stopLossPointIndex: 999,
              color: '#22c55e', // Profit zone color (green) - same for both long and short
              fillColor: '#ef4444', // Loss zone color (red) - same for both long and short
            };
            onDrawingsChange([...drawings, newDrawing]);
            onSelectDrawing?.(newDrawingId); // Auto-select newly created drawing
          } else {
            // Create trend, fibonacci, or shape
            // For square/circle on touch: constrain end point so pixel w === h
            let finalEndChartTouch = endChart;
            if (activeTool === 'square' || activeTool === 'circle') {
              const sp = touchDrawing.startPoint;
              const ep = touchDrawing.currentPoint;
              const dx = Math.abs(ep.x - sp.x);
              const dy = Math.abs(ep.y - sp.y);
              const size = Math.max(dx, dy);
              const cx = sp.x + (ep.x >= sp.x ? size : -size);
              const cy = sp.y + (ep.y >= sp.y ? size : -size);
              const constrained = pixelToChart({ x: cx, y: cy });
              if (constrained) finalEndChartTouch = constrained;
            }
            const isShape = activeTool === 'rectangle' || activeTool === 'square' || activeTool === 'circle' || activeTool === 'oval' || activeTool === 'triangle' || activeTool === 'diamond' || activeTool === 'pentagon' || activeTool === 'hexagon' || activeTool === 'star' || activeTool === 'cross' || activeTool === 'arrowBlock' || activeTool === 'wedge' || activeTool === 'heart';
            const newDrawingId = Date.now().toString();
            // Apply pre-placement settings bar values for color, stroke, line style, fill
            const newDrawing: Drawing = {
              id: newDrawingId,
              type: activeTool,
              points: [startChart, finalEndChartTouch],
              color: getNewDrawingColor(),
              strokeWidth: getNewDrawingStrokeWidth(),
              lineStyle: getNewDrawingLineStyle(),
              opacity: getNewDrawingOpacity(),
              fillColor: isShape ? getNewDrawingFillColor('#94a3b8') : undefined,
              fillOpacity: isShape ? getNewDrawingFillOpacity() : undefined,
              fibLevels: activeTool === 'fibExtension'
                ? [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2.0, 2.618]
                : activeTool === 'fibonacci'
                  ? [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
                  : undefined,
            };
            onDrawingsChange([...drawings, newDrawing]);
            onSelectDrawing?.(newDrawingId); // Auto-select newly created drawing
          }
          onToolSelect?.(null); // Auto-deselect tool after drawing
        }
      }

      setTouchDrawing(null);
      touchStartPointRef.current = null;
      return;
    }

    // Handle tap for drawing tools (simulate click)
    if (!draggingId && !isDrawingBrushRef.current && !touchDrawing && e.changedTouches.length > 0) {
      const touch = e.changedTouches[0];
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const x = touch.clientX - rect.left;
        const y = touch.clientY - rect.top;

        // Only handle tap if within chart area
        if (isPointInChartArea(x, y)) {
          handleTap(x, y);
        }
      }
    }

    touchStartPointRef.current = null;
    setCursorPosition(null); // Clear crosshair on touch end (prevents blue cursor persisting on iPhone)
    // Also hide via direct DOM to ensure crosshair is gone (matches how it was shown)
    hideCrosshair();
    handlePointerUp();
  };

  // Handle tap/click for drawing tools
  const handleTap = (x: number, y: number) => {
    if (!containerRef.current || draggingId || justFinishedDragging.current) return;

    const chartPoint = pixelToChart({ x, y });
    if (!chartPoint) return;

    // If no active tool, do nothing (pointer-events are disabled anyway)
    if (!activeTool) {
      return;
    }

    if (activeTool === 'horizontal') {
      const newDrawingId = Date.now().toString();
      // Apply pre-placement settings bar values
      const newDrawing: Drawing = {
        id: newDrawingId,
        type: 'horizontal',
        points: [chartPoint, chartPoint],
        color: getNewDrawingColor(),
        strokeWidth: getNewDrawingStrokeWidth(),
        lineStyle: getNewDrawingLineStyle(),
        opacity: getNewDrawingOpacity(),
      };
      onDrawingsChange([...drawings, newDrawing]);
      onSelectDrawing?.(newDrawingId); // Auto-select newly created drawing
      onToolSelect?.(null);
      return;
    }

    // Straight arrow uses two-point creation like trend line
    if (activeTool === 'straightArrow') {
      if (tempPoints.length === 0) {
        setTempPoints([{ x, y }]);
      } else {
        const startPixel = tempPoints[0];
        const endPixel = { x, y };

        const startChart = pixelToChart(startPixel);
        const endChart = pixelToChart(endPixel);
        if (!startChart || !endChart) return;

        const newDrawingId = Date.now().toString();
        // Apply pre-placement settings bar values
        const newDrawing: Drawing = {
          id: newDrawingId,
          type: 'straightArrow',
          points: [startChart, endChart],
          color: getNewDrawingColor(),
          strokeWidth: getNewDrawingStrokeWidth(),
          lineStyle: getNewDrawingLineStyle(),
          opacity: getNewDrawingOpacity(),
        };
        onDrawingsChange([...drawings, newDrawing]);
        onSelectDrawing?.(newDrawingId);
        setTempPoints([]);
        setPreviewPoint(null);
        onToolSelect?.(null);
      }
      return;
    }

    if (activeTool === 'horizontalRay') {
      const newDrawingId = Date.now().toString();
      // Apply pre-placement settings bar values
      const newDrawing: Drawing = {
        id: newDrawingId,
        type: 'horizontalRay',
        points: [chartPoint],
        color: getNewDrawingColor(),
        strokeWidth: getNewDrawingStrokeWidth(),
        lineStyle: getNewDrawingLineStyle(),
        opacity: getNewDrawingOpacity(),
      };
      onDrawingsChange([...drawings, newDrawing]);
      onSelectDrawing?.(newDrawingId);
      onToolSelect?.(null);
      return;
    }

    if (activeTool === 'vertical') {
      const newDrawingId = Date.now().toString();
      // Apply pre-placement settings bar values
      const newDrawing: Drawing = {
        id: newDrawingId,
        type: 'vertical',
        points: [chartPoint],
        color: getNewDrawingColor(),
        strokeWidth: getNewDrawingStrokeWidth(),
        lineStyle: getNewDrawingLineStyle(),
        opacity: getNewDrawingOpacity(),
      };
      onDrawingsChange([...drawings, newDrawing]);
      onSelectDrawing?.(newDrawingId); // Auto-select newly created drawing
      onToolSelect?.(null);
      return;
    }

    if (activeTool === 'long' || activeTool === 'short') {
      if (tempPoints.length === 0) {
        setTempPoints([{ x, y }]);
      } else if (tempPoints.length === 1) {
        const entryPixel = tempPoints[0];
        const targetPixel = { x, y };

        const entryChart = pixelToChart(entryPixel);
        const targetChart = pixelToChart(targetPixel);
        if (!entryChart || !targetChart) return;

        // For shorts, ensure target is below entry (profit when price drops)
        // For longs, ensure target is above entry (profit when price rises)
        let finalTargetPrice = targetChart.price;
        if (activeTool === 'short' && targetChart.price > entryChart.price) {
          // User clicked above entry on short - flip it below
          const distance = targetChart.price - entryChart.price;
          finalTargetPrice = entryChart.price - distance;
        } else if (activeTool === 'long' && targetChart.price < entryChart.price) {
          // User clicked below entry on long - flip it above
          const distance = entryChart.price - targetChart.price;
          finalTargetPrice = entryChart.price + distance;
        }

        const finalTarget: ChartPoint = {
          time: targetChart.time,
          price: finalTargetPrice
        };

        const distance = Math.abs(finalTargetPrice - entryChart.price);
        const stopLossPrice = activeTool === 'long'
          ? entryChart.price - distance
          : entryChart.price + distance;

        const stopLossChart: ChartPoint = {
          time: entryChart.time,
          price: stopLossPrice
        };

        const newDrawingId = Date.now().toString();
        const newDrawing: Drawing = {
          id: newDrawingId,
          type: activeTool,
          points: [entryChart, finalTarget],
          stopLoss: stopLossChart,
          stopLossPointIndex: 999,
          color: '#22c55e', // Profit zone color (green) - same for both long and short
          fillColor: '#ef4444', // Loss zone color (red) - same for both long and short
        };
        onDrawingsChange([...drawings, newDrawing]);
        onSelectDrawing?.(newDrawingId); // Auto-select newly created drawing
        setTempPoints([]);
        onToolSelect?.(null);
      }
      return;
    }

    if (activeTool === 'text') {
      setTextInput({ x, y, value: '' });
      return;
    }

    if (activeTool === 'trend' || activeTool === 'trendRay' || activeTool === 'line' || activeTool === 'fibonacci' || activeTool === 'fibExtension' || activeTool === 'rectangle' || activeTool === 'square' || activeTool === 'circle' || activeTool === 'oval' || activeTool === 'triangle' || activeTool === 'parallelogram' || activeTool === 'octagon' || activeTool === 'diamond' || activeTool === 'pentagon' || activeTool === 'hexagon' || activeTool === 'star' || activeTool === 'cross' || activeTool === 'arrowBlock' || activeTool === 'wedge' || activeTool === 'heart') {
      if (tempPoints.length === 0) {
        setTempPoints([{ x, y }]);
      } else {
        const startPixel = tempPoints[0];
        // For 'line' tool: lock Y to start point (perfectly horizontal)
        const endPixel = activeTool === 'line' ? { x, y: startPixel.y } : { x, y };

        const startChart = pixelToChart(startPixel);
        const endChart = pixelToChart(endPixel);
        if (!startChart || !endChart) return;

        // For square/circle: adjust the end point so pixel width === pixel height.
        // The preview already shows a constrained shape, but the stored chart coords
        // must also be constrained or the shape distorts on render.
        let finalEndChart = endChart;
        if (activeTool === 'square' || activeTool === 'circle') {
          const dx = Math.abs(endPixel.x - startPixel.x);
          const dy = Math.abs(endPixel.y - startPixel.y);
          const size = Math.max(dx, dy);
          // Keep direction from start to end, but enforce equal pixel dimensions
          const constrainedX = startPixel.x + (endPixel.x >= startPixel.x ? size : -size);
          const constrainedY = startPixel.y + (endPixel.y >= startPixel.y ? size : -size);
          const constrained = pixelToChart({ x: constrainedX, y: constrainedY });
          if (constrained) finalEndChart = constrained;
        }

        const isShape = activeTool === 'rectangle' || activeTool === 'square' || activeTool === 'circle' || activeTool === 'oval' || activeTool === 'triangle' || activeTool === 'parallelogram' || activeTool === 'octagon' || activeTool === 'diamond' || activeTool === 'pentagon' || activeTool === 'hexagon' || activeTool === 'star' || activeTool === 'cross' || activeTool === 'arrowBlock' || activeTool === 'wedge' || activeTool === 'heart';
        const newDrawingId = Date.now().toString();
        // Apply pre-placement settings bar values for color, stroke, line style, fill
        const newDrawing: Drawing = {
          id: newDrawingId,
          type: activeTool,
          points: [startChart, finalEndChart],
          color: getNewDrawingColor(),
          strokeWidth: getNewDrawingStrokeWidth(),
          lineStyle: getNewDrawingLineStyle(),
          opacity: getNewDrawingOpacity(),
          fillColor: isShape ? getNewDrawingFillColor('#94a3b8') : undefined,
          fillOpacity: isShape ? getNewDrawingFillOpacity() : undefined,
          fibLevels: activeTool === 'fibExtension'
            ? [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2.0, 2.618]
            : activeTool === 'fibonacci'
              ? [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
              : undefined,
        };
        onDrawingsChange([...drawings, newDrawing]);
        onSelectDrawing?.(newDrawingId); // Auto-select newly created drawing
        setTempPoints([]);
        setPreviewPoint(null);
        onToolSelect?.(null);
      }
      return;
    }

    // Free Triangle - requires 3 clicks for 3 independent corners
    if (activeTool === 'freeTriangle') {
      if (tempPoints.length < 2) {
        setTempPoints([...tempPoints, { x, y }]);
      } else {
        // Third click - create the triangle
        const p1 = pixelToChart(tempPoints[0]);
        const p2 = pixelToChart(tempPoints[1]);
        const p3 = pixelToChart({ x, y });
        if (!p1 || !p2 || !p3) return;

        const newDrawingId = Date.now().toString();
        // Apply pre-placement settings bar values
        const newDrawing: Drawing = {
          id: newDrawingId,
          type: 'freeTriangle',
          points: [p1, p2, p3],
          color: getNewDrawingColor(),
          strokeWidth: getNewDrawingStrokeWidth(),
          lineStyle: getNewDrawingLineStyle(),
          opacity: getNewDrawingOpacity(),
          fillColor: getNewDrawingFillColor('#94a3b8'),
          fillOpacity: getNewDrawingFillOpacity(),
        };
        onDrawingsChange([...drawings, newDrawing]);
        onSelectDrawing?.(newDrawingId);
        setTempPoints([]);
        setPreviewPoint(null);
        onToolSelect?.(null);
      }
      return;
    }

    // Parallel Channel - requires 3 clicks: first two define the base line, third defines the channel width
    if (activeTool === 'parallelChannel') {
      if (tempPoints.length < 2) {
        setTempPoints([...tempPoints, { x, y }]);
      } else {
        // Third click - create the channel
        const p1 = pixelToChart(tempPoints[0]);
        const p2 = pixelToChart(tempPoints[1]);
        const p3 = pixelToChart({ x, y });
        if (!p1 || !p2 || !p3) return;

        const newDrawingId = Date.now().toString();
        // Apply pre-placement settings bar values
        const newDrawing: Drawing = {
          id: newDrawingId,
          type: 'parallelChannel',
          points: [p1, p2, p3],
          color: getNewDrawingColor(),
          strokeWidth: getNewDrawingStrokeWidth(),
          lineStyle: getNewDrawingLineStyle(),
          opacity: getNewDrawingOpacity(),
          fillColor: getNewDrawingFillColor('#64748b'),
          fillOpacity: getNewDrawingFillOpacity(),
        };
        onDrawingsChange([...drawings, newDrawing]);
        onSelectDrawing?.(newDrawingId);
        setTempPoints([]);
        setPreviewPoint(null);
        onToolSelect?.(null);
      }
      return;
    }
  };

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // Reject clicks in the price axis area
    const chartWidth = rect.width - chartBounds.priceAxisWidth;
    if (x > chartWidth) return;
    // handleTap handles new drawing placement (requires active tool).
    // The OHLC pass-through for the top 30px is now handled in handleMouseDown
    // after the drawing hit-test, so we don't need to block it here.
    // When no tool is active, handleTap is a no-op anyway.
    handleTap(x, y);
  };

  const handleTextSubmit = () => {
    if (!textInput || !textInput.value.trim()) {
      setTextInput(null);
      onToolSelect?.(null);
      return;
    }

    const chartPoint = pixelToChart({ x: textInput.x, y: textInput.y });
    if (!chartPoint) {
      onToolSelect?.(null);
      return;
    }

    const newDrawingId = Date.now().toString();
    // Text uses the pre-placement color if available
    const newDrawing: Drawing = {
      id: newDrawingId,
      type: 'text',
      points: [chartPoint],
      text: textInput.value,
      color: getNewDrawingColor(),
      opacity: getNewDrawingOpacity(),
    };
    onDrawingsChange([...drawings, newDrawing]);
    onSelectDrawing?.(newDrawingId); // Auto-select newly created drawing
    setTextInput(null);
    onToolSelect?.(null);
  };

  const handleDeleteDrawing = (id: string) => {
    onDrawingsChange(drawings.filter((d) => d.id !== id));
  };

  // Midpoint dot: renders a small circle at the center of a two-point drawing
  // when selected. Visual affordance showing the drawing is active and draggable.
  // Sits inside the drawing's <g> so it moves with CSS transform3d during drag.
  const renderMidpointDot = (pixels: PixelPoint[], drawingColor: string, drawingType: string) => {
    if (pixels.length < 2) return null;
    const lineTypes = ['trend', 'trendRay', 'line', 'straightArrow', 'horizontal', 'horizontalRay', 'fibonacci', 'fibExtension', 'parallelChannel'];
    if (!lineTypes.includes(drawingType)) return null;
    const midX = (pixels[0].x + pixels[1].x) / 2;
    const midY = (pixels[0].y + pixels[1].y) / 2;
    return (
      <g style={{ pointerEvents: 'none' }}>
        <circle cx={midX} cy={midY} r={11} fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5" />
        <circle cx={midX} cy={midY} r={4.5} fill="white" fillOpacity={0.8} stroke="rgba(0,0,0,0.2)" strokeWidth="1" />
      </g>
    );
  };

  const beginEditLabel = (drawingId: string, currentText: string) => {
    setLabelDraft(currentText);
    setEditingLabelId(drawingId);
  };

  const commitLabel = () => {
    if (!editingLabelId) return;
    const trimmed = labelDraft.trim();
    const updated = drawings.map((d) =>
      d.id === editingLabelId ? { ...d, text: trimmed || undefined } : d,
    );
    onDrawingsChange(updated);
    setEditingLabelId(null);
    setLabelDraft('');
  };

  const cancelLabel = () => {
    setEditingLabelId(null);
    setLabelDraft('');
  };

  // Inline label states: edit mode shows an input via foreignObject; saved text shows as SVG text (dblclick reopens edit); selected with no text shows the "+ Add text" hint.
  const renderInlineLabel = (
    drawing: Drawing,
    anchorX: number,
    anchorY: number,
    color: string,
  ) => {
    const isEditing = editingLabelId === drawing.id;
    const hasText = !!(drawing.text && drawing.text.length > 0);
    const isSel = selectedDrawingId === drawing.id;

    // All three states use foreignObject because an SVG <text> only hit-tests on glyph fills, which lets clicks between letters slip through to the chart and deselect the drawing. A foreignObject with a real DOM child gives a uniform click area.
    const labelFontSize = drawing.textFontSize ?? 13;
    const boxWidth = 240;
    const boxHeight = Math.max(28, Math.ceil(labelFontSize * 1.8));
    const foX = anchorX - boxWidth / 2;
    const foY = anchorY - boxHeight / 2;

    if (isEditing) {
      return (
        <foreignObject x={foX} y={foY} width={boxWidth} height={boxHeight} style={{ overflow: 'visible' }}>
          <input
            ref={labelInputRef}
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitLabel();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelLabel();
              }
              e.stopPropagation();
            }}
            onKeyUp={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            placeholder="Text"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: 'rgba(255,255,255,0.96)',
              border: '1px solid #94a3b8',
              borderRadius: 4,
              padding: '2px 6px',
              fontSize: labelFontSize,
              fontWeight: drawing.textBold ? 700 : 400,
              fontStyle: drawing.textItalic ? 'italic' : 'normal',
              color: '#0f172a',
              outline: 'none',
              textAlign: 'center',
              fontFamily: 'inherit',
            }}
          />
        </foreignObject>
      );
    }

    if (hasText) {
      const labelBold = drawing.textBold ?? false;
      const labelItalic = drawing.textItalic ?? false;
      const labelColor = drawing.textColor || color;
      return (
        <foreignObject x={foX} y={foY} width={boxWidth} height={boxHeight} style={{ overflow: 'visible', pointerEvents: 'none' }}>
          <div
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => {
              e.stopPropagation();
              beginEditLabel(drawing.id, drawing.text || '');
            }}
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'text',
              userSelect: 'none',
              color: labelColor,
              fontSize: labelFontSize,
              fontWeight: labelBold ? 700 : 500,
              fontStyle: labelItalic ? 'italic' : 'normal',
              fontFamily: 'inherit',
              pointerEvents: 'auto',
              whiteSpace: 'nowrap',
            }}
          >
            {drawing.text}
          </div>
        </foreignObject>
      );
    }

    if (isSel) {
      return (
        <foreignObject x={foX} y={foY} width={boxWidth} height={boxHeight} style={{ overflow: 'visible', pointerEvents: 'none' }}>
          <div
            onMouseDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              beginEditLabel(drawing.id, '');
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'text',
              userSelect: 'none',
              color: '#94a3b8',
              fontSize: 12,
              fontStyle: 'italic',
              fontFamily: 'inherit',
              opacity: 0.85,
              pointerEvents: 'auto',
              whiteSpace: 'nowrap',
            }}
          >
            + Add text
          </div>
        </foreignObject>
      );
    }

    return null;
  };

  const renderDrawing = (drawing: Drawing) => {
    const pixels = drawing.points.map(chartToPixel).filter((p): p is PixelPoint => p !== null);
    if (pixels.length === 0) return null;

    const isHovered = hoveredDrawingId === drawing.id;
    const isSelected = selectedDrawingId === drawing.id;
    const showHandles = isSelected;

    // Calculate opacity (default to 100 = full opacity)
    const strokeOpacity = (drawing.opacity ?? 100) / 100;
    const fillOpacityValue = (drawing.fillOpacity ?? 100) / 100;

    // Use drawing's color/strokeWidth or fall back to defaults
    const drawingColor = drawing.color || DEFAULT_DRAWING_COLOR;
    const drawingStrokeWidth = drawing.strokeWidth || DEFAULT_STROKE_WIDTH;

    // Midpoint dot for selected drawings on touch devices (rendered inside
    // the drawing's <g> group so it moves with the drawing during drag)
    const midpointDot = isSelected ? renderMidpointDot(pixels, drawingColor || '#ffffff', drawing.type || '') : null;

    if (drawing.type === 'horizontal') {
      if (pixels.length < 1) return null;
      const y = pixels[0].y;
      const containerWidth = containerRef.current?.clientWidth || 1000;
      const chartWidth = containerWidth - chartBounds.priceAxisWidth;

      return (
        <g key={drawing.id} id={`${clipId}_drawing-${drawing.id}`}>
          <line
            x1={0}
            y1={y}
            x2={chartWidth}
            y2={y}
            stroke={drawingColor}
            strokeWidth={drawingStrokeWidth}
            strokeDasharray={getStrokeDashArray(drawing.lineStyle)}
            onMouseEnter={() => setHoveredDrawingId(drawing.id)}
            onMouseLeave={() => setHoveredDrawingId(null)}
            style={{ cursor: 'move', pointerEvents: 'stroke', strokeWidth: 10, opacity: 0 }}
          />
          <line
            x1={0}
            y1={y}
            x2={chartWidth}
            y2={y}
            stroke={drawingColor}
            strokeWidth={drawingStrokeWidth}
            strokeDasharray={getStrokeDashArray(drawing.lineStyle)}
            strokeOpacity={strokeOpacity}
            style={{ pointerEvents: 'none' }}
          />
          {showHandles && (
            <>
              <circle cx={50} cy={y} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'ns-resize', pointerEvents: 'all' }} />
              <circle cx={chartWidth - 50} cy={y} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'ns-resize', pointerEvents: 'all' }} />
              {midpointDot}
            </>
          )}

        </g>
      );
    }

    if (drawing.type === 'straightArrow') {
      if (pixels.length < 2) return null;
      const [p1, p2] = pixels;

      // Calculate arrowhead
      const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
      const arrowLength = 12;
      const arrowAngle = Math.PI / 6; // 30 degrees

      const arrowX1 = p2.x - arrowLength * Math.cos(angle - arrowAngle);
      const arrowY1 = p2.y - arrowLength * Math.sin(angle - arrowAngle);
      const arrowX2 = p2.x - arrowLength * Math.cos(angle + arrowAngle);
      const arrowY2 = p2.y - arrowLength * Math.sin(angle + arrowAngle);

      return (
        <g key={drawing.id} id={`${clipId}_drawing-${drawing.id}`}>
          {/* Invisible wider hit area */}
          <line
            x1={p1.x}
            y1={p1.y}
            x2={p2.x}
            y2={p2.y}
            stroke="transparent"
            strokeWidth={15}
            style={{ cursor: 'move', pointerEvents: 'stroke' }}
            onMouseEnter={() => setHoveredDrawingId(drawing.id)}
            onMouseLeave={() => setHoveredDrawingId(null)}
          />
          {/* Visible line */}
          <line
            x1={p1.x}
            y1={p1.y}
            x2={p2.x}
            y2={p2.y}
            stroke={drawingColor}
            strokeWidth={drawingStrokeWidth}
            strokeDasharray={getStrokeDashArray(drawing.lineStyle)}
            strokeOpacity={strokeOpacity}
            style={{ pointerEvents: 'none' }}
          />
          {/* Arrowhead */}
          <polygon
            points={`${p2.x},${p2.y} ${arrowX1},${arrowY1} ${arrowX2},${arrowY2}`}
            fill={drawingColor}
            fillOpacity={strokeOpacity}
            style={{ pointerEvents: 'none' }}
          />
          {showHandles && (
            <>
              <circle cx={p1.x} cy={p1.y} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'move', pointerEvents: 'all' }} />
              <circle cx={p2.x} cy={p2.y} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'move', pointerEvents: 'all' }} />
              {midpointDot}
            </>
          )}
        </g>
      );
    }

    if (drawing.type === 'horizontalRay') {
      if (pixels.length < 1) return null;
      const y = pixels[0].y;
      const startX = pixels[0].x;
      const containerWidth = containerRef.current?.clientWidth || 1000;
      const chartWidth = containerWidth - chartBounds.priceAxisWidth;

      return (
        <g key={drawing.id} id={`${clipId}_drawing-${drawing.id}`}>
          <line
            x1={startX}
            y1={y}
            x2={chartWidth}
            y2={y}
            stroke={drawingColor}
            strokeWidth={drawingStrokeWidth}
            strokeDasharray={getStrokeDashArray(drawing.lineStyle)}
            onMouseEnter={() => setHoveredDrawingId(drawing.id)}
            onMouseLeave={() => setHoveredDrawingId(null)}
            style={{ cursor: 'move', pointerEvents: 'stroke', strokeWidth: 10, opacity: 0 }}
          />
          <line
            x1={startX}
            y1={y}
            x2={chartWidth}
            y2={y}
            stroke={drawingColor}
            strokeWidth={drawingStrokeWidth}
            strokeDasharray={getStrokeDashArray(drawing.lineStyle)}
            strokeOpacity={strokeOpacity}
            style={{ pointerEvents: 'none' }}
          />
          {showHandles && (
            <>
              <circle cx={startX} cy={y} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'move', pointerEvents: 'all' }} />
            </>
          )}
        </g>
      );
    }

    if (drawing.type === 'vertical') {
      if (pixels.length < 1) return null;
      const x = pixels[0].x;
      const containerHeight = containerRef.current?.clientHeight || 600;

      return (
        <g key={drawing.id} id={`${clipId}_drawing-${drawing.id}`}>
          <line
            x1={x}
            y1={0}
            x2={x}
            y2={containerHeight}
            stroke={drawingColor}
            strokeWidth={drawingStrokeWidth}
            strokeDasharray={getStrokeDashArray(drawing.lineStyle)}
            onMouseEnter={() => setHoveredDrawingId(drawing.id)}
            onMouseLeave={() => setHoveredDrawingId(null)}
            style={{ cursor: 'move', pointerEvents: 'stroke', strokeWidth: 10, opacity: 0 }}
          />
          <line
            x1={x}
            y1={0}
            x2={x}
            y2={containerHeight}
            stroke={drawingColor}
            strokeWidth={drawingStrokeWidth}
            strokeDasharray={getStrokeDashArray(drawing.lineStyle)}
            strokeOpacity={strokeOpacity}
            style={{ pointerEvents: 'none' }}
          />
          {showHandles && (
            <>
              <circle cx={x} cy={50} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'ew-resize', pointerEvents: 'all' }} />
              <circle cx={x} cy={containerHeight - 50} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'ew-resize', pointerEvents: 'all' }} />
            </>
          )}
        </g>
      );
    }

    if (drawing.type === 'long' || drawing.type === 'short') {
      if (pixels.length < 2 || !drawing.stopLoss) return null;


      const entryPixel = pixels[0];
      const targetPixel = pixels[1];
      const stopLossPixel = chartToPixel(drawing.stopLoss);
      if (!stopLossPixel) return null;

      const x1 = entryPixel.x;
      const x2 = targetPixel.x;
      const entryY = entryPixel.y;
      const targetY = targetPixel.y;
      const stopLossY = stopLossPixel.y;

      const minX = Math.min(x1, x2);
      const maxX = Math.max(x1, x2);
      const width = Math.max(0, maxX - minX);

      const isLong = drawing.type === 'long';

      // Get actual price values
      const entryPrice = drawing.points[0].price;
      const targetPrice = drawing.points[1].price;
      const stopLossPrice = drawing.stopLoss.price;

      // Format price for display
      const fmtPrice = (p: number) => {
        if (p >= 100) return p.toFixed(2);
        if (p >= 1) return p.toFixed(4);
        return p.toFixed(5);
      };

      // Calculate pips based on instrument type (the usual retail FX/CFD convention)
      // Gold (XAU): pip = $0.10 -> $1 = 10 pips
      // Silver (XAG): pip = $0.01 -> $1 = 100 pips
      // JPY forex pairs: pip = 0.01 -> multiplier 100
      // Standard forex: pip = 0.0001 -> multiplier 10000
      // BTC/USD: pip = $1.00 -> multiplier 1
      // ETH/LTC: pip = $0.01 -> multiplier 100
      // SOL/XRP: pip = $0.0001 -> multiplier 10000
      // DOGE: pip = $0.00001 -> multiplier 100000
      // Indices/stocks: raw points -> multiplier 1
      const sym = currentSymbol?.toUpperCase() || '';
      const isGold = sym.includes('XAU') || sym.includes('GOLD');
      const isSilver = sym.includes('XAG') || sym.includes('SILVER');
      const isIndex = sym.includes('SPX') || sym.includes('NAS') || sym.includes('DJI') || sym.includes('DAX') || sym.includes('FTSE') || sym.includes('NIK') || sym.includes('US500') || sym.includes('US100') || sym.includes('US30');
      const isForex = sym.includes('/') && !sym.includes('BTC') && !sym.includes('ETH') && !sym.includes('LTC') && !sym.includes('XRP') && !sym.includes('SOL') && !sym.includes('DOGE') && !sym.includes('ADA') && !sym.includes('AVAX') && !sym.includes('DOT') && !sym.includes('LINK') && !sym.includes('BNB') && !isGold && !isSilver && !isIndex;
      const isPipJpy = isForex && sym.includes('JPY');

      let pipMultiplier: number;
      let pipLabel: string;

      if (isGold) {
        pipMultiplier = 10;       // $1 = 10 pips
        pipLabel = 'pips';
      } else if (isSilver) {
        pipMultiplier = 100;      // $1 = 100 pips
        pipLabel = 'pips';
      } else if (isIndex) {
        pipMultiplier = 1;        // 1 point = 1 pt
        pipLabel = 'pts';
      } else if (isForex && isPipJpy) {
        pipMultiplier = 100;      // 0.01 = 1 pip
        pipLabel = 'pips';
      } else if (isForex) {
        pipMultiplier = 10000;    // 0.0001 = 1 pip
        pipLabel = 'pips';
      } else {
        // Crypto & stocks: determine by price magnitude (the usual retail FX/CFD convention)
        if (entryPrice >= 1000) {
          pipMultiplier = 1;      // BTC: $1 = 1 pip
        } else if (entryPrice >= 10) {
          pipMultiplier = 100;    // ETH/LTC: $0.01 = 1 pip
        } else if (entryPrice >= 0.1) {
          pipMultiplier = 10000;  // SOL/XRP: $0.0001 = 1 pip
        } else {
          pipMultiplier = 100000; // DOGE: $0.00001 = 1 pip
        }
        pipLabel = 'pips';
      }

      const targetPips = Math.abs(targetPrice - entryPrice) * pipMultiplier;
      const stopLossPips = Math.abs(stopLossPrice - entryPrice) * pipMultiplier;

      // Calculate percentages
      const targetPercent = Math.abs((targetPrice - entryPrice) / entryPrice * 100);
      const stopLossPercent = Math.abs((stopLossPrice - entryPrice) / entryPrice * 100);

      // Risk/Reward ratio
      const riskRewardRatio = stopLossPips > 0 ? (targetPips / stopLossPips) : 0;

      // For long: profit box goes UP from entry, stop loss goes DOWN
      // For short: profit box goes DOWN from entry, stop loss goes UP
      const profitTop = isLong ? Math.min(entryY, targetY) : entryY;
      const profitHeight = Math.abs(targetY - entryY);
      const stopLossTop = isLong ? entryY : Math.min(entryY, stopLossY);
      const stopLossHeight = Math.abs(stopLossY - entryY);

      // Custom colors - color is for profit zone, fillColor is for loss zone
      const profitColor = drawing.color || '#22c55e';
      const lossColor = drawing.fillColor || '#ef4444';
      const entryColor = '#4b5563';

      // Zone fill colours matching TradingView; both zones filled equally
      const profitFill = drawing.color
        ? `${drawing.color}40`
        : 'rgba(34, 197, 94, 0.25)';
      const lossFill = drawing.fillColor
        ? `${drawing.fillColor}40`
        : 'rgba(239, 68, 68, 0.25)';

      // Check if this drawing is selected
      const isSelected = selectedDrawingId === drawing.id;

      // Scan candles: detect TP/SL hit + track last close
      let lastClose = entryPrice;
      let lastCandleX = minX;
      let hitTP = false;
      let hitSL = false;
      let hitX = maxX;

      if (candlesProp && candlesProp.length > 0) {
        for (const c of candlesProp) {
          const cx = converter.timeToX(c.time);
          if (cx === null || cx < minX) continue;
          if (cx > maxX) break;
          lastClose = c.close;
          lastCandleX = cx;
          if (isLong) {
            if (c.high >= targetPrice) { hitTP = true; hitX = cx; break; }
            if (c.low <= stopLossPrice) { hitSL = true; hitX = cx; break; }
          } else {
            if (c.low <= targetPrice) { hitTP = true; hitX = cx; break; }
            if (c.high >= stopLossPrice) { hitSL = true; hitX = cx; break; }
          }
        }
      }

      return (
        <g key={drawing.id} id={`${clipId}_drawing-${drawing.id}`}
          onMouseEnter={() => setHoveredDrawingId(drawing.id)}
          onMouseLeave={() => setHoveredDrawingId(null)}>
          {/* Profit zone fill: full width, full height */}
          <rect
            x={minX}
            y={profitTop}
            width={width}
            height={profitHeight}
            fill={profitFill}
            style={{ pointerEvents: 'none' }}
          />
          {/* Stop loss zone fill: full width, full height */}
          <rect
            x={minX}
            y={stopLossTop}
            width={width}
            height={stopLossHeight}
            fill={lossFill}
            style={{ pointerEvents: 'none' }}
          />
          {/* Single invisible hit area covering both zones for drag */}
          <rect
            x={minX}
            y={Math.min(profitTop, stopLossTop)}
            width={width}
            height={Math.abs(stopLossY - targetY)}
            fill="transparent"
            style={{ cursor: 'move', pointerEvents: 'all' }}
          />

          {/* Left vertical border - profit zone segment */}
          <line x1={minX} y1={targetY} x2={minX} y2={entryY} stroke={profitColor} strokeWidth={drawing.strokeWidth ?? 1} style={{ pointerEvents: 'none' }} />
          {/* Left vertical border - loss zone segment */}
          <line x1={minX} y1={entryY} x2={minX} y2={stopLossY} stroke={lossColor} strokeWidth={drawing.strokeWidth ?? 1} style={{ pointerEvents: 'none' }} />
          {/* Right vertical border - profit zone segment */}
          <line x1={maxX} y1={targetY} x2={maxX} y2={entryY} stroke={profitColor} strokeWidth={drawing.strokeWidth ?? 1} style={{ pointerEvents: 'none' }} />
          {/* Right vertical border - loss zone segment */}
          <line x1={maxX} y1={entryY} x2={maxX} y2={stopLossY} stroke={lossColor} strokeWidth={drawing.strokeWidth ?? 1} style={{ pointerEvents: 'none' }} />

          {/* Horizontal lines */}
          <line x1={minX} y1={targetY} x2={maxX} y2={targetY} stroke={profitColor} strokeWidth={drawing.strokeWidth ?? 1} style={{ pointerEvents: 'none' }} />
          <line x1={minX} y1={entryY} x2={maxX} y2={entryY} stroke={entryColor} strokeWidth={drawing.strokeWidth ?? 1} style={{ pointerEvents: 'none' }} />
          <line x1={minX} y1={stopLossY} x2={maxX} y2={stopLossY} stroke={lossColor} strokeWidth={drawing.strokeWidth ?? 1} style={{ pointerEvents: 'none' }} />

          {/* Invisible wider hit areas for grabbing */}
          <line x1={minX} y1={targetY} x2={maxX} y2={targetY} stroke="transparent" strokeWidth={20} style={{ cursor: 'ns-resize', pointerEvents: 'all' }} />
          <line x1={minX} y1={entryY} x2={maxX} y2={entryY} stroke="transparent" strokeWidth={20} style={{ cursor: 'ns-resize', pointerEvents: 'all' }} />
          <line x1={minX} y1={stopLossY} x2={maxX} y2={stopLossY} stroke="transparent" strokeWidth={20} style={{ cursor: 'ns-resize', pointerEvents: 'all' }} />

          {/* ── Two-tone overlay ──────────────────────────────────────
              Condition 1: TP/SL hit -> full zone height, width to hitX
              Condition 2: Neither hit -> entry to last close, full width */}
          {(() => {
            if (hitTP) {
              // TP hit: darker green on profit zone, width stops at hitX.
              // No minimum width threshold here: if a candle hit TP, always
              // show the overlay regardless of how close to the entry it was.
              // Previously required dw >= 10% of drawing width, which hid the
              // hit when the drawing extended far to the right of the candles.
              const dw = Math.max(2, hitX - minX);
              return (
                <>
                  <rect x={minX} y={profitTop} width={dw}
                    height={profitHeight}
                    fill={profitColor} opacity={0.22}
                    style={{ pointerEvents: 'none' }} />
                  <line x1={minX} y1={entryY} x2={hitX} y2={targetY}
                    stroke={profitColor} strokeWidth={1} strokeDasharray="6,4"
                    opacity={0.45} style={{ pointerEvents: 'none' }} />
                </>
              );
            }
            if (hitSL) {
              // SL hit: darker red on loss zone, width stops at hitX.
              // Same fix as TP: always show the hit overlay.
              const dw = Math.max(2, hitX - minX);
              return (
                <>
                  <rect x={minX} y={stopLossTop} width={dw}
                    height={stopLossHeight}
                    fill={lossColor} opacity={0.22}
                    style={{ pointerEvents: 'none' }} />
                  <line x1={minX} y1={entryY} x2={hitX} y2={stopLossY}
                    stroke={lossColor} strokeWidth={1} strokeDasharray="6,4"
                    opacity={0.45} style={{ pointerEvents: 'none' }} />
                </>
              );
            }
            // Neither hit: darker overlay from entry to last close, full width
            // Require candles to cover at least 10% of drawing width
            if (lastCandleX - minX < width * 0.1) return null;
            const lastCloseY = converter.priceToY(lastClose);
            const overlayTop = Math.min(entryY, lastCloseY);
            const overlayHeight = Math.abs(lastCloseY - entryY);
            if (overlayHeight <= 0) return null;
            const inProfit = isLong
              ? lastClose > entryPrice
              : lastClose < entryPrice;
            return (
              <>
                <rect x={minX} y={overlayTop} width={width}
                  height={overlayHeight}
                  fill={inProfit ? profitColor : lossColor} opacity={0.22}
                  style={{ pointerEvents: 'none' }} />
                <line x1={minX} y1={entryY} x2={lastCandleX} y2={lastCloseY}
                  stroke={inProfit ? profitColor : lossColor}
                  strokeWidth={1} strokeDasharray="6,4"
                  opacity={0.45} style={{ pointerEvents: 'none' }} />
              </>
            );
          })()}

          {/* ── Stat badges: TradingView-style, visible when selected ── */}
          {isSelected && (() => {
            const pnlLabel = hitTP || hitSL ? 'Closed P&L' : 'Open P&L';
            const pnlValue = hitTP || hitSL
              ? Math.abs(targetPrice - entryPrice)
              : Math.abs(lastClose - entryPrice);
            const pnlSign = (isLong ? lastClose >= entryPrice : lastClose <= entryPrice) ? '+' : '-';
            const qty = Math.round(Math.abs(targetPrice - entryPrice) / (entryPrice * 0.0001));
            const cx = minX + width / 2;

            // Auto-size: ~5.5px per char for 11px font, 10px padding
            const tpText = `Target  ${fmtPrice(targetPrice)}  (${targetPercent.toFixed(2)}%)  ${targetPips.toFixed(0)} pips`;
            const slText = `Stop  ${fmtPrice(stopLossPrice)}  (${stopLossPercent.toFixed(2)}%)  ${stopLossPips.toFixed(0)} pips`;
            const entryLine1 = `${pnlLabel}: ${pnlSign}${fmtPrice(pnlValue)}  ·  Qty: ${qty}`;
            const entryLine2 = `Risk/reward ratio: ${riskRewardRatio.toFixed(2)}`;

            const tpW = tpText.length * 5.5 + 10;
            const slW = slText.length * 5.5 + 10;
            const entryW = Math.max(entryLine1.length, entryLine2.length) * 5.5 + 14;

            return (
              <>
                {/* TP badge: tight auto-width, centered on drawing */}
                <g style={{ pointerEvents: 'none' }}>
                  <rect x={cx - tpW / 2} y={targetY + (isLong ? -22 : 4)}
                    width={tpW} height={18} rx={3}
                    fill={profitColor} opacity={0.9} />
                  <text x={cx} y={targetY + (isLong ? -9 : 17)}
                    fill="#ffffff" fontSize="11" fontWeight="600"
                    fontFamily="system-ui, -apple-system, sans-serif"
                    textAnchor="middle"
                    style={{ userSelect: 'none' }}>
                    {tpText}
                  </text>
                </g>

                {/* SL badge: tight auto-width, centered on drawing */}
                <g style={{ pointerEvents: 'none' }}>
                  <rect x={cx - slW / 2} y={stopLossY + (isLong ? 4 : -22)}
                    width={slW} height={18} rx={3}
                    fill={lossColor} opacity={0.9} />
                  <text x={cx} y={stopLossY + (isLong ? 17 : -9)}
                    fill="#ffffff" fontSize="11" fontWeight="600"
                    fontFamily="system-ui, -apple-system, sans-serif"
                    textAnchor="middle"
                    style={{ userSelect: 'none' }}>
                    {slText}
                  </text>
                </g>

                {/* Entry badge: tight auto-width, two lines */}
                <g style={{ pointerEvents: 'none' }}>
                  <rect x={cx - entryW / 2} y={entryY - 28}
                    width={entryW} height={32} rx={4}
                    fill="rgba(15, 23, 42, 0.88)" />
                  <text x={cx} y={entryY - 15}
                    fill="#ffffff" fontSize="11" fontWeight="600"
                    fontFamily="system-ui, -apple-system, sans-serif"
                    textAnchor="middle"
                    style={{ userSelect: 'none' }}>
                    {entryLine1}
                  </text>
                  <text x={cx} y={entryY - 3}
                    fill="rgba(255,255,255,0.7)" fontSize="10" fontWeight="500"
                    fontFamily="system-ui, -apple-system, sans-serif"
                    textAnchor="middle"
                    style={{ userSelect: 'none' }}>
                    {entryLine2}
                  </text>
                </g>
              </>
            );
          })()}

          {/* Resize handles at anchor positions: TradingView-style 8x8 squares,
              visible when selected for dragging TP, entry, and SL levels */}
          {isSelected && (
            <>
              <rect x={minX - 4} y={targetY - 4} width={8} height={8} fill="white" stroke={profitColor} strokeWidth="1.5" rx="1" style={{ cursor: 'ns-resize', pointerEvents: 'all' }} />
              <rect x={maxX - 4} y={targetY - 4} width={8} height={8} fill="white" stroke={profitColor} strokeWidth="1.5" rx="1" style={{ cursor: 'ns-resize', pointerEvents: 'all' }} />
              <rect x={minX - 4} y={entryY - 4} width={8} height={8} fill="white" stroke={entryColor} strokeWidth="1.5" rx="1" style={{ cursor: 'ew-resize', pointerEvents: 'all' }} />
              <rect x={maxX - 4} y={entryY - 4} width={8} height={8} fill="white" stroke={entryColor} strokeWidth="1.5" rx="1" style={{ cursor: 'ew-resize', pointerEvents: 'all' }} />
              <rect x={minX - 4} y={stopLossY - 4} width={8} height={8} fill="white" stroke={lossColor} strokeWidth="1.5" rx="1" style={{ cursor: 'ns-resize', pointerEvents: 'all' }} />
              <rect x={maxX - 4} y={stopLossY - 4} width={8} height={8} fill="white" stroke={lossColor} strokeWidth="1.5" rx="1" style={{ cursor: 'ns-resize', pointerEvents: 'all' }} />
            </>
          )}

        </g>
      );
    }

    if (drawing.type === 'trendRay') {
      if (pixels.length < 2) return null;
      const [p1, p2] = pixels;

      // Extend line forward to chart edge
      const cw = containerRef.current?.clientWidth || 1000;
      const ch = containerRef.current?.clientHeight || 600;
      const chartW = cw - chartBounds.priceAxisWidth;
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;

      let extX1 = p1.x, extY1 = p1.y, extX2 = p2.x, extY2 = p2.y;
      if (Math.abs(dx) < 0.001) {
        extX2 = p1.x; extY2 = dy > 0 ? ch : 0;
      } else {
        const tCandidates: number[] = [];
        tCandidates.push((0 - p1.x) / dx);
        tCandidates.push((chartW - p1.x) / dx);
        if (Math.abs(dy) > 0.001) {
          tCandidates.push((0 - p1.y) / dy);
          tCandidates.push((ch - p1.y) / dy);
        }

        let tMax = 1;
        for (const t of tCandidates) {
          const ix = p1.x + dx * t;
          const iy = p1.y + dy * t;
          if (ix >= -1 && ix <= chartW + 1 && iy >= -1 && iy <= ch + 1) {
            if (t > tMax) tMax = t;
          }
        }
        extX2 = p1.x + dx * tMax;
        extY2 = p1.y + dy * tMax;
      }

      return (
        <g key={drawing.id} id={`${clipId}_drawing-${drawing.id}`}>
          <line
            x1={extX1}
            y1={extY1}
            x2={extX2}
            y2={extY2}
            stroke={drawingColor}
            strokeWidth={drawingStrokeWidth}
            strokeDasharray={getStrokeDashArray(drawing.lineStyle)}
            onMouseEnter={() => setHoveredDrawingId(drawing.id)}
            onMouseLeave={() => setHoveredDrawingId(null)}
            style={{ cursor: 'move', pointerEvents: 'stroke', strokeWidth: 10, opacity: 0 }}
          />
          <line
            x1={extX1}
            y1={extY1}
            x2={extX2}
            y2={extY2}
            stroke={drawingColor}
            strokeWidth={drawingStrokeWidth}
            strokeDasharray={getStrokeDashArray(drawing.lineStyle)}
            strokeOpacity={strokeOpacity}
            style={{ pointerEvents: 'none' }}
          />
          {showHandles && (
            <>
              <circle cx={p1.x} cy={p1.y} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'move', pointerEvents: 'all' }} />
              <circle cx={p2.x} cy={p2.y} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'move', pointerEvents: 'all' }} />
              {midpointDot}
            </>
          )}
        </g>
      );
    }

    // Straight line segment (finite, between two points)
    if (drawing.type === 'trend' || drawing.type === 'line') {
      if (pixels.length < 2) return null;
      const [p1, p2] = pixels;
      // Label anchor: midpoint of the segment, offset 12px perpendicular above the line so the text sits cleanly off the stroke.
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const segLen = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = -dy / segLen;
      const ny = dx / segLen;
      const sideSign = ny > 0 ? -1 : 1;
      const labelX = midX + nx * 12 * sideSign;
      const labelY = midY + ny * 12 * sideSign;

      return (
        <g key={drawing.id} id={`${clipId}_drawing-${drawing.id}`}>
          <line
            x1={p1.x}
            y1={p1.y}
            x2={p2.x}
            y2={p2.y}
            stroke={drawingColor}
            strokeWidth={drawingStrokeWidth}
            strokeDasharray={getStrokeDashArray(drawing.lineStyle)}
            onMouseEnter={() => setHoveredDrawingId(drawing.id)}
            onMouseLeave={() => setHoveredDrawingId(null)}
            style={{ cursor: 'move', pointerEvents: 'stroke', strokeWidth: 10, opacity: 0 }}
          />
          <line
            x1={p1.x}
            y1={p1.y}
            x2={p2.x}
            y2={p2.y}
            stroke={drawingColor}
            strokeWidth={drawingStrokeWidth}
            strokeDasharray={getStrokeDashArray(drawing.lineStyle)}
            strokeOpacity={strokeOpacity}
            style={{ pointerEvents: 'none' }}
          />
          {renderInlineLabel(drawing, labelX, labelY, drawingColor)}
          {showHandles && (
            <>
              <circle cx={p1.x} cy={p1.y} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'move', pointerEvents: 'all' }} />
              <circle cx={p2.x} cy={p2.y} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'move', pointerEvents: 'all' }} />
              {midpointDot}
            </>
          )}
        </g>
      );
    }

    if (drawing.type === 'rectangle') {
      if (pixels.length < 2) return null;
      const [p1, p2] = pixels;
      const minX = Math.min(p1.x, p2.x);
      const minY = Math.min(p1.y, p2.y);
      const width = Math.abs(p2.x - p1.x);
      const height = Math.abs(p2.y - p1.y);

      return (
        <g key={drawing.id} id={`${clipId}_drawing-${drawing.id}`}>
          <rect
            x={minX}
            y={minY}
            width={width}
            height={height}
            fill={drawing.fillColor || 'none'}
            fillOpacity={drawing.fillColor ? 0.2 * fillOpacityValue : 0}
            stroke={drawingColor}
            strokeWidth={drawingStrokeWidth}
            strokeDasharray={getStrokeDashArray(drawing.lineStyle)}
            strokeOpacity={strokeOpacity}
            onMouseEnter={() => setHoveredDrawingId(drawing.id)}
            onMouseLeave={() => setHoveredDrawingId(null)}
            style={{ cursor: 'move', pointerEvents: 'all' }}
          />
          {renderInlineLabel(drawing, minX + width / 2, minY + height / 2, drawingColor)}
          {showHandles && (
            <>
              <circle cx={minX} cy={minY} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nwse-resize', pointerEvents: 'all' }} />
              <circle cx={minX + width} cy={minY} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nesw-resize', pointerEvents: 'all' }} />
              <circle cx={minX} cy={minY + height} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nesw-resize', pointerEvents: 'all' }} />
              <circle cx={minX + width} cy={minY + height} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nwse-resize', pointerEvents: 'all' }} />
            </>
          )}

        </g>
      );
    }

    if (drawing.type === 'square') {
      if (pixels.length < 2) return null;
      const [p1, p2] = pixels;
      // Force equal width and height at render time to maintain square proportions.
      // Points are stored as chart coords (time, price) which have very different
      // pixel scales, so we must re-enforce the constraint every frame, same as circle.
      const size = Math.max(Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
      const minX = Math.min(p1.x, p2.x);
      const minY = Math.min(p1.y, p2.y);
      const width = size;
      const height = size;

      return (
        <g key={drawing.id} id={`${clipId}_drawing-${drawing.id}`}>
          <rect
            x={minX}
            y={minY}
            width={width}
            height={height}
            fill={drawing.fillColor ? drawing.fillColor : 'transparent'}
            fillOpacity={drawing.fillColor ? 0.2 * fillOpacityValue : 0}
            stroke={drawingColor}
            strokeWidth={drawingStrokeWidth}
            strokeDasharray={getStrokeDashArray(drawing.lineStyle)}
            strokeOpacity={strokeOpacity}
            onMouseEnter={() => setHoveredDrawingId(drawing.id)}
            onMouseLeave={() => setHoveredDrawingId(null)}
            style={{ cursor: 'move', pointerEvents: 'all' }}
          />
          {showHandles && (
            <>
              <circle cx={minX} cy={minY} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nwse-resize', pointerEvents: 'all' }} />
              <circle cx={minX + width} cy={minY} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nesw-resize', pointerEvents: 'all' }} />
              <circle cx={minX} cy={minY + height} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nesw-resize', pointerEvents: 'all' }} />
              <circle cx={minX + width} cy={minY + height} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nwse-resize', pointerEvents: 'all' }} />
            </>
          )}
        </g>
      );
    }

    if (drawing.type === 'circle') {
      if (pixels.length < 2) return null;
      const [p1, p2] = pixels;
      // Fixed proportions - perfect circle
      const size = Math.max(Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
      const minX = Math.min(p1.x, p2.x);
      const minY = Math.min(p1.y, p2.y);
      const cx = minX + size / 2;
      const cy = minY + size / 2;
      const r = size / 2;

      return (
        <g key={drawing.id} id={`${clipId}_drawing-${drawing.id}`}>
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill={drawing.fillColor || 'none'}
            fillOpacity={drawing.fillColor ? 0.2 * fillOpacityValue : 0}
            stroke={drawingColor}
            strokeWidth={drawingStrokeWidth}
            strokeDasharray={getStrokeDashArray(drawing.lineStyle)}
            strokeOpacity={strokeOpacity}
            onMouseEnter={() => setHoveredDrawingId(drawing.id)}
            onMouseLeave={() => setHoveredDrawingId(null)}
            style={{ cursor: 'move', pointerEvents: 'all' }}
          />
          {showHandles && (
            <>
              {/* Circle uses 'size' for both dimensions (square bounding box), not separate width/height.
                 Using undefined 'width'/'height' here caused ReferenceError crash + black screen. */}
              <circle cx={minX} cy={minY} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nwse-resize', pointerEvents: 'all' }} />
              <circle cx={minX + size} cy={minY} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nesw-resize', pointerEvents: 'all' }} />
              <circle cx={minX} cy={minY + size} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nesw-resize', pointerEvents: 'all' }} />
              <circle cx={minX + size} cy={minY + size} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nwse-resize', pointerEvents: 'all' }} />
            </>
          )}
        </g>
      );
    }

    if (drawing.type === 'triangle') {
      if (pixels.length < 2) return null;
      const [p1, p2] = pixels;
      // Fixed proportions - equilateral triangle
      const size = Math.max(Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
      const minX = Math.min(p1.x, p2.x);
      const minY = Math.min(p1.y, p2.y);
      const height = size * Math.sqrt(3) / 2;
      // Triangle pointing up: bottom-left, top-center, bottom-right
      const points = `${minX},${minY + height} ${minX + size / 2},${minY} ${minX + size},${minY + height}`;

      return (
        <g key={drawing.id} id={`${clipId}_drawing-${drawing.id}`}>
          <polygon
            points={points}
            fill={drawing.fillColor || 'none'}
            fillOpacity={drawing.fillColor ? 0.2 * fillOpacityValue : 0}
            stroke={drawingColor}
            strokeWidth={drawingStrokeWidth}
            strokeDasharray={getStrokeDashArray(drawing.lineStyle)}
            strokeOpacity={strokeOpacity}
            onMouseEnter={() => setHoveredDrawingId(drawing.id)}
            onMouseLeave={() => setHoveredDrawingId(null)}
            style={{ cursor: 'move', pointerEvents: 'all' }}
          />
          {showHandles && (
            <>
              {/* 3 handles at triangle corners: bottom-left, top-center, bottom-right */}
              <circle cx={minX} cy={minY + height} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nesw-resize', pointerEvents: 'all' }} />
              <circle cx={minX + size / 2} cy={minY} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'ns-resize', pointerEvents: 'all' }} />
              <circle cx={minX + size} cy={minY + height} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nwse-resize', pointerEvents: 'all' }} />
            </>
          )}
        </g>
      );
    }

    if (drawing.type === 'oval') {
      if (pixels.length < 2) return null;
      const [p1, p2] = pixels;
      const minX = Math.min(p1.x, p2.x);
      const minY = Math.min(p1.y, p2.y);
      const width = Math.abs(p2.x - p1.x);
      const height = Math.abs(p2.y - p1.y);
      const cx = minX + width / 2;
      const cy = minY + height / 2;
      const rx = width / 2;
      const ry = height / 2;

      return (
        <g key={drawing.id} id={`${clipId}_drawing-${drawing.id}`}>
          <ellipse
            cx={cx}
            cy={cy}
            rx={rx}
            ry={ry}
            fill={drawing.fillColor || 'none'}
            fillOpacity={drawing.fillColor ? 0.2 * fillOpacityValue : 0}
            stroke={drawingColor}
            strokeWidth={drawingStrokeWidth}
            strokeDasharray={getStrokeDashArray(drawing.lineStyle)}
            strokeOpacity={strokeOpacity}
            onMouseEnter={() => setHoveredDrawingId(drawing.id)}
            onMouseLeave={() => setHoveredDrawingId(null)}
            style={{ cursor: 'move', pointerEvents: 'all' }}
          />
          {showHandles && (
            <>
              <circle cx={minX} cy={minY} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nwse-resize', pointerEvents: 'all' }} />
              <circle cx={minX + width} cy={minY} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nesw-resize', pointerEvents: 'all' }} />
              <circle cx={minX} cy={minY + height} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nesw-resize', pointerEvents: 'all' }} />
              <circle cx={minX + width} cy={minY + height} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nwse-resize', pointerEvents: 'all' }} />
            </>
          )}
        </g>
      );
    }

    // Free Triangle - 3 independent corners
    if (drawing.type === 'freeTriangle') {
      if (pixels.length < 3) return null;
      const [p1, p2, p3] = pixels;
      const points = `${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`;

      return (
        <g key={drawing.id} id={`${clipId}_drawing-${drawing.id}`}>
          <polygon
            points={points}
            fill={drawing.fillColor || 'none'}
            fillOpacity={drawing.fillColor ? 0.2 * fillOpacityValue : 0}
            stroke={drawingColor}
            strokeWidth={drawingStrokeWidth}
            strokeDasharray={getStrokeDashArray(drawing.lineStyle)}
            strokeOpacity={strokeOpacity}
            onMouseEnter={() => setHoveredDrawingId(drawing.id)}
            onMouseLeave={() => setHoveredDrawingId(null)}
            style={{ cursor: 'move', pointerEvents: 'all' }}
          />
          {showHandles && (
            <>
              <circle cx={p1.x} cy={p1.y} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'move', pointerEvents: 'all' }} />
              <circle cx={p2.x} cy={p2.y} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'move', pointerEvents: 'all' }} />
              <circle cx={p3.x} cy={p3.y} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'move', pointerEvents: 'all' }} />
            </>
          )}
        </g>
      );
    }

    // Parallel Channel - two parallel lines with fill
    if (drawing.type === 'parallelChannel') {
      if (pixels.length < 3) return null;
      const [p1, p2, p3] = pixels;
      // p3 defines the offset from p1. The second line is p2+offset to p1+offset.
      const dx = p3.x - p1.x;
      const dy = p3.y - p1.y;
      const q3 = { x: p2.x + dx, y: p2.y + dy };
      const fillPoints = `${p1.x},${p1.y} ${p2.x},${p2.y} ${q3.x},${q3.y} ${p3.x},${p3.y}`;

      return (
        <g key={drawing.id} id={`${clipId}_drawing-${drawing.id}`}>
          {/* Fill between the two lines */}
          <polygon
            points={fillPoints}
            fill={drawing.fillColor || '#64748b'}
            fillOpacity={0.08 * fillOpacityValue}
            stroke="none"
            onMouseEnter={() => setHoveredDrawingId(drawing.id)}
            onMouseLeave={() => setHoveredDrawingId(null)}
            style={{ cursor: 'move', pointerEvents: 'all' }}
          />
          {/* Base trend line (p1 to p2) */}
          <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
            stroke={drawingColor} strokeWidth={drawingStrokeWidth}
            strokeDasharray={getStrokeDashArray(drawing.lineStyle)}
            strokeOpacity={strokeOpacity}
            style={{ pointerEvents: 'none' }}
          />
          {/* Parallel line (p3 to q3) */}
          <line x1={p3.x} y1={p3.y} x2={q3.x} y2={q3.y}
            stroke={drawingColor} strokeWidth={drawingStrokeWidth}
            strokeDasharray={getStrokeDashArray(drawing.lineStyle)}
            strokeOpacity={strokeOpacity}
            style={{ pointerEvents: 'none' }}
          />
          {/* Middle dashed line */}
          <line x1={(p1.x + p3.x) / 2} y1={(p1.y + p3.y) / 2} x2={(p2.x + q3.x) / 2} y2={(p2.y + q3.y) / 2}
            stroke={drawingColor} strokeWidth={1}
            strokeDasharray="4,4"
            strokeOpacity={strokeOpacity * 0.4}
            style={{ pointerEvents: 'none' }}
          />
          {showHandles && (
            <>
              <circle cx={p1.x} cy={p1.y} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'move', pointerEvents: 'all' }} />
              <circle cx={p2.x} cy={p2.y} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'move', pointerEvents: 'all' }} />
              <circle cx={p3.x} cy={p3.y} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'move', pointerEvents: 'all' }} />
            </>
          )}
        </g>
      );
    }

    // Parallelogram - skewed rectangle
    if (drawing.type === 'parallelogram') {
      if (pixels.length < 2) return null;
      const [p1, p2] = pixels;
      const minX = Math.min(p1.x, p2.x);
      const minY = Math.min(p1.y, p2.y);
      const width = Math.abs(p2.x - p1.x);
      const height = Math.abs(p2.y - p1.y);
      const skew = width * 0.25; // 25% skew
      // Parallelogram points: top-left skewed right, top-right skewed right, bottom-right, bottom-left
      const points = `${minX + skew},${minY} ${minX + width + skew},${minY} ${minX + width},${minY + height} ${minX},${minY + height}`;

      // Parallelogram corner positions: top-left, top-right, bottom-right, bottom-left
      const corners = [
        { x: minX + skew, y: minY },           // top-left (skewed)
        { x: minX + width + skew, y: minY },   // top-right (skewed)
        { x: minX + width, y: minY + height }, // bottom-right
        { x: minX, y: minY + height }          // bottom-left
      ];

      return (
        <g key={drawing.id} id={`${clipId}_drawing-${drawing.id}`}>
          <polygon
            points={points}
            fill={drawing.fillColor || 'none'}
            fillOpacity={drawing.fillColor ? 0.2 * fillOpacityValue : 0}
            stroke={drawingColor}
            strokeWidth={drawingStrokeWidth}
            strokeDasharray={getStrokeDashArray(drawing.lineStyle)}
            strokeOpacity={strokeOpacity}
            onMouseEnter={() => setHoveredDrawingId(drawing.id)}
            onMouseLeave={() => setHoveredDrawingId(null)}
            style={{ cursor: 'move', pointerEvents: 'all' }}
          />
          {showHandles && (
            <>
              <circle cx={corners[0].x} cy={corners[0].y} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nwse-resize', pointerEvents: 'all' }} />
              <circle cx={corners[1].x} cy={corners[1].y} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nesw-resize', pointerEvents: 'all' }} />
              <circle cx={corners[2].x} cy={corners[2].y} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nesw-resize', pointerEvents: 'all' }} />
              <circle cx={corners[3].x} cy={corners[3].y} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nwse-resize', pointerEvents: 'all' }} />
            </>
          )}
        </g>
      );
    }

    // Octagon - 8-sided polygon
    if (drawing.type === 'octagon') {
      if (pixels.length < 2) return null;
      const [p1, p2] = pixels;
      const minX = Math.min(p1.x, p2.x);
      const minY = Math.min(p1.y, p2.y);
      const width = Math.abs(p2.x - p1.x);
      const height = Math.abs(p2.y - p1.y);
      const cx = minX + width / 2;
      const cy = minY + height / 2;
      const rx = width / 2;
      const ry = height / 2;

      // Generate octagon points (8 vertices)
      const octagonPoints: string[] = [];
      for (let i = 0; i < 8; i++) {
        const angle = (Math.PI / 8) + (i * Math.PI / 4); // Start at 22.5 degrees
        const px = cx + rx * Math.cos(angle);
        const py = cy + ry * Math.sin(angle);
        octagonPoints.push(`${px},${py}`);
      }
      const points = octagonPoints.join(' ');

      return (
        <g key={drawing.id} id={`${clipId}_drawing-${drawing.id}`}>
          <polygon
            points={points}
            fill={drawing.fillColor || 'none'}
            fillOpacity={drawing.fillColor ? 0.2 * fillOpacityValue : 0}
            stroke={drawingColor}
            strokeWidth={drawingStrokeWidth}
            strokeDasharray={getStrokeDashArray(drawing.lineStyle)}
            strokeOpacity={strokeOpacity}
            onMouseEnter={() => setHoveredDrawingId(drawing.id)}
            onMouseLeave={() => setHoveredDrawingId(null)}
            style={{ cursor: 'move', pointerEvents: 'all' }}
          />
          {showHandles && (
            <>
              <circle cx={minX} cy={minY} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nwse-resize', pointerEvents: 'all' }} />
              <circle cx={minX + width} cy={minY} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nesw-resize', pointerEvents: 'all' }} />
              <circle cx={minX} cy={minY + height} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nesw-resize', pointerEvents: 'all' }} />
              <circle cx={minX + width} cy={minY + height} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nwse-resize', pointerEvents: 'all' }} />
            </>
          )}
        </g>
      );
    }

    // ── New shapes: all use 2-point bounding box like rectangle/octagon ──
    // Helper to render any polygon-based shape with standard handles
    const renderPolygonShape = (polyPoints: string) => {
      const [p1, p2] = pixels;
      const bMinX = Math.min(p1.x, p2.x);
      const bMinY = Math.min(p1.y, p2.y);
      const bW = Math.abs(p2.x - p1.x);
      const bH = Math.abs(p2.y - p1.y);
      return (
        <g key={drawing.id} id={`${clipId}_drawing-${drawing.id}`}>
          <polygon
            points={polyPoints}
            fill={drawing.fillColor || 'none'}
            fillOpacity={drawing.fillColor ? 0.2 * fillOpacityValue : 0}
            stroke={drawingColor}
            strokeWidth={drawingStrokeWidth}
            strokeDasharray={getStrokeDashArray(drawing.lineStyle)}
            strokeOpacity={strokeOpacity}
            onMouseEnter={() => setHoveredDrawingId(drawing.id)}
            onMouseLeave={() => setHoveredDrawingId(null)}
            style={{ cursor: 'move', pointerEvents: 'all' }}
          />
          {showHandles && (
            <>
              <circle cx={bMinX} cy={bMinY} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nwse-resize', pointerEvents: 'all' }} />
              <circle cx={bMinX + bW} cy={bMinY} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nesw-resize', pointerEvents: 'all' }} />
              <circle cx={bMinX} cy={bMinY + bH} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nesw-resize', pointerEvents: 'all' }} />
              <circle cx={bMinX + bW} cy={bMinY + bH} r={isSelected ? 7 : 6} fill={drawingColor} stroke={isSelected ? "#ffffff" : "#1e293b"} strokeWidth="2" style={{ cursor: 'nwse-resize', pointerEvents: 'all' }} />
            </>
          )}
        </g>
      );
    };

    if (['diamond', 'pentagon', 'hexagon', 'star', 'cross', 'arrowBlock', 'wedge', 'heart'].includes(drawing.type as string)) {
      if (pixels.length < 2) return null;
      const [p1, p2] = pixels;
      const minX = Math.min(p1.x, p2.x);
      const minY = Math.min(p1.y, p2.y);
      const w = Math.abs(p2.x - p1.x);
      const h = Math.abs(p2.y - p1.y);
      const cx = minX + w / 2;
      const cy = minY + h / 2;
      const rx = w / 2;
      const ry = h / 2;

      let pts = '';

      if (drawing.type === 'diamond') {
        // Diamond: 4 points at the midpoints of bounding box edges
        pts = `${cx},${minY} ${minX + w},${cy} ${cx},${minY + h} ${minX},${cy}`;
      } else if (drawing.type === 'pentagon') {
        // Regular pentagon inscribed in bounding ellipse
        const verts: string[] = [];
        for (let i = 0; i < 5; i++) {
          const a = -Math.PI / 2 + (i * 2 * Math.PI / 5);
          verts.push(`${cx + rx * Math.cos(a)},${cy + ry * Math.sin(a)}`);
        }
        pts = verts.join(' ');
      } else if (drawing.type === 'hexagon') {
        // Regular hexagon
        const verts: string[] = [];
        for (let i = 0; i < 6; i++) {
          const a = -Math.PI / 2 + (i * Math.PI / 3);
          verts.push(`${cx + rx * Math.cos(a)},${cy + ry * Math.sin(a)}`);
        }
        pts = verts.join(' ');
      } else if (drawing.type === 'star') {
        // 5-pointed star: alternating outer and inner vertices
        const verts: string[] = [];
        for (let i = 0; i < 10; i++) {
          const a = -Math.PI / 2 + (i * Math.PI / 5);
          const r = i % 2 === 0 ? 1 : 0.38; // inner radius ~38% of outer
          verts.push(`${cx + rx * r * Math.cos(a)},${cy + ry * r * Math.sin(a)}`);
        }
        pts = verts.join(' ');
      } else if (drawing.type === 'cross') {
        // Plus/cross shape: 12 points forming a + sign
        const t = 0.3; // arm thickness ratio
        pts = [
          `${cx - rx * t},${minY}`, `${cx + rx * t},${minY}`,
          `${cx + rx * t},${cy - ry * t}`, `${minX + w},${cy - ry * t}`,
          `${minX + w},${cy + ry * t}`, `${cx + rx * t},${cy + ry * t}`,
          `${cx + rx * t},${minY + h}`, `${cx - rx * t},${minY + h}`,
          `${cx - rx * t},${cy + ry * t}`, `${minX},${cy + ry * t}`,
          `${minX},${cy - ry * t}`, `${cx - rx * t},${cy - ry * t}`,
        ].join(' ');
      } else if (drawing.type === 'arrowBlock') {
        // Block arrow pointing right
        const headStart = minX + w * 0.6;
        pts = [
          `${minX},${cy - ry * 0.4}`, `${headStart},${cy - ry * 0.4}`,
          `${headStart},${minY}`, `${minX + w},${cy}`,
          `${headStart},${minY + h}`, `${headStart},${cy + ry * 0.4}`,
          `${minX},${cy + ry * 0.4}`,
        ].join(' ');
      } else if (drawing.type === 'wedge') {
        // Wedge/triangle variant: point on left, wide on right
        pts = `${minX},${cy} ${minX + w},${minY} ${minX + w},${minY + h}`;
      } else if (drawing.type === 'heart') {
        // Simplified heart using polygon approximation (16 points)
        const verts: string[] = [];
        for (let i = 0; i <= 16; i++) {
          const t = (i / 16) * 2 * Math.PI;
          // Heart parametric: x = 16sin^3(t), y = 13cos(t) - 5cos(2t) - 2cos(3t) - cos(4t)
          const hx = 16 * Math.pow(Math.sin(t), 3);
          const hy = -(13 * Math.cos(t) - 5 * Math.cos(2*t) - 2 * Math.cos(3*t) - Math.cos(4*t));
          // Scale to bounding box (heart ranges: x[-16,16], y[-17,15])
          verts.push(`${cx + (hx / 16) * rx},${cy + (hy / 32) * ry * 2 - ry * 0.1}`);
        }
        pts = verts.join(' ');
      }

      return renderPolygonShape(pts);
    }

    if (drawing.type === 'fibonacci' || drawing.type === 'fibExtension') {
      if (pixels.length < 2) return null;
      const [p1, p2] = pixels;
      const levels = drawing.fibLevels || [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

      // For fibExtension, remap so the topmost level lands on the second handle
      // (i.e. the bounding rectangle covers all levels, not just 0-100%). For
      // plain fibonacci retracement, levels are 0-1 and the second handle is 100%.
      const maxLevel = drawing.type === 'fibExtension' ? Math.max(...levels, 1) : 1;

      // Calculate prices at each fib level
      const startChart = drawing.points[0];
      const endChart = drawing.points[1];
      const priceRange = endChart.price - startChart.price;

      const minX = Math.min(p1.x, p2.x);
      const maxX = Math.max(p1.x, p2.x);
      const minY = Math.min(p1.y, p2.y);
      const maxY = Math.max(p1.y, p2.y);

      return (
        <g key={drawing.id} id={`${clipId}_drawing-${drawing.id}`}>
          {/* Large transparent rect for easy dragging */}
          <rect
            x={minX}
            y={minY}
            width={maxX - minX}
            height={maxY - minY}
            fill="transparent"
            stroke="transparent"
            strokeWidth="20"
            onMouseEnter={() => setHoveredDrawingId(drawing.id)}
            onMouseLeave={() => setHoveredDrawingId(null)}
            style={{ cursor: 'move', pointerEvents: 'all' }}
          />
          {levels.map((level) => {
            const t = level / maxLevel;
            const y = p1.y + (p2.y - p1.y) * t;
            const price = startChart.price + priceRange * t;
            const percentage = (level * 100).toFixed(1);

            return (
              <g key={level} opacity={strokeOpacity}>
                <line
                  x1={Math.min(p1.x, p2.x)}
                  y1={y}
                  x2={Math.max(p1.x, p2.x)}
                  y2={y}
                  stroke={drawingColor}
                  strokeWidth="1"
                  strokeDasharray="3,3"
                  style={{ pointerEvents: 'none' }}
                />
                <text
                  x={Math.max(p1.x, p2.x) + 5}
                  y={y - 2}
                  fill={drawingColor}
                  fontSize="11"
                  fontWeight="600"
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  {percentage}% ({price.toFixed(2)})
                </text>
              </g>
            );
          })}
          <line
            x1={p1.x}
            y1={p1.y}
            x2={p2.x}
            y2={p2.y}
            stroke="transparent"
            strokeWidth="10"
            onMouseEnter={() => setHoveredDrawingId(drawing.id)}
            onMouseLeave={() => setHoveredDrawingId(null)}
            style={{ cursor: 'move', pointerEvents: 'all' }}
          />
          {isHovered && (
            <>
              <circle cx={p1.x} cy={p1.y} r="6" fill={drawingColor} stroke="#1e293b" strokeWidth="2" style={{ cursor: 'move', pointerEvents: 'all' }} />
              <circle cx={p2.x} cy={p2.y} r="6" fill={drawingColor} stroke="#1e293b" strokeWidth="2" style={{ cursor: 'move', pointerEvents: 'all' }} />
            </>
          )}
          {midpointDot}
        </g>
      );
    }

    if (drawing.type === 'text' && drawing.text) {
      if (pixels.length < 1) return null;
      const p = pixels[0];
      // Use strokeWidth directly as font size (default 14px)
      const fontSize = drawing.strokeWidth || 14;

      return (
        <g key={drawing.id} id={`${clipId}_drawing-${drawing.id}`}>
          <text
            x={p.x}
            y={p.y}
            fill={drawing.color || '#64748b'}
            fillOpacity={strokeOpacity}
            fontSize={fontSize}
            fontWeight="bold"
            onMouseEnter={() => setHoveredDrawingId(drawing.id)}
            onMouseLeave={() => setHoveredDrawingId(null)}
            style={{ cursor: 'move', userSelect: 'none', pointerEvents: 'all' }}
          >
            {drawing.text}
          </text>

        </g>
      );
    }

    if (isBrushTool(drawing.type)) {
      // For brush drawings, convert ALL chart points to pixels on each render
      // This ensures the brush scales correctly with zoom/pan - it stays fixed relative to candles

      let smoothPixels: PixelPoint[];

      if (drawing.brushChartPoints && drawing.brushChartPoints.length > 0) {
        // Primary format: ALL points stored in chart coordinates
        // Convert each point to current pixel position - this scales with zoom
        smoothPixels = drawing.brushChartPoints
          .map(cp => chartToPixel(cp))
          .filter((p): p is PixelPoint => p !== null);
      } else if (drawing.brushPixelOffsets && drawing.brushPixelOffsets.length > 0 && pixels[0]) {
        // Legacy format: pixel offsets (won't scale properly, kept for backward compatibility)
        const anchorPixel = pixels[0];
        smoothPixels = drawing.brushPixelOffsets.map(offset => ({
          x: anchorPixel.x + offset.x,
          y: anchorPixel.y + offset.y
        }));
      } else if (drawing.pixelOffsets && drawing.pixelOffsets.length > 0 && pixels[0]) {
        // Oldest legacy format: pixel offsets
        const anchorPixel = pixels[0];
        smoothPixels = drawing.pixelOffsets.map(offset => ({
          x: anchorPixel.x + offset.x,
          y: anchorPixel.y + offset.y
        }));
      } else if (drawing.brushPixelPoints && drawing.brushPixelPoints.length > 0 && pixels[0]) {
        // Another legacy format: absolute pixel points with offset calculation
        const anchorPixel = pixels[0];
        const originalAnchor = drawing.brushPixelPoints[0];
        smoothPixels = drawing.brushPixelPoints.map(p => ({
          x: anchorPixel.x + (p.x - originalAnchor.x),
          y: anchorPixel.y + (p.y - originalAnchor.y)
        }));
      } else {
        // Fallback: chart-converted pixels
        smoothPixels = pixels;
      }

      if (smoothPixels.length < 2) return null;

      // Create smooth Catmull-Rom spline path for brush strokes (much smoother on mobile)
      const createSmoothPath = (points: PixelPoint[]): string => {
        if (points.length < 2) return '';
        if (points.length === 2) {
          return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
        }

        // Use Catmull-Rom to Bezier conversion for ultra-smooth curves
        const tension = 0.5; // Controls curve tightness (0 = sharp, 1 = very smooth)

        let path = `M ${points[0].x} ${points[0].y}`;

        for (let i = 0; i < points.length - 1; i++) {
          const p0 = points[Math.max(0, i - 1)];
          const p1 = points[i];
          const p2 = points[i + 1];
          const p3 = points[Math.min(points.length - 1, i + 2)];

          // Calculate control points using Catmull-Rom formula
          const cp1x = p1.x + (p2.x - p0.x) * tension / 3;
          const cp1y = p1.y + (p2.y - p0.y) * tension / 3;
          const cp2x = p2.x - (p3.x - p1.x) * tension / 3;
          const cp2y = p2.y - (p3.y - p1.y) * tension / 3;

          path += ` C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${p2.x} ${p2.y}`;
        }

        return path;
      };

      const pathData = createSmoothPath(smoothPixels);
      // Use strokeWidth to control line thickness
      const lineWidth = drawing.strokeWidth || 2;

      const firstPoint = smoothPixels[0];
      const lastPoint = smoothPixels[smoothPixels.length - 1];
      const isSelected = selectedDrawingId === drawing.id;

      return (
        <g key={drawing.id} id={`${clipId}_drawing-${drawing.id}`}>
          {/* Invisible wider path for easier selection */}
          <path
            d={pathData}
            stroke="transparent"
            strokeWidth={Math.max(16, lineWidth + 12)}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            onMouseEnter={() => setHoveredDrawingId(drawing.id)}
            onMouseLeave={() => setHoveredDrawingId(null)}
            onMouseDown={(e) => {
              e.stopPropagation();
              const rect = containerRef.current?.getBoundingClientRect();
              if (rect) {
                const firstPointPixel = chartToPixel(drawing.points[0]);
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                startDragging(drawing.id);
                setDragOffset({ x: x - (firstPointPixel?.x || 0), y: y - (firstPointPixel?.y || 0) });
                onSelectDrawing?.(drawing.id, { x: e.clientX, y: e.clientY });
              }
            }}
            style={{ cursor: 'move', pointerEvents: 'stroke' }}
          />
          {/* Visible brush path */}
          <path
            d={pathData}
            stroke={drawing.color || '#64748b'}
            strokeWidth={lineWidth}
            strokeDasharray={
              drawing.lineStyle === 'dashed' ? '8,4' :
                drawing.lineStyle === 'dotted' ? '2,4' :
                  undefined
            }
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeOpacity={strokeOpacity}
            style={{ pointerEvents: 'none' }}
          />
          {/* Arrow head for arrow tool */}
          {drawing.type === 'arrow' && smoothPixels.length >= 2 && (() => {
            const last = smoothPixels[smoothPixels.length - 1];
            const secondLast = smoothPixels[Math.max(0, smoothPixels.length - 5)]; // Look back a bit for better angle
            const angle = Math.atan2(last.y - secondLast.y, last.x - secondLast.x);
            const arrowSize = 12;
            const arrowAngle = Math.PI / 6; // 30 degrees
            return (
              <polygon
                points={`
                  ${last.x},${last.y}
                  ${last.x - arrowSize * Math.cos(angle - arrowAngle)},${last.y - arrowSize * Math.sin(angle - arrowAngle)}
                  ${last.x - arrowSize * Math.cos(angle + arrowAngle)},${last.y - arrowSize * Math.sin(angle + arrowAngle)}
                `}
                fill={drawing.color || '#3B82F6'}
                fillOpacity={strokeOpacity}
                style={{ pointerEvents: 'none' }}
              />
            );
          })()}
          {/* Endpoint handles when selected */}
          {isSelected && (
            <>
              {/* Start point handle */}
              <circle
                cx={firstPoint.x}
                cy={firstPoint.y}
                r={6}
                fill="white"
                stroke={drawing.color || '#64748b'}
                strokeWidth={2}
                style={{ cursor: 'move', pointerEvents: 'all' }}
              />
              {/* End point handle */}
              <circle
                cx={lastPoint.x}
                cy={lastPoint.y}
                r={6}
                fill="white"
                stroke={drawing.color || '#64748b'}
                strokeWidth={2}
                style={{ cursor: 'move', pointerEvents: 'all' }}
              />
            </>
          )}
        </g>
      );
    }

    return null;
  };


  const renderPreview = () => {
    // Support both tempPoints-based preview (click-click) and touchDrawing preview (tap-hold-drag)
    let startPixel: PixelPoint | null = null;
    let endPixel: PixelPoint | null = null;

    if (touchDrawing) {
      startPixel = touchDrawing.startPoint;
      endPixel = touchDrawing.currentPoint;
    } else if (previewPoint && tempPoints.length > 0) {
      startPixel = tempPoints[0];
      endPixel = previewPoint;
    }

    if (!startPixel || !endPixel) return null;

    // Use actual tool settings for preview so the line looks the same as the final
    // placed drawing (color, thickness, style). TradingView shows the real appearance
    // during preview, not a dull gray placeholder.
    const previewColor = getNewDrawingColor();
    const previewStroke = getNewDrawingStrokeWidth();
    const previewLineStyle = getNewDrawingLineStyle();
    const previewDash = previewLineStyle === 'dashed' ? '8,4' : previewLineStyle === 'dotted' ? '2,4' : 'none';
    const previewOpacity = (getNewDrawingOpacity() / 100);

    if (activeTool === 'trendRay') {
      // Extend preview line forward to chart edges
      const cw = containerRef.current?.clientWidth || 1000;
      const ch = containerRef.current?.clientHeight || 600;
      const chartW = cw - chartBounds.priceAxisWidth;
      const dx = endPixel.x - startPixel.x;
      const dy = endPixel.y - startPixel.y;
      let eX1 = startPixel.x, eY1 = startPixel.y, eX2 = endPixel.x, eY2 = endPixel.y;
      if (Math.abs(dx) < 0.001) {
        eX2 = startPixel.x; eY2 = dy > 0 ? ch : 0;
      } else {
        const tCandidates: number[] = [
          (0 - startPixel.x) / dx,
          (chartW - startPixel.x) / dx,
        ];
        if (Math.abs(dy) > 0.001) {
          tCandidates.push((0 - startPixel.y) / dy);
          tCandidates.push((ch - startPixel.y) / dy);
        }
        let tMax = 1;
        for (const t of tCandidates) {
          const ix = startPixel.x + dx * t;
          const iy = startPixel.y + dy * t;
          if (ix >= -1 && ix <= chartW + 1 && iy >= -1 && iy <= ch + 1) {
            if (t > tMax) tMax = t;
          }
        }
        eX2 = startPixel.x + dx * tMax;
        eY2 = startPixel.y + dy * tMax;
      }
      return (
        <line
          x1={eX1}
          y1={eY1}
          x2={eX2}
          y2={eY2}
          stroke={previewColor}
          strokeWidth={previewStroke}
          strokeDasharray={previewDash}
          opacity={previewOpacity}
          style={{ pointerEvents: 'none' }}
        />
      );
    }

    if (activeTool === 'trend') {
      // Simple segment preview, uses actual tool settings for WYSIWYG drawing
      return (
        <line
          x1={startPixel.x}
          y1={startPixel.y}
          x2={endPixel.x}
          y2={endPixel.y}
          stroke={previewColor}
          strokeWidth={previewStroke}
          strokeDasharray={previewDash}
          opacity={previewOpacity}
          style={{ pointerEvents: 'none' }}
        />
      );
    }

    if (activeTool === 'line') {
      // Lock Y to start point for horizontal constraint
      const lockedEndY = startPixel.y;
      return (
        <line
          x1={startPixel.x}
          y1={startPixel.y}
          x2={endPixel.x}
          y2={lockedEndY}
          stroke={previewColor}
          strokeWidth={previewStroke}
          strokeDasharray={previewDash}
          opacity={previewOpacity}
          style={{ pointerEvents: 'none' }}
        />
      );
    }

    if (activeTool === 'straightArrow') {
      // Calculate arrowhead for preview
      const angle = Math.atan2(endPixel.y - startPixel.y, endPixel.x - startPixel.x);
      const arrowLength = 12;
      const arrowAngle = Math.PI / 6;

      const arrowX1 = endPixel.x - arrowLength * Math.cos(angle - arrowAngle);
      const arrowY1 = endPixel.y - arrowLength * Math.sin(angle - arrowAngle);
      const arrowX2 = endPixel.x - arrowLength * Math.cos(angle + arrowAngle);
      const arrowY2 = endPixel.y - arrowLength * Math.sin(angle + arrowAngle);

      return (
        <g style={{ pointerEvents: 'none' }}>
          <line
            x1={startPixel.x}
            y1={startPixel.y}
            x2={endPixel.x}
            y2={endPixel.y}
            stroke={previewColor}
            strokeWidth={previewStroke}
            strokeDasharray={previewDash}
            opacity={previewOpacity}
          />
          <polygon
            points={`${endPixel.x},${endPixel.y} ${arrowX1},${arrowY1} ${arrowX2},${arrowY2}`}
            fill={previewColor}
            opacity={previewOpacity * 0.7}
          />
        </g>
      );
    }

    if (activeTool === 'rectangle') {
      const minX = Math.min(startPixel.x, endPixel.x);
      const minY = Math.min(startPixel.y, endPixel.y);
      const width = Math.abs(endPixel.x - startPixel.x);
      const height = Math.abs(endPixel.y - startPixel.y);

      return (
        <rect
          x={minX}
          y={minY}
          width={width}
          height={height}
          fill="none"
          stroke={previewColor}
          strokeWidth={previewStroke}
          strokeDasharray={previewDash}
          opacity={previewOpacity}
          style={{ pointerEvents: 'none' }}
        />
      );
    }

    if (activeTool === 'square') {
      // During drawing, enforce square constraint in pixels for visual feedback
      const size = Math.max(Math.abs(endPixel.x - startPixel.x), Math.abs(endPixel.y - startPixel.y));
      const minX = Math.min(startPixel.x, endPixel.x);
      const minY = Math.min(startPixel.y, endPixel.y);

      return (
        <rect
          x={minX}
          y={minY}
          width={size}
          height={size}
          fill="none"
          stroke={previewColor}
          strokeWidth={previewStroke}
          strokeDasharray={previewDash}
          opacity={previewOpacity}
          style={{ pointerEvents: 'none' }}
        />
      );
    }

    if (activeTool === 'circle') {
      // Fixed proportions - perfect circle
      const size = Math.max(Math.abs(endPixel.x - startPixel.x), Math.abs(endPixel.y - startPixel.y));
      const minX = Math.min(startPixel.x, endPixel.x);
      const minY = Math.min(startPixel.y, endPixel.y);
      const cx = minX + size / 2;
      const cy = minY + size / 2;
      const r = size / 2;

      return (
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={previewColor}
          strokeWidth={previewStroke}
          strokeDasharray={previewDash}
          opacity={previewOpacity}
          style={{ pointerEvents: 'none' }}
        />
      );
    }

    if (activeTool === 'triangle') {
      // Fixed proportions - equilateral triangle
      const size = Math.max(Math.abs(endPixel.x - startPixel.x), Math.abs(endPixel.y - startPixel.y));
      const minX = Math.min(startPixel.x, endPixel.x);
      const minY = Math.min(startPixel.y, endPixel.y);
      const height = size * Math.sqrt(3) / 2; // Equilateral triangle height
      const points = `${minX},${minY + height} ${minX + size / 2},${minY} ${minX + size},${minY + height}`;

      return (
        <polygon
          points={points}
          fill="none"
          stroke={previewColor}
          strokeWidth={previewStroke}
          strokeDasharray={previewDash}
          opacity={previewOpacity}
          style={{ pointerEvents: 'none' }}
        />
      );
    }

    if (activeTool === 'oval') {
      const minX = Math.min(startPixel.x, endPixel.x);
      const minY = Math.min(startPixel.y, endPixel.y);
      const width = Math.abs(endPixel.x - startPixel.x);
      const height = Math.abs(endPixel.y - startPixel.y);
      const cx = minX + width / 2;
      const cy = minY + height / 2;
      const rx = width / 2;
      const ry = height / 2;

      return (
        <ellipse
          cx={cx}
          cy={cy}
          rx={rx}
          ry={ry}
          fill="none"
          stroke={previewColor}
          strokeWidth={previewStroke}
          strokeDasharray={previewDash}
          opacity={previewOpacity}
          style={{ pointerEvents: 'none' }}
        />
      );
    }

    // Parallelogram preview
    if (activeTool === 'parallelogram') {
      const minX = Math.min(startPixel.x, endPixel.x);
      const minY = Math.min(startPixel.y, endPixel.y);
      const width = Math.abs(endPixel.x - startPixel.x);
      const height = Math.abs(endPixel.y - startPixel.y);
      const skew = width * 0.25;
      const points = `${minX + skew},${minY} ${minX + width + skew},${minY} ${minX + width},${minY + height} ${minX},${minY + height}`;

      return (
        <polygon
          points={points}
          fill="none"
          stroke={previewColor}
          strokeWidth={previewStroke}
          strokeDasharray={previewDash}
          opacity={previewOpacity}
          style={{ pointerEvents: 'none' }}
        />
      );
    }

    // Octagon preview
    if (activeTool === 'octagon') {
      const minX = Math.min(startPixel.x, endPixel.x);
      const minY = Math.min(startPixel.y, endPixel.y);
      const width = Math.abs(endPixel.x - startPixel.x);
      const height = Math.abs(endPixel.y - startPixel.y);
      const cx = minX + width / 2;
      const cy = minY + height / 2;
      const rx = width / 2;
      const ry = height / 2;

      const octagonPoints: string[] = [];
      for (let i = 0; i < 8; i++) {
        const angle = (Math.PI / 8) + (i * Math.PI / 4);
        const px = cx + rx * Math.cos(angle);
        const py = cy + ry * Math.sin(angle);
        octagonPoints.push(`${px},${py}`);
      }
      const points = octagonPoints.join(' ');

      return (
        <polygon
          points={points}
          fill="none"
          stroke={previewColor}
          strokeWidth={previewStroke}
          strokeDasharray={previewDash}
          opacity={previewOpacity}
          style={{ pointerEvents: 'none' }}
        />
      );
    }

    // New shapes preview: all use bounding box -> polygon, same logic as rendering
    if (['diamond', 'pentagon', 'hexagon', 'star', 'cross', 'arrowBlock', 'wedge', 'heart'].includes(activeTool as string)) {
      const minX = Math.min(startPixel.x, endPixel.x);
      const minY = Math.min(startPixel.y, endPixel.y);
      const w = Math.abs(endPixel.x - startPixel.x);
      const h = Math.abs(endPixel.y - startPixel.y);
      const cx = minX + w / 2;
      const cy = minY + h / 2;
      const rx = w / 2;
      const ry = h / 2;
      let pts = '';

      if (activeTool === 'diamond') {
        pts = `${cx},${minY} ${minX + w},${cy} ${cx},${minY + h} ${minX},${cy}`;
      } else if (activeTool === 'pentagon') {
        const v: string[] = [];
        for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + (i * 2 * Math.PI / 5); v.push(`${cx + rx * Math.cos(a)},${cy + ry * Math.sin(a)}`); }
        pts = v.join(' ');
      } else if (activeTool === 'hexagon') {
        const v: string[] = [];
        for (let i = 0; i < 6; i++) { const a = -Math.PI / 2 + (i * Math.PI / 3); v.push(`${cx + rx * Math.cos(a)},${cy + ry * Math.sin(a)}`); }
        pts = v.join(' ');
      } else if (activeTool === 'star') {
        const v: string[] = [];
        for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI / 5); const r = i % 2 === 0 ? 1 : 0.38; v.push(`${cx + rx * r * Math.cos(a)},${cy + ry * r * Math.sin(a)}`); }
        pts = v.join(' ');
      } else if (activeTool === 'cross') {
        const t = 0.3;
        pts = [`${cx-rx*t},${minY}`,`${cx+rx*t},${minY}`,`${cx+rx*t},${cy-ry*t}`,`${minX+w},${cy-ry*t}`,`${minX+w},${cy+ry*t}`,`${cx+rx*t},${cy+ry*t}`,`${cx+rx*t},${minY+h}`,`${cx-rx*t},${minY+h}`,`${cx-rx*t},${cy+ry*t}`,`${minX},${cy+ry*t}`,`${minX},${cy-ry*t}`,`${cx-rx*t},${cy-ry*t}`].join(' ');
      } else if (activeTool === 'arrowBlock') {
        const hs = minX + w * 0.6;
        pts = [`${minX},${cy-ry*0.4}`,`${hs},${cy-ry*0.4}`,`${hs},${minY}`,`${minX+w},${cy}`,`${hs},${minY+h}`,`${hs},${cy+ry*0.4}`,`${minX},${cy+ry*0.4}`].join(' ');
      } else if (activeTool === 'wedge') {
        pts = `${minX},${cy} ${minX + w},${minY} ${minX + w},${minY + h}`;
      } else if (activeTool === 'heart') {
        const v: string[] = [];
        for (let i = 0; i <= 16; i++) { const t = (i/16)*2*Math.PI; const hx = 16*Math.pow(Math.sin(t),3); const hy = -(13*Math.cos(t)-5*Math.cos(2*t)-2*Math.cos(3*t)-Math.cos(4*t)); v.push(`${cx+(hx/16)*rx},${cy+(hy/32)*ry*2-ry*0.1}`); }
        pts = v.join(' ');
      }

      return (
        <polygon points={pts} fill="none" stroke={previewColor} strokeWidth={previewStroke} strokeDasharray={previewDash} opacity={previewOpacity} style={{ pointerEvents: 'none' }} />
      );
    }

    // Free Triangle preview - show partial triangle as user clicks
    if (activeTool === 'freeTriangle') {
      if (tempPoints.length === 1) {
        return (
          <line
            x1={startPixel.x} y1={startPixel.y} x2={endPixel.x} y2={endPixel.y}
            stroke={previewColor} strokeWidth={previewStroke} strokeDasharray={previewDash} opacity={previewOpacity} style={{ pointerEvents: 'none' }}
          />
        );
      } else if (tempPoints.length === 2) {
        const p1 = tempPoints[0];
        const p2 = tempPoints[1];
        const p3 = endPixel;
        const points = `${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`;
        return (
          <polygon
            points={points} fill="none" stroke={previewColor} strokeWidth={previewStroke} strokeDasharray={previewDash} opacity={previewOpacity}
            style={{ pointerEvents: 'none' }}
          />
        );
      }
    }

    // Parallel Channel preview
    if (activeTool === 'parallelChannel') {
      if (tempPoints.length === 1) {
        // First point placed, show base line to cursor
        return (
          <line
            x1={startPixel.x} y1={startPixel.y} x2={endPixel.x} y2={endPixel.y}
            stroke={previewColor} strokeWidth={previewStroke} strokeDasharray={previewDash} opacity={previewOpacity} style={{ pointerEvents: 'none' }}
          />
        );
      } else if (tempPoints.length === 2) {
        // Two points placed, show channel preview
        const p1 = tempPoints[0];
        const p2 = tempPoints[1];
        const p3 = endPixel;
        const dx = p3.x - p1.x;
        const dy = p3.y - p1.y;
        const q3 = { x: p2.x + dx, y: p2.y + dy };
        const fillPoints = `${p1.x},${p1.y} ${p2.x},${p2.y} ${q3.x},${q3.y} ${p3.x},${p3.y}`;
        return (
          <g style={{ pointerEvents: 'none' }}>
            <polygon points={fillPoints} fill={previewColor} fillOpacity="0.06" stroke="none" />
            <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={previewColor} strokeWidth={previewStroke} strokeDasharray={previewDash} opacity={previewOpacity} />
            <line x1={p3.x} y1={p3.y} x2={q3.x} y2={q3.y} stroke={previewColor} strokeWidth={previewStroke} strokeDasharray={previewDash} opacity={previewOpacity} />
          </g>
        );
      }
    }

    if (activeTool === 'long' || activeTool === 'short') {
      const entryY = startPixel.y;
      let targetY = endPixel.y;

      // For shorts, if preview is above entry, flip it below
      // For longs, if preview is below entry, flip it above
      if (activeTool === 'short' && targetY < entryY) {
        const distance = entryY - targetY;
        targetY = entryY + distance;
      } else if (activeTool === 'long' && targetY > entryY) {
        const distance = targetY - entryY;
        targetY = entryY - distance;
      }

      const distance = Math.abs(targetY - entryY);
      const stopLossY = activeTool === 'long' ? entryY + distance : entryY - distance;

      const minX = Math.min(startPixel.x, endPixel.x);
      const maxX = Math.max(startPixel.x, endPixel.x);
      const width = maxX - minX;

      const isLong = activeTool === 'long';

      // For long: profit box goes UP from entry, stop loss goes DOWN
      // For short: profit box goes DOWN from entry, stop loss goes UP
      const profitTop = isLong ? Math.min(entryY, targetY) : entryY;
      const profitHeight = Math.abs(targetY - entryY);
      const stopLossTop = isLong ? entryY : Math.min(entryY, stopLossY);
      const stopLossHeight = Math.abs(stopLossY - entryY);

      // Preview zones, clipped by outer div (overflow:hidden), no SVG clipPath needed
      return (
        <g>
          {/* Profit box - always green */}
          <rect
            x={minX}
            y={profitTop}
            width={width}
            height={profitHeight}
            fill="#22c55e40"
            stroke="#22c55e"
            strokeWidth="2"
            strokeDasharray="5,5"
            style={{ pointerEvents: 'none' }}
          />
          {/* Stop loss box - always red */}
          <rect
            x={minX}
            y={stopLossTop}
            width={width}
            height={stopLossHeight}
            fill="#ef444440"
            stroke="#ef4444"
            strokeWidth="2"
            strokeDasharray="5,5"
            style={{ pointerEvents: 'none' }}
          />
        </g>
      );
    }

    if (activeTool === 'fibonacci' || activeTool === 'fibExtension') {
      const levels = activeTool === 'fibExtension' ? [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2.0, 2.618] : [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
      // fibExtension preview: max level lands on the second pointer so the
      // dashed lines stay inside the rectangle defined by the two handles.
      const maxLevel = activeTool === 'fibExtension' ? Math.max(...levels, 1) : 1;
      return (
        <g>
          {levels.map((level) => {
            const y = startPixel.y + (endPixel.y - startPixel.y) * (level / maxLevel);
            return (
              <line
                key={level}
                x1={Math.min(startPixel.x, endPixel.x)}
                y1={y}
                x2={Math.max(startPixel.x, endPixel.x)}
                y2={y}
                stroke={previewColor}
                strokeWidth="1"
                strokeDasharray="3,3"
                opacity={previewOpacity}
                style={{ pointerEvents: 'none' }}
              />
            );
          })}
        </g>
      );
    }

    return null;
  };

  const renderBrushPreview = () => {
    if (brushPath.length < 2) return null;

    // Create smooth Catmull-Rom spline path for brush strokes (matches saved rendering)
    const createSmoothPath = (points: PixelPoint[]): string => {
      if (points.length < 2) return '';
      if (points.length === 2) {
        return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
      }

      // Use Catmull-Rom to Bezier conversion for ultra-smooth curves
      const tension = 0.5;

      let path = `M ${points[0].x} ${points[0].y}`;

      for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(0, i - 1)];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[Math.min(points.length - 1, i + 2)];

        const cp1x = p1.x + (p2.x - p0.x) * tension / 3;
        const cp1y = p1.y + (p2.y - p0.y) * tension / 3;
        const cp2x = p2.x - (p3.x - p1.x) * tension / 3;
        const cp2y = p2.y - (p3.y - p1.y) * tension / 3;

        path += ` C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${p2.x} ${p2.y}`;
      }

      return path;
    };

    const pathData = createSmoothPath(brushPath);
    // Use pre-placement settings bar values for preview so the user sees
    // exactly what the brush will look like while drawing
    const previewColor = toolSettings?.color ?? getBrushToolColor(activeTool);
    const previewOpacity = (toolSettings?.opacity ?? getBrushToolOpacity(activeTool)) / 100;
    const previewStrokeWidth = toolSettings?.strokeWidth ?? getBrushToolStrokeWidth(activeTool);

    return (
      <g>
        <path
          d={pathData}
          stroke={previewColor}
          strokeWidth={previewStrokeWidth}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeOpacity={previewOpacity}
          style={{ pointerEvents: 'none' }}
        />
        {/* Arrow head preview for arrow tool */}
        {activeTool === 'arrow' && brushPath.length >= 2 && (() => {
          const last = brushPath[brushPath.length - 1];
          const secondLast = brushPath[Math.max(0, brushPath.length - 5)];
          const angle = Math.atan2(last.y - secondLast.y, last.x - secondLast.x);
          const arrowSize = 12;
          const arrowAngle = Math.PI / 6;
          return (
            <polygon
              points={`
                ${last.x},${last.y}
                ${last.x - arrowSize * Math.cos(angle - arrowAngle)},${last.y - arrowSize * Math.sin(angle - arrowAngle)}
                ${last.x - arrowSize * Math.cos(angle + arrowAngle)},${last.y - arrowSize * Math.sin(angle + arrowAngle)}
              `}
              fill={previewColor}
              fillOpacity={previewOpacity}
              style={{ pointerEvents: 'none' }}
            />
          );
        })()}
      </g>
    );
  };

  const renderMeasurePreview = () => {
    if (!measureState) return null;

    const startPixel = measureState.start;
    const endPixel = measureState.current;

    // Convert pixels to chart coordinates for calculations
    const startTime = converter.xToTime(startPixel.x);
    const endTime = converter.xToTime(endPixel.x);
    const startPrice = converter.yToPrice(startPixel.y);
    const endPrice = converter.yToPrice(endPixel.y);

    if (startTime === null || endTime === null) return null;

    // Calculate stats
    const timeDiffMs = Math.abs(endTime - startTime);
    const priceDiff = endPrice - startPrice;
    const percentChange = startPrice !== 0 ? ((priceDiff / startPrice) * 100) : 0;

    // Calculate candles based on timeframe
    const candleCount = Math.floor(timeDiffMs / timeframeMs);

    // Calculate points/pips based on instrument type (the usual retail FX/CFD convention)
    const sym = currentSymbol?.toUpperCase() || '';
    const isGoldMeasure = sym.includes('XAU') || sym.includes('GOLD');
    const isSilverMeasure = sym.includes('XAG') || sym.includes('SILVER');
    const isIndexMeasure = sym.includes('SPX') || sym.includes('NAS') || sym.includes('DJI') || sym.includes('DAX') || sym.includes('FTSE') || sym.includes('NIK') || sym.includes('US500') || sym.includes('US100') || sym.includes('US30');
    const isForexMeasure = sym.includes('/') && !sym.includes('BTC') && !sym.includes('ETH') && !sym.includes('LTC') && !sym.includes('XRP') && !sym.includes('SOL') && !sym.includes('DOGE') && !sym.includes('ADA') && !sym.includes('AVAX') && !sym.includes('DOT') && !sym.includes('LINK') && !sym.includes('BNB') && !isGoldMeasure && !isSilverMeasure && !isIndexMeasure;
    const isJpyMeasure = isForexMeasure && sym.includes('JPY');

    let pipMultiplier: number;
    if (isGoldMeasure) {
      pipMultiplier = 10;         // Gold: $1 = 10 pips
    } else if (isSilverMeasure) {
      pipMultiplier = 100;        // Silver: $1 = 100 pips
    } else if (isIndexMeasure) {
      pipMultiplier = 1;          // Indices: 1 point = 1 pt
    } else if (isJpyMeasure) {
      pipMultiplier = 100;        // JPY pairs: 0.01 = 1 pip
    } else if (isForexMeasure) {
      pipMultiplier = 10000;      // Standard forex: 0.0001 = 1 pip
    } else {
      // Crypto & stocks
      if (startPrice >= 1000) {
        pipMultiplier = 1;        // BTC: $1 = 1 pip
      } else if (startPrice >= 10) {
        pipMultiplier = 100;      // ETH/LTC: $0.01 = 1 pip
      } else if (startPrice >= 0.1) {
        pipMultiplier = 10000;    // SOL/XRP: $0.0001 = 1 pip
      } else {
        pipMultiplier = 100000;   // DOGE: $0.00001 = 1 pip
      }
    }
    const pips = Math.abs(priceDiff) * pipMultiplier;

    // Format time elapsed
    const hours = Math.floor(timeDiffMs / (1000 * 60 * 60));
    const minutes = Math.floor((timeDiffMs % (1000 * 60 * 60)) / (1000 * 60));
    const days = Math.floor(hours / 24);
    let timeStr = '';
    if (days > 0) {
      timeStr = `${days}d ${hours % 24}h`;
    } else if (hours > 0) {
      timeStr = `${hours}h ${minutes}m`;
    } else {
      timeStr = `${minutes}m`;
    }

    const isUp = priceDiff >= 0;
    const boxColor = isUp ? '#2962ff' : '#2962ff'; // TradingView uses blue
    const bgColor = 'rgba(41, 98, 255, 0.15)';

    // Calculate box position
    const minX = Math.min(startPixel.x, endPixel.x);
    const maxX = Math.max(startPixel.x, endPixel.x);
    const minY = Math.min(startPixel.y, endPixel.y);
    const maxY = Math.max(startPixel.y, endPixel.y);
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);

    // Chart width for extended lines
    const chartWidth = containerDims.width - chartBounds.priceAxisWidth;

    // Info box - position at top center of selection like TradingView
    const infoWidth = 130;
    const infoHeight = 68;
    const infoCenterX = minX + width / 2;
    const infoX = Math.max(5, Math.min(chartWidth - infoWidth - 5, infoCenterX - infoWidth / 2));
    const infoY = Math.max(5, minY - infoHeight - 15);

    // Format display values like TradingView: "70.7 (0.15%) 707"
    const priceAbsDiff = Math.abs(priceDiff);
    const priceDisplay = startPrice < 10 ? priceAbsDiff.toFixed(4) : priceAbsDiff.toFixed(2);
    const percentDisplay = `${isUp ? '' : '-'}${Math.abs(percentChange).toFixed(2)}%`;
    const pipsDisplay = Math.round(pips);

    return (
      <g style={{ pointerEvents: 'none' }}>
        {/* Selection rectangle with fill */}
        <rect
          x={minX}
          y={minY}
          width={width}
          height={height}
          fill={bgColor}
          stroke="none"
        />

        {/* Extended horizontal dashed lines */}
        <line
          x1={0}
          y1={startPixel.y}
          x2={chartWidth}
          y2={startPixel.y}
          stroke="#64748b"
          strokeWidth="1"
          strokeDasharray="4,4"
        />
        <line
          x1={0}
          y1={endPixel.y}
          x2={chartWidth}
          y2={endPixel.y}
          stroke="#64748b"
          strokeWidth="1"
          strokeDasharray="4,4"
        />

        {/* Vertical dashed line at end */}
        <line
          x1={maxX}
          y1={0}
          x2={maxX}
          y2={containerDims.height - chartBounds.timeAxisHeight}
          stroke="#64748b"
          strokeWidth="1"
          strokeDasharray="4,4"
        />

        {/* Center arrow line */}
        <line
          x1={infoCenterX}
          y1={minY}
          x2={infoCenterX}
          y2={infoY + infoHeight}
          stroke={boxColor}
          strokeWidth="1"
        />

        {/* Arrow head at top of selection box */}
        <polygon
          points={`${infoCenterX},${minY} ${infoCenterX - 4},${minY - 8} ${infoCenterX + 4},${minY - 8}`}
          fill={boxColor}
        />

        {/* Info box with rounded corners like TradingView */}
        <rect
          x={infoX}
          y={infoY}
          width={infoWidth}
          height={infoHeight}
          fill={boxColor}
          rx="6"
          ry="6"
        />

        {/* Line 1: Price diff (percent) */}
        <text
          x={infoX + infoWidth / 2}
          y={infoY + 18}
          fill="#ffffff"
          fontSize="12"
          fontWeight="bold"
          fontFamily="system-ui, -apple-system, sans-serif"
          textAnchor="middle"
        >
          {isUp ? '+' : '-'}{priceDisplay} ({percentDisplay})
        </text>

        {/* Line 2: pips */}
        <text
          x={infoX + infoWidth / 2}
          y={infoY + 34}
          fill="rgba(255,255,255,0.9)"
          fontSize="11"
          fontFamily="system-ui, -apple-system, sans-serif"
          textAnchor="middle"
        >
          {pipsDisplay} pips
        </text>

        {/* Line 3: bars, time */}
        <text
          x={infoX + infoWidth / 2}
          y={infoY + 50}
          fill="rgba(255,255,255,0.9)"
          fontSize="11"
          fontFamily="system-ui, -apple-system, sans-serif"
          textAnchor="middle"
        >
          {candleCount} bars, {timeStr}
        </text>
      </g>
    );
  };

  // Render dotted crosshair for precise drawing placement and dragging
  // Matches the chart's native crosshair style (--electric-blue color)
  const renderCrosshair = () => {
    // Show crosshair when: tool is active (cursorPosition), placing drawing (previewPoint), or dragging
    const crosshairPoint = cursorPosition || previewPoint;

    const chartWidth = containerDims.width - chartBounds.priceAxisWidth;
    const chartHeight = containerDims.height - chartBounds.timeAxisHeight;

    // Use the same electric-blue color as the chart's native crosshair
    const crosshairColor = 'rgba(0, 194, 255, 0.8)'; // --electric-blue equivalent

    // Always render crosshair elements with stable IDs so direct DOM manipulation
    // during drags can target them without React re-renders
    const isVisible = !!crosshairPoint;

    return (
      <g style={{ pointerEvents: 'none' }}>
        {/* Horizontal line */}
        <line
          id={`${clipId}_drawing-crosshair-h`}
          x1={0}
          y1={crosshairPoint?.y ?? 0}
          x2={chartWidth}
          y2={crosshairPoint?.y ?? 0}
          stroke={crosshairColor}
          strokeWidth="1"
          strokeDasharray="4,4"
          style={{ display: isVisible ? '' : 'none' }}
        />
        {/* Vertical line */}
        <line
          id={`${clipId}_drawing-crosshair-v`}
          x1={crosshairPoint?.x ?? 0}
          y1={0}
          x2={crosshairPoint?.x ?? 0}
          y2={chartHeight}
          stroke={crosshairColor}
          strokeWidth="1"
          strokeDasharray="4,4"
          style={{ display: isVisible ? '' : 'none' }}
        />
      </g>
    );
  };

  // Only enable pointer events when actively drawing, dragging, or needing to handle deselection
  // This ensures wheel/scroll events always pass through to the chart when not interacting
  // Enable pointer events when: there's an active tool OR dragging OR placing a drawing
  // For deselection: only enable if this overlay has the selection (not all overlays in multi-panel)
  const isPlacingDrawing = tempPoints.length > 0 || touchDrawing !== null || isDrawingBrushRef.current;
  const needsPointerEvents = activeTool !== null || draggingId !== null || isPlacingDrawing || (selectedDrawingId !== null && selectedDrawingId !== undefined) || measureState?.frozen;

  // Only block touch actions when actively drawing (not for passive viewing)
  // Include touchDrawing, isDrawing (brush), and measureState for all drawing scenarios
  const blockTouchActions = activeTool !== null || draggingId !== null || touchDrawing !== null || isDrawingBrushRef.current || measureState !== null;

  // When overlay only needs pointer-events for deselection (a drawing is selected
  // but no tool is active), we keep the outer div pointer-events:none and instead
  // add an inner event-capture div covering the full chart area. The OHLC zone
  // pass-through is handled inside handleMouseDown (after the drawing hit-test),
  // so this div can safely cover the entire area without creating a dead zone
  // where drawings near the top of the chart can't be interacted with.
  const onlyForDeselect = needsPointerEvents && !activeTool && !draggingId && !isPlacingDrawing && !measureState?.frozen;

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 ${className || ''}`}
      onMouseMove={handleMouseMove}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      // Wheel events (zoom/scroll) must always pass through to the chart canvas
      // underneath, even when a drawing is selected or hovered. Without this,
      // hovering over a long/short position drawing (which has pointerEvents:'all'
      // on its filled rects and handles) blocks wheel events from reaching the
      // canvas, making zoom/pan impossible while the cursor is over a drawing.
      // The overlay and chart canvas live in sibling component trees, so wheel
      // events never naturally reach the canvas. We find the nearest canvas with
      // class "cursor-crosshair" (ProChart's overlay canvas, which has the
      // addEventListener('wheel') handler) and re-dispatch the event to it.
      onWheel={(e) => {
        const overlay = containerRef.current;
        if (!overlay) return;
        // Walk up to the nearest shared container and find the chart canvas.
        // ProChart's overlay canvas has class "cursor-crosshair" and the wheel
        // listener attached via addEventListener in a useEffect.
        let searchRoot = overlay.parentElement;
        let canvas: Element | null = null;
        // Search up to 5 levels to find the canvas (handles different nesting depths)
        for (let i = 0; i < 5 && searchRoot && !canvas; i++) {
          canvas = searchRoot.querySelector('canvas.cursor-crosshair');
          if (!canvas) searchRoot = searchRoot.parentElement;
        }
        if (canvas) {
          canvas.dispatchEvent(new WheelEvent('wheel', {
            deltaX: e.deltaX,
            deltaY: e.deltaY,
            deltaZ: e.deltaZ,
            deltaMode: e.deltaMode,
            clientX: e.clientX,
            clientY: e.clientY,
            screenX: e.screenX,
            screenY: e.screenY,
            ctrlKey: e.ctrlKey,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            metaKey: e.metaKey,
            bubbles: true,
            cancelable: true,
          }));
        }
      }}
      style={{
        pointerEvents: (needsPointerEvents && !onlyForDeselect) ? 'all' : 'none',
        touchAction: blockTouchActions ? 'none' : 'auto',
        WebkitUserSelect: 'none',
        userSelect: 'none',
        WebkitTouchCallout: 'none',
        overscrollBehavior: blockTouchActions ? 'contain' : 'auto',
        WebkitOverflowScrolling: 'touch',
      }}
    >
      {/* Deselect capture div: covers the full chart area so clicking empty
          space deselects the current drawing. Previously started at top:30 to
          let OHLC toggle clicks pass through, but that created a 30px dead
          zone where drawings near the top of the chart couldn't be selected
          or dragged. Now starts at top:0 because the handleMouseDown handler
          checks for drawings before falling through to the OHLC pass-through. */}
      {onlyForDeselect && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            pointerEvents: 'all',
          }}
        />
      )}
      {containerDims.width > 0 && containerDims.height > 0 && (
        <>
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: Math.max(0, containerDims.width - chartBounds.priceAxisWidth),
              height: Math.max(0, containerDims.height - chartBounds.timeAxisHeight - (chartBounds.indicatorHeight ?? 0)),
              overflow: 'hidden',
            }}
          >
            <svg
              width={Math.max(0, containerDims.width - chartBounds.priceAxisWidth)}
              height={containerDims.height}
              viewBox={`0 0 ${Math.max(0, containerDims.width - chartBounds.priceAxisWidth)} ${containerDims.height}`}
              style={{
                pointerEvents: 'none',
                display: 'block',
                position: 'absolute',
                top: 0,
                left: 0,
              }}
            >
              <g>
                {renderCrosshair()}
                {!isHidden && drawings.map(renderDrawing)}
                {renderPreview()}
                {renderBrushPreview()}
                {renderMeasurePreview()}
              </g>
            </svg>
          </div>
        </>
      )}

      {/* DOM-driven Axis Badges (Phase 2 Rework) - Zero React Overhead! */}
      {[0, 1, 2, 3].map(i => (
        <Fragment key={i}>
          <div 
            id={`${clipId}_dom-price-badge-${i}`}
            style={{ 
              display: 'none', 
              position: 'absolute', 
              left: `calc(100% - ${chartBounds.priceAxisWidth - 3}px)`, 
              transform: 'translateY(-50%)', 
              backgroundColor: '#2962FF', /* TradingView Blue */
              color: 'white', 
              padding: '2px 4px', 
              borderRadius: '4px', 
              fontSize: '11px',
              fontFamily: '"SF Mono", "Cascadia Code", Consolas, monospace',
              pointerEvents: 'none',
              zIndex: 50,
              whiteSpace: 'nowrap'
            }} 
          />
          <div 
            id={`${clipId}_dom-time-badge-${i}`}
            style={{ 
              display: 'none', 
              position: 'absolute', 
              bottom: `${Math.max(0, (chartBounds.timeAxisHeight - 22) / 2)}px`, 
              transform: 'translateX(-50%)', 
              backgroundColor: '#2962FF',
              color: 'white', 
              padding: '4px 8px', 
              borderRadius: '4px', 
              fontSize: '11px',
              fontFamily: '"SF Mono", "Cascadia Code", Consolas, monospace',
              pointerEvents: 'none',
              zIndex: 50,
              whiteSpace: 'nowrap'
            }} 
          />
        </Fragment>
      ))}

      {/* Drawing cursor preview badges (blue price/time on axes) are now rendered
          on the chart canvas by the chart component. The overlay writes cursor position to
          drawingCursorRef and triggers canvas redraw via requestRedrawRef. Canvas
          rendering avoids z-index/overflow/React-reconciliation issues. */}

      {textInput && (
        <div
          className="absolute"
          style={{
            left: textInput.x,
            top: textInput.y,
            transform: 'translate(-50%, -100%)',
            pointerEvents: 'all',
          }}
        >
          <input
            type="text"
            autoFocus
            value={textInput.value}
            onChange={(e) => setTextInput({ ...textInput, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleTextSubmit();
              if (e.key === 'Escape') setTextInput(null);
            }}
            onBlur={handleTextSubmit}
            className="px-2 py-1 bg-black/80 border border-gray-600 rounded text-white text-sm"
            placeholder="Enter text..."
          />
        </div>
      )}

    </div>
  );
};

// Memoize to avoid re-renders from unrelated parent updates
export const ChartDrawingOverlay = memo(ChartDrawingOverlayComponent);
