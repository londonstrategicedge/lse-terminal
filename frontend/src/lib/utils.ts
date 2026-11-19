import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { RIGHT_TOOLBAR_WIDTH } from "@/components/chart/RightToolbar";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * The decimals the chart's host declares for the instruments of a source (a
 * broker's catalog states one per instrument), by source and then by symbol.
 * Read first by formatPriceForSymbol for a chart that names its source, so an
 * instrument prints to its own precision rather than to a guess from how its
 * symbol is spelt: a pair spelt EUR_USD was read as a share and 1.27705
 * printed "1.28". Kept by source, so one source's digits never reach another
 * source's chart (the backtest replays another source under the same
 * spellings); a source's are replaced whole when its host sends them again
 * (mount.tsx, `priceDigits` with `priceSource`). A symbol a source does not
 * name, and a chart that names no source, keep the rules below.
 */
const declaredDigits = new Map<string, Map<string, number>>();
let declaredVersion = 0;

export function setPriceDigits(map: Record<string, unknown> | null | undefined, source?: string | null): void {
  const next = new Map<string, number>();
  for (const [symbol, d] of Object.entries(map || {})) {
    if (typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 20) next.set(symbol, d);
  }
  if (source) declaredDigits.set(String(source), next);
  declaredVersion += 1;
}

/** Changes whenever the declarations do: a memo of a formatted price depends on it. */
export function priceDigitsVersion(): number {
  return declaredVersion;
}

/**
 * The price a chart's order form is filled in with, from the level clicked:
 * at the places the chart's source declares for the instrument (the digits
 * above), as a plain decimal with no thousands separator, so a broker that
 * refuses more decimals than an instrument has is sent what it takes (a
 * five-place pair clicked at 0.694281 is filled 0.69428). With none declared,
 * by its size as before: 2 places from 1000, 3 from 100, 4 from 1, else 6,
 * with no zero kept at the end.
 */
export function orderFormPrice(price: number, symbol?: string, source?: string | null): string {
  const own = source && symbol ? declaredDigits.get(String(source)) : undefined;
  const declared = own ? own.get(symbol as string) : undefined;
  if (declared !== undefined) return price.toFixed(declared);
  return String(+price.toFixed(price >= 1000 ? 2 : price >= 100 ? 3 : price >= 1 ? 4 : 6));
}

/**
 * Format a price the same way the chart Y-axis does. This is the single
 * source of truth for price formatting so that axis-width calculations
 * always match what actually gets rendered. ProChart.tsx's formatPrice
 * useCallback delegates to this function, with its axis's `scale`
 * (priceAxisScale): the size a declared precision's places are chosen by,
 * once for every label of that axis. With none, a price's own size.
 */
export function formatPriceForSymbol(price: number, symbol?: string, source?: string | null, scale?: number): string {
  // Add thousand separators (e.g. 4656.00 -> 4,656.00)
  const addCommas = (s: string) => {
    const [int, dec] = s.split('.');
    const withCommas = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return dec !== undefined ? `${withCommas}.${dec}` : withCommas;
  };
  const fmt = (p: number, decimals: number) => addCommas(p.toFixed(decimals));

  // === DECLARED by the chart's source (a broker's catalog) - at most that ===
  // A declared precision is a maximum. Where a price of this size can use it
  // (about seven significant figures) it is printed in full, so every label
  // of the instrument carries it alike (a pair's 1.27100 beside 1.27105). A
  // venue's increment finer than that (one quotes every coin to nine places)
  // is cut to what the price can use, never below two: 74,193.08, not
  // 74,193.080000000. No zero is trimmed: the places are chosen once, by
  // `scale` when an axis gives one (the size of its largest label), so one
  // axis does not print 9,999.500 above 10,000.00.
  const own = source && symbol ? declaredDigits.get(source) : undefined;
  const declared = own ? own.get(symbol as string) : undefined;
  if (declared !== undefined) {
    const size = scale !== undefined && scale > 0 && isFinite(scale) ? scale : Math.abs(price);
    const fits = size > 0 && isFinite(size) ? Math.max(2, 6 - Math.floor(Math.log10(size))) : declared;
    return fmt(price, Math.min(declared, fits));
  }

  // === METALS (XAU, XAG, XPT, XPD, XCU) - always 2 decimal places ===
  const metalPatterns = ['XAU', 'XAG', 'XPT', 'XPD', 'XCU'];
  if (symbol && metalPatterns.some(metal => symbol.includes(metal))) {
    return fmt(price, 2);
  }

  // === INDICES - always 2 decimal places ===
  const indexPatterns = ['SPX500', 'NAS100', 'US30', 'US2000', 'UK100', 'UK250', 'DE30', 'FR40', 'EU50', 'JP225', 'AU200', 'HK33', 'CN50', 'VIX', 'VSTOXX'];
  if (symbol && indexPatterns.some(idx => symbol.includes(idx))) {
    return fmt(price, 2);
  }

  // === COMMODITIES (energy, grains, softs, industrial metals, livestock) ===
  const commodityPatterns = ['WTICO', 'BCO', 'NATGAS', 'CORN', 'WHEAT', 'SOYBN', 'OATS', 'RICE', 'SUGAR', 'COFFEE', 'COCOA', 'COTTON', 'OJ', 'LUMBER', 'CATTLE', 'NICKEL', 'ALUMINIUM', 'LEAD', 'IRON'];
  if (symbol && commodityPatterns.some(comm => symbol.includes(comm))) {
    if (symbol.includes('NATGAS') || symbol.includes('SUGAR')) return fmt(price, 3);
    return fmt(price, 2);
  }

  // === FOREX PAIRS spelt with an underscore (EUR_USD), none declared ===
  const cryptoPatterns = ['BTC', 'ETH', 'BNB', 'XRP', 'SOL', 'ADA', 'DOGE', 'DOT', 'AVAX', 'LTC', 'LINK', 'UNI', 'ATOM'];
  if (symbol && /^[A-Z]{3}_[A-Z]{3}$/.test(symbol) && !cryptoPatterns.some(crypto => symbol.includes(crypto))) {
    return symbol.includes('JPY') ? fmt(price, 3) : fmt(price, 5);
  }

  // === STOCKS & ETFs - always 2 decimal places ===
  const isStock = symbol && /^[A-Z0-9._-]+$/.test(symbol) && !symbol.includes('/');
  if (isStock) {
    return fmt(price, 2);
  }

  // === CRYPTO - 2 decimals for large values, more for small ===
  if (symbol && cryptoPatterns.some(crypto => symbol.includes(crypto))) {
    if (price >= 100) return fmt(price, 2);
    if (price >= 1) return fmt(price, 4);
    return fmt(price, 6);
  }

  // === FOREX PAIRS ===
  const isForexPair = symbol && /^[A-Z]{3}\/[A-Z]{3}$/.test(symbol);
  if (isForexPair) {
    if (symbol.includes('JPY')) return fmt(price, 3);
    return fmt(price, 5);
  }

  // === FALLBACK ===
  if (price >= 100) return fmt(price, 2);
  if (price >= 1) return fmt(price, 4);
  return fmt(price, 6);
}

/**
 * The size an axis's price labels choose their places by: its largest label,
 * found by the axis's own label loop (labels every `step` from `start` up to
 * `max`, drawn where they sit 10 px inside the pane and at least `gap` px
 * apart) without drawing it. Every label, the crosshair and the last-price
 * label then print at the same places (formatPriceForSymbol's `scale`). A
 * label that prints as a power of ten counts as one: the sum of the steps
 * can land a hair under it. undefined when the axis draws nothing.
 */
export function priceAxisScale(start: number, max: number, step: number, toY: (price: number) => number,
                               height: number, gap: number): number | undefined {
  if (!(step > 0) || !isFinite(step) || !isFinite(start)) return undefined;
  let largest = 0;
  let lastY = -Infinity;
  for (let price = start; price <= max; price += step) {
    const y = toY(price);
    if (y >= 10 && y <= height - 10) {
      if (Math.abs(y - lastY) < gap) continue;
      lastY = y;
      largest = Math.max(largest, Math.abs(price));
    }
  }
  return largest > 0 ? largest * (1 + 1e-9) : undefined;
}

/**
 * Calculate dynamic Y-axis width based on the symbol's price format.
 * Adaptive on ALL screen sizes: formats a sample price with the real
 * formatting function and measures the string length, so the axis is
 * always tight-fit to the actual rendered labels. Silver "72.57" (5 chars)
 * gets a much narrower axis than BTC "69,161.91" (9 chars).
 */
export function calculatePriceAxisWidth(
  isMobile: boolean,
  symbol?: string,
  samplePrice?: number,
  rightOffset?: number,
  source?: string | null
): number {
  const price = samplePrice || 100;
  const isDesktop = typeof window !== 'undefined' && window.innerWidth >= 1024;

  // Format the sample price exactly as the chart renders it, then measure
  // the resulting string length. This guarantees the axis width matches the
  // actual label width, no matter the asset type or decimal convention. The
  // chart's own source decides its declared digits, here as on its labels.
  const formatted = formatPriceForSymbol(price, symbol, source);
  const charCount = formatted.length;

  // TradingView-tight axis sizing: ~6.5px per digit at 12px sans-serif.
  // Right padding has to match the 4px right anchor used in BTChart/ProChart's
  // priceLabelX (= width - rightOffset - 4); anything less and the right edge
  // computation here disagrees with the actual paint position. Left padding
  // is the visible breathing room between the chart canvas right edge and the
  // start of the label text; 8px is the minimum that doesn't look crammed for
  // 7-char FX prices like "1.17400" on desktop.
  const pxPerChar = isDesktop ? 6.5 : 6.2;
  const padding = 12; // 8px left breathing room + 4px right anchor offset
  const baseWidth = Math.ceil(padding + charCount * pxPerChar);

  if (isMobile) {
    return Math.max(34, baseWidth);
  }

  if (isDesktop) {
    // Desktop: tight label width + right-side gap.
    // rightOffset controls how much space to reserve on the right:
    //   undefined = default toolbar overlay (48px)
    //   0         = no gap (toolbar pushed away / collapsed)
    //   12        = small breathing room (multi-panel left columns)
    const toolbarGap = rightOffset !== undefined ? rightOffset : RIGHT_TOOLBAR_WIDTH;
    return Math.max(40, baseWidth) + toolbarGap;
  }

  // Tablet
  return Math.max(36, baseWidth);
}
