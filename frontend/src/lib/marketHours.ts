// =============================================================================
// marketHours.ts: Market open/closed logic for all asset classes.
//
// HOW IT WORKS:
//   1. Every symbol in the instrument catalog has a MIC code and a category.
//   2. When catalog data loads, useMarketData calls setMicMap() to populate a
//      module-level lookup: symbol -> { mic, category }.
//   3. isMarketOpenForPair(symbol) checks the MIC map first. If the symbol is
//      found, it uses the MIC to determine which market hours rule applies.
//   4. If the symbol is NOT in the MIC map (catalog not loaded yet, or it's an
//      unknown symbol), it falls back to regex-based getAssetType() guessing.
//
// MIC-TO-MARKET-HOURS MAPPING:
//   XCRYPTO           -> always open (24/7)
//   XFOREX            -> forex hours (Sun 5pm ET to Fri 5pm ET)
//   XOANDA commodity  -> CME Globex (Sun 6pm ET to Fri 5pm ET, daily 5-6pm break)
//   XOANDA index      -> CME Globex (same as commodity)
//   XNYS              -> US stock hours (9:30am to 4pm ET, holidays, early closes)
//   XLON              -> London (8am to 4:30pm London time)
//   XASX              -> Sydney (10am to 4pm AEST/AEDT)
//   XBOM              -> Mumbai (9:15am to 3:30pm IST)
//   XHKG              -> Hong Kong (9:30am to 4pm HKT, lunch break 12-1pm)
//   XKRX              -> Seoul (9am to 3:30pm KST)
//   XTAI              -> Taipei (9am to 1:30pm CST)
//   XTKS              -> Tokyo (9am to 3pm JST, lunch break 11:30am-12:30pm)
//
// DST HANDLING:
//   All ET-based checks use getETTime() which calculates the correct UTC offset
//   dynamically (EDT = UTC-4 in summer, EST = UTC-5 in winter). This avoids the
//   bug where hardcoded UTC hours (e.g. "Sunday 22:00 UTC") are only correct
//   during EST and wrong by 1 hour during EDT.
//
//   Exchange-specific checks (XLON, XASX, etc.) use Intl.DateTimeFormat which
//   handles DST automatically via IANA timezone names.
// =============================================================================


// =============================================================================
// MODULE-LEVEL MIC MAP
// Populated by setMicMap() when catalog data loads in useMarketData.ts.
// Maps symbol (both "EUR/USD" and "EURUSD" forms) to { mic, category }.
// =============================================================================

const _micMap = new Map<string, { mic: string; category: string }>();

/**
 * Called by useMarketData.ts when catalog data loads. Builds the symbol-to-MIC
 * lookup that isMarketOpenForPair uses to determine market hours.
 *
 * Accepts an array of catalog records with symbol, mic, and category fields.
 * Builds both slash and no-slash keys so "EUR/USD" and "EURUSD" both resolve.
 */
export const setMicMap = (symbols: Array<{ symbol: string; mic: string | null; category: string }>) => {
  _micMap.clear();
  for (const s of symbols) {
    if (!s.mic) continue;
    const entry = { mic: s.mic, category: s.category };
    // Store under both canonical ("EUR/USD") and URL-safe ("EURUSD") keys,
    // plus uppercase variants, so lookups work regardless of input format.
    _micMap.set(s.symbol, entry);
    _micMap.set(s.symbol.toUpperCase(), entry);
    const urlKey = s.symbol.replace('/', '');
    if (urlKey !== s.symbol) {
      _micMap.set(urlKey, entry);
      _micMap.set(urlKey.toUpperCase(), entry);
    }
  }
};

/**
 * Look up a symbol's MIC and category from the catalog-populated map.
 * Returns null if the catalog hasn't loaded yet or symbol is unknown.
 */
const getMicInfo = (symbol: string): { mic: string; category: string } | null => {
  return _micMap.get(symbol) || _micMap.get(symbol.toUpperCase()) || null;
};


// =============================================================================
// HOLIDAYS AND EARLY CLOSES
// =============================================================================

const US_HOLIDAYS_2025 = [
  '2025-01-01', // New Year's Day
  '2025-01-20', // MLK Day
  '2025-02-17', // Presidents Day
  '2025-04-18', // Good Friday
  '2025-05-26', // Memorial Day
  '2025-06-19', // Juneteenth
  '2025-07-04', // Independence Day
  '2025-09-01', // Labor Day
  '2025-11-27', // Thanksgiving
  '2025-12-25', // Christmas
];

const US_HOLIDAYS_2026 = [
  '2026-01-01', // New Year's Day
  '2026-01-19', // MLK Day
  '2026-02-16', // Presidents Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
];

const US_HOLIDAYS_2027 = [
  '2027-01-01', // New Year's Day
  '2027-01-18', // MLK Day
  '2027-02-15', // Presidents Day
  '2027-03-26', // Good Friday
  '2027-05-31', // Memorial Day
  '2027-06-18', // Juneteenth (observed, Jun 19 = Sat)
  '2027-07-05', // Independence Day (observed, Jul 4 = Sun)
  '2027-09-06', // Labor Day
  '2027-11-25', // Thanksgiving
  '2027-12-24', // Christmas (observed, Dec 25 = Sat)
];

const US_HOLIDAYS_2028 = [
  // No New Year's Day closure: Jan 1, 2028 is a Saturday and NYSE does not observe it on Dec 31.
  '2028-01-17', // MLK Day
  '2028-02-21', // Presidents Day
  '2028-04-14', // Good Friday
  '2028-05-29', // Memorial Day
  '2028-06-19', // Juneteenth
  '2028-07-04', // Independence Day
  '2028-09-04', // Labor Day
  '2028-11-23', // Thanksgiving
  '2028-12-25', // Christmas
];

// Early close at 1pm ET
const US_EARLY_CLOSE_2025 = [
  '2025-07-03', // Independence Day observed
  '2025-11-28', // Day after Thanksgiving
  '2025-12-24', // Christmas Eve
];

const US_EARLY_CLOSE_2026 = [
  '2026-11-27', // Day after Thanksgiving
  '2026-12-24', // Christmas Eve
];

// 2027: no Christmas Eve early close, because Dec 24 is the observed Christmas holiday.
const US_EARLY_CLOSE_2027 = [
  '2027-11-26', // Day after Thanksgiving
];

const US_EARLY_CLOSE_2028 = [
  '2028-07-03', // Day before Independence Day
  '2028-11-24', // Day after Thanksgiving
];

const UK_HOLIDAYS_2025 = [
  '2025-01-01', // New Year's Day
  '2025-04-18', // Good Friday
  '2025-04-21', // Easter Monday
  '2025-05-05', // Early May Bank Holiday
  '2025-05-26', // Spring Bank Holiday
  '2025-08-25', // Summer Bank Holiday
  '2025-12-25', // Christmas Day
  '2025-12-26', // Boxing Day
];

const UK_HOLIDAYS_2026 = [
  '2026-01-01', // New Year's Day
  '2026-04-03', // Good Friday
  '2026-04-06', // Easter Monday
  '2026-05-04', // Early May Bank Holiday
  '2026-05-25', // Spring Bank Holiday
  '2026-08-31', // Summer Bank Holiday
  '2026-12-25', // Christmas Day
  '2026-12-28', // Boxing Day (observed)
];

const FOREX_CLOSED_DATES = [
  '2025-12-25', // Christmas Day
  '2026-01-01', // New Year's Day
  '2026-12-25', // Christmas Day
];

const FOREX_REDUCED_LIQUIDITY = [
  '2025-12-24', '2025-12-26', '2025-12-31',
  '2026-01-02', '2026-12-24', '2026-12-26', '2026-12-31',
];

// CME metals (Gold, Silver etc.) have a DIFFERENT holiday schedule than US stocks.
// They trade on most US holidays (Presidents Day, MLK Day, Columbus Day, Veterans Day, etc.)
// They only close for: Christmas, New Year's Day, Good Friday, Thanksgiving (+ early close days)
const CME_COMMODITY_HOLIDAYS_2025 = [
  '2025-01-01', // New Year's Day
  '2025-04-18', // Good Friday
  '2025-11-27', // Thanksgiving
  '2025-12-25', // Christmas
];

const CME_COMMODITY_HOLIDAYS_2026 = [
  '2026-01-01', // New Year's Day
  '2026-04-03', // Good Friday
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
];

const COMMODITY_EARLY_CLOSE = [
  '2025-12-24', '2025-12-31', '2025-11-28',
  '2026-12-24', '2026-12-31', '2026-11-27',
];


// =============================================================================
// TIME HELPERS
// =============================================================================

/** Format a Date as "YYYY-MM-DD" using local calendar fields. */
const getDateString = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Get current time in US Eastern (ET), correctly handling EDT/EST.
 *
 * ET = UTC-5 (EST) or UTC-4 (EDT). Since 2007 the US has used a fixed DST rule:
 *   - EDT begins:  2nd Sunday of March,    2:00 local (= 07:00 UTC)
 *   - EDT ends:    1st Sunday of November, 2:00 local (= 06:00 UTC)
 * This rule is stable, US-federal, and applies to every IANA "America/New_York"
 * date. We compute it from the UTC year + a Sakamoto-style day-of-week walk,
 * yielding the offset in ~1µs of integer arithmetic.
 *
 * The Intl.DateTimeFormat path used previously is correct but ~100µs (V8) to
 * ~300µs (JavaScriptCore) per call because it goes into ICU. Filtering 10k
 * candles called this twice per row = the iPhone 3-second freeze. The
 * arithmetic version is ~100x faster and behaviourally identical for any
 * date in the modern DST era.
 *
 * Returns { day (0=Sun..6=Sat), hour (0-23), minute (0-59), timeInMinutes }.
 */

// UTC ms at which EDT begins / ends in a given year. Expressed as the moment
// the wall clock changes (= the spring-forward / fall-back instant in UTC).
const getEDTBoundsUtcMs = (year: number): { start: number; end: number } => {
  // 2nd Sunday of March: find day-of-week of March 1 and walk to the 2nd Sunday.
  const march1Dow = new Date(Date.UTC(year, 2, 1)).getUTCDay(); // 0=Sun..6=Sat
  const march2ndSunDay = 1 + ((7 - march1Dow) % 7) + 7; // day-of-month
  // 2:00 local = 07:00 UTC (still EST at that instant).
  const start = Date.UTC(year, 2, march2ndSunDay, 7, 0, 0, 0);

  // 1st Sunday of November.
  const nov1Dow = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const nov1stSunDay = 1 + ((7 - nov1Dow) % 7);
  // 2:00 local = 06:00 UTC (still EDT at that instant).
  const end = Date.UTC(year, 10, nov1stSunDay, 6, 0, 0, 0);
  return { start, end };
};

const getETOffsetHours = (utcMs: number): -4 | -5 => {
  // Use UTC year: DST boundaries are defined relative to the UTC instant.
  const year = new Date(utcMs).getUTCFullYear();
  const { start, end } = getEDTBoundsUtcMs(year);
  return utcMs >= start && utcMs < end ? -4 : -5;
};

const getETTime = (date: Date): { day: number; hour: number; minute: number; timeInMinutes: number } => {
  const utcMs = date.getTime();
  const offsetMs = getETOffsetHours(utcMs) * 3600 * 1000;
  const etMs = utcMs + offsetMs;
  // Read components in UTC-of-shifted-instant; this gives us local ET fields
  // without going through the host timezone or Intl.
  const d = new Date(etMs);
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  const day = d.getUTCDay();
  return { day, hour, minute, timeInMinutes: hour * 60 + minute };
};

/** Get ET date string "YYYY-MM-DD" for holiday lookups. */
const getETDateString = (date: Date): string => {
  const utcMs = date.getTime();
  const offsetMs = getETOffsetHours(utcMs) * 3600 * 1000;
  const d = new Date(utcMs + offsetMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
};

/**
 * Get current time in any IANA timezone. Uses Intl.DateTimeFormat for
 * automatic DST handling. Falls back to UTC if timezone is invalid.
 */
const getTimeInTimezone = (tz: string, now: Date = new Date()): { hours: number; minutes: number; day: number } => {
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: 'numeric', minute: 'numeric', weekday: 'short',
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const hours = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
    const minutes = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
    const dayStr = parts.find(p => p.type === 'weekday')?.value || '';
    const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { hours, minutes, day: dayMap[dayStr] ?? now.getUTCDay() };
  } catch {
    return { hours: now.getUTCHours(), minutes: now.getUTCMinutes(), day: now.getUTCDay() };
  }
};


// =============================================================================
// HOLIDAY CHECK EXPORTS
// =============================================================================

export const isUSHoliday = (date: Date): boolean => {
  const dateStr = getETDateString(date);
  return [...US_HOLIDAYS_2025, ...US_HOLIDAYS_2026, ...US_HOLIDAYS_2027, ...US_HOLIDAYS_2028].includes(dateStr);
};

export const isUSEarlyClose = (date: Date): boolean => {
  const dateStr = getETDateString(date);
  return [...US_EARLY_CLOSE_2025, ...US_EARLY_CLOSE_2026, ...US_EARLY_CLOSE_2027, ...US_EARLY_CLOSE_2028].includes(dateStr);
};

export const isUKHoliday = (date: Date): boolean => {
  // UK holidays checked in London local time (BST/GMT aware)
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/London',
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const dateStr = formatter.format(date);
    return [...UK_HOLIDAYS_2025, ...UK_HOLIDAYS_2026].includes(dateStr);
  } catch {
    return [...UK_HOLIDAYS_2025, ...UK_HOLIDAYS_2026].includes(getDateString(date));
  }
};

export const isForexClosed = (date: Date): boolean => {
  const dateStr = getDateString(date);
  return FOREX_CLOSED_DATES.includes(dateStr);
};

export const isForexReducedLiquidity = (date: Date): boolean => {
  const dateStr = getDateString(date);
  return FOREX_REDUCED_LIQUIDITY.includes(dateStr);
};

export const isCommodityEarlyClose = (date: Date): boolean => {
  const dateStr = getETDateString(date);
  return [...COMMODITY_EARLY_CLOSE].includes(dateStr);
};


// =============================================================================
// MARKET OPEN CHECKS: one function per market type
//
// Each function answers: "Is this market accepting orders right now?"
// All ET-based functions use getETTime() for correct DST handling.
// =============================================================================

/**
 * US stock market (XNYS): 9:30 AM - 4:00 PM ET, weekdays only.
 * Accounts for US holidays and early close days (1:00 PM ET).
 */
export const isUSMarketOpen = (timestamp?: string | number | Date): boolean => {
  const date = timestamp ? new Date(timestamp) : new Date();
  const et = getETTime(date);

  // Weekend: Saturday or Sunday
  if (et.day === 0 || et.day === 6) return false;

  // Holiday check (uses ET date, not UTC date)
  if (isUSHoliday(date)) return false;

  // Regular hours: 9:30 AM - 4:00 PM ET
  const marketOpen = 9 * 60 + 30;  // 570 minutes
  let marketClose = 16 * 60;        // 960 minutes

  // Early close at 1:00 PM ET on specific days
  if (isUSEarlyClose(date)) {
    marketClose = 13 * 60; // 780 minutes
  }

  return et.timeInMinutes >= marketOpen && et.timeInMinutes < marketClose;
};

/**
 * Forex market (XFOREX): Sunday 5:00 PM ET to Friday 5:00 PM ET.
 *
 * This is a nearly 24/5 market. The only closures are:
 * - Weekend: Friday 5pm ET to Sunday 5pm ET
 * - Christmas Day and New Year's Day
 *
 * IMPORTANT: Uses getETTime() for DST-correct ET calculation.
 * The old code hardcoded "Sunday 22:00 UTC" which is only correct during EST.
 * During EDT (March-November), 5pm ET = 21:00 UTC, not 22:00 UTC.
 * Using getETTime() makes this work correctly year-round.
 */
export const isForexMarketOpen = (timestamp?: string | number | Date): boolean => {
  const date = timestamp ? new Date(timestamp) : new Date();

  // Forex closed on Christmas and New Year's Day
  if (isForexClosed(date)) return false;

  const et = getETTime(date);

  // Saturday: always closed (between Friday 5pm close and Sunday 5pm open)
  if (et.day === 6) return false;

  // Sunday: opens at 5:00 PM ET (1020 minutes)
  if (et.day === 0) {
    return et.timeInMinutes >= 17 * 60; // 5:00 PM ET = 1020 min
  }

  // Friday: closes at 5:00 PM ET (1020 minutes)
  if (et.day === 5) {
    return et.timeInMinutes < 17 * 60; // Before 5:00 PM ET
  }

  // Mon-Thu: open all day (no daily maintenance break for forex)
  return true;
};

/**
 * UK stock market (XLON): 8:00 AM - 4:30 PM London time, weekdays only.
 *
 * Uses Intl.DateTimeFormat with "Europe/London" timezone for automatic BST/GMT
 * handling. The old code used raw UTC hours which was wrong during BST (summer)
 * when London is UTC+1 instead of UTC+0.
 */
export const isUKMarketOpen = (timestamp?: string | number | Date): boolean => {
  const date = timestamp ? new Date(timestamp) : new Date();
  const london = getTimeInTimezone('Europe/London', date);

  // Weekend
  if (london.day === 0 || london.day === 6) return false;

  // UK Holiday check
  if (isUKHoliday(date)) return false;

  // LSE hours: 8:00 AM - 4:30 PM London time (BST or GMT, handled by Intl)
  const timeInMinutes = london.hours * 60 + london.minutes;
  return timeInMinutes >= 8 * 60 && timeInMinutes < 16 * 60 + 30;
};

/**
 * CME Globex commodities and indices (XOANDA): Sun 6pm ET - Fri 5pm ET.
 * Daily maintenance break 5:00 PM - 6:00 PM ET (Mon-Thu).
 *
 * Used for gold, silver, oil, natural gas, and all index CFDs.
 * CME has its OWN holiday schedule (trades on Presidents Day, MLK Day, etc.).
 */
export const isCommodityMarketOpen = (timestamp?: string | number | Date): boolean => {
  const date = timestamp ? new Date(timestamp) : new Date();

  // CME commodity holiday check (different from US stock holidays)
  const dateStr = getETDateString(date);
  const isCMEHoliday = [...CME_COMMODITY_HOLIDAYS_2025, ...CME_COMMODITY_HOLIDAYS_2026].includes(dateStr);
  if (isCMEHoliday) return false;

  const et = getETTime(date);

  // Saturday: always closed
  if (et.day === 6) return false;

  // Sunday: opens at 6:00 PM ET
  if (et.day === 0) {
    return et.timeInMinutes >= 18 * 60; // 6:00 PM ET = 1080 min
  }

  // Friday: closes at 5:00 PM ET
  if (et.day === 5) {
    if (isCommodityEarlyClose(date)) {
      return et.timeInMinutes < 13 * 60 + 45; // Early close at 1:45 PM ET
    }
    return et.timeInMinutes < 17 * 60; // 5:00 PM ET = 1020 min
  }

  // Mon-Thu: Daily maintenance break 5:00 PM - 6:00 PM ET
  if (et.timeInMinutes >= 17 * 60 && et.timeInMinutes < 18 * 60) {
    return false;
  }

  return true;
};

/** Crypto (XCRYPTO): always open, 24/7/365. */
export const isCryptoMarketOpen = (): boolean => true;


// =============================================================================
// EXCHANGE INFO: used by ProChart session info popover
// =============================================================================

export interface ExchangeInfo {
  exchange: string;       // e.g. "London Stock Exchange", "NYSE"
  timezone: string;       // IANA timezone e.g. "Europe/London", "America/New_York"
  tzLabel: string;        // display label e.g. "GMT/BST", "ET"
  openHour: number;       // local open hour
  openMinute: number;     // local open minute
  closeHour: number;      // local close hour
  closeMinute: number;    // local close minute
  lunchBreak?: { startHour: number; startMinute: number; endHour: number; endMinute: number };
  is24h?: boolean;
}

/**
 * MIC-to-exchange-ID mapping. Maps catalog MIC codes to the internal exchange IDs
 * used by getExchangeInfo(). This is how MIC drives exchange-specific hours.
 *
 * XNYS and XFOREX/XCRYPTO/XOANDA are handled separately (they have dedicated
 * market open functions), so they're not in this map.
 */
const MIC_TO_EXCHANGE_ID: Record<string, string> = {
  XLON: 'london',
  XASX: 'sydney',
  XBOM: 'india',
  XHKG: 'hongkong',
  XKRX: 'seoul',
  XTAI: 'taiwan',
  XTKS: 'tokyo',
};

/**
 * Detect exchange from symbol suffix. Used as a FALLBACK when MIC data
 * is not available. When MIC is available, use MIC_TO_EXCHANGE_ID instead.
 */
export const getExchangeFromSymbol = (symbol: string): string | null => {
  const upper = symbol.toUpperCase().replace('/', '');
  if (upper.endsWith('_L') || upper.endsWith('.L')) return 'london';
  if (upper.endsWith('_PA') || upper.endsWith('.PA')) return 'euronext';
  if (upper.endsWith('_DE') || upper.endsWith('.DE')) return 'euronext';
  if (upper.endsWith('_MI') || upper.endsWith('.MI')) return 'euronext';
  if (upper.endsWith('_AS') || upper.endsWith('.AS')) return 'euronext';
  if (upper.endsWith('_BR') || upper.endsWith('.BR')) return 'euronext';
  if (upper.endsWith('_MC') || upper.endsWith('.MC')) return 'euronext';
  if (upper.endsWith('_SW') || upper.endsWith('.SW')) return 'zurich';
  if (upper.endsWith('_ST') || upper.endsWith('.ST')) return 'nordic';
  if (upper.endsWith('_HE') || upper.endsWith('.HE')) return 'nordic';
  if (upper.endsWith('_CO') || upper.endsWith('.CO')) return 'nordic';
  if (upper.endsWith('_OL') || upper.endsWith('.OL')) return 'oslo';
  if (upper.endsWith('_TO') || upper.endsWith('.TO')) return 'toronto';
  if (upper.endsWith('_AX') || upper.endsWith('.AX')) return 'sydney';
  if (upper.endsWith('_NS') || upper.endsWith('.NS')) return 'india';
  if (/\d+[_.]HK$/i.test(upper) || upper.endsWith('_HK') || upper.endsWith('.HK')) return 'hongkong';
  if (/\d+[_.]KS$/i.test(upper) || upper.endsWith('_KS') || upper.endsWith('.KS')) return 'seoul';
  if (/\d+[_.]TW$/i.test(upper) || upper.endsWith('_TW') || upper.endsWith('.TW')) return 'taiwan';
  if (/\d+[_.]T$/i.test(upper) || (upper.endsWith('_T') && /\d/.test(upper[0]))) return 'tokyo';
  return null;
};

/** Get exchange info for session popover. All hours are in LOCAL exchange time. */
export const getExchangeInfo = (exchangeId: string): ExchangeInfo => {
  switch (exchangeId) {
    case 'london':
      return { exchange: 'London Stock Exchange', timezone: 'Europe/London', tzLabel: 'GMT/BST', openHour: 8, openMinute: 0, closeHour: 16, closeMinute: 30 };
    case 'euronext':
      return { exchange: 'Euronext', timezone: 'Europe/Paris', tzLabel: 'CET/CEST', openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 30 };
    case 'zurich':
      return { exchange: 'SIX Swiss Exchange', timezone: 'Europe/Zurich', tzLabel: 'CET/CEST', openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 30 };
    case 'nordic':
      return { exchange: 'Nasdaq Nordic', timezone: 'Europe/Stockholm', tzLabel: 'CET/CEST', openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 25 };
    case 'oslo':
      return { exchange: 'Oslo Bors', timezone: 'Europe/Oslo', tzLabel: 'CET/CEST', openHour: 9, openMinute: 0, closeHour: 16, closeMinute: 20 };
    case 'toronto':
      return { exchange: 'Toronto Stock Exchange', timezone: 'America/Toronto', tzLabel: 'ET', openHour: 9, openMinute: 30, closeHour: 16, closeMinute: 0 };
    case 'sydney':
      return { exchange: 'ASX', timezone: 'Australia/Sydney', tzLabel: 'AEST/AEDT', openHour: 10, openMinute: 0, closeHour: 16, closeMinute: 0 };
    case 'hongkong':
      return { exchange: 'HKEX', timezone: 'Asia/Hong_Kong', tzLabel: 'HKT', openHour: 9, openMinute: 30, closeHour: 16, closeMinute: 0, lunchBreak: { startHour: 12, startMinute: 0, endHour: 13, endMinute: 0 } };
    case 'seoul':
      return { exchange: 'Korea Exchange', timezone: 'Asia/Seoul', tzLabel: 'KST', openHour: 9, openMinute: 0, closeHour: 15, closeMinute: 30 };
    case 'taiwan':
      return { exchange: 'TWSE', timezone: 'Asia/Taipei', tzLabel: 'CST', openHour: 9, openMinute: 0, closeHour: 13, closeMinute: 30 };
    case 'tokyo':
      return { exchange: 'Tokyo Stock Exchange', timezone: 'Asia/Tokyo', tzLabel: 'JST', openHour: 9, openMinute: 0, closeHour: 15, closeMinute: 0, lunchBreak: { startHour: 11, startMinute: 30, endHour: 12, endMinute: 30 } };
    case 'india':
      return { exchange: 'NSE India', timezone: 'Asia/Kolkata', tzLabel: 'IST', openHour: 9, openMinute: 15, closeHour: 15, closeMinute: 30 };
    default:
      // Default to US market hours
      return { exchange: 'NYSE/NASDAQ', timezone: 'America/New_York', tzLabel: 'ET', openHour: 9, openMinute: 30, closeHour: 16, closeMinute: 0 };
  }
};

/**
 * Check if an international exchange is open, given an exchange ID.
 * Uses Intl.DateTimeFormat with the exchange's IANA timezone for DST-correct
 * local time. Handles lunch breaks (Hong Kong, Tokyo).
 */
export const isIntlExchangeOpen = (exchangeId: string, timestamp?: string | number | Date): boolean => {
  const now = timestamp ? new Date(timestamp) : new Date();
  const info = getExchangeInfo(exchangeId);
  const t = getTimeInTimezone(info.timezone, now);

  // Weekend
  if (t.day === 0 || t.day === 6) return false;

  const timeInMin = t.hours * 60 + t.minutes;
  const openMin = info.openHour * 60 + info.openMinute;
  const closeMin = info.closeHour * 60 + info.closeMinute;

  if (timeInMin < openMin || timeInMin >= closeMin) return false;

  // Lunch break check (Hong Kong 12-1pm, Tokyo 11:30am-12:30pm)
  if (info.lunchBreak) {
    const lunchStart = info.lunchBreak.startHour * 60 + info.lunchBreak.startMinute;
    const lunchEnd = info.lunchBreak.endHour * 60 + info.lunchBreak.endMinute;
    if (timeInMin >= lunchStart && timeInMin < lunchEnd) return false;
  }

  return true;
};

/** Get UK time for display (session popover shows London time). */
export const getUKTime = (now: Date = new Date()): { hours: number; minutes: number; day: number; isBST: boolean; label: string } => {
  const t = getTimeInTimezone('Europe/London', now);
  // Detect BST: if London time differs from UTC, it's BST (UTC+1)
  const utcH = now.getUTCHours();
  const isBST = t.hours !== utcH || (t.hours === utcH && t.minutes !== now.getUTCMinutes());
  return { ...t, isBST, label: isBST ? 'BST' : 'GMT' };
};


// =============================================================================
// ASSET TYPE CLASSIFICATION
//
// getAssetType() is the FALLBACK classifier. It uses regex patterns on the
// symbol string to guess the asset type. This runs when catalog MIC data is not
// available (e.g. before the API responds on first page load).
//
// When MIC data IS available, isMarketOpenForPair() skips this entirely and
// uses the MIC directly.
// =============================================================================

export const getAssetType = (pair: string): 'crypto' | 'commodity' | 'forex' | 'stock' | 'index' => {
  // If MIC data is loaded, use it instead of regex guessing
  const micInfo = getMicInfo(pair);
  if (micInfo) {
    // Map catalog categories to the asset types this function returns.
    // The catalog has: crypto, forex, commodity, index, stock, etf
    // etf maps to 'stock' since ETFs follow the same market hours as stocks.
    const cat = micInfo.category;
    if (cat === 'etf') return 'stock';
    if (cat === 'crypto' || cat === 'forex' || cat === 'commodity' || cat === 'index' || cat === 'stock') {
      return cat;
    }
  }

  // FALLBACK: regex-based classification for when the catalog hasn't loaded
  const upper = pair.toUpperCase().replace('/', '');

  // Crypto tokens
  if (/BTC|ETH|SOL|ADA|XRP|DOGE|BNB|XMR|AVAX|DOT|LINK|MATIC|SHIB|LTC|UNI|ATOM|NEAR|APT|OP|ARB|SUI/i.test(upper)) {
    return 'crypto';
  }

  // Commodities (gold, silver, oil, etc.)
  if (/^(XAU|XAG|GOLD|SILVER|XAUUSD|XAGUSD|XAUEUR|XAGEUR|WTIUSD|BCOUSD|NATGAS|NGAS|OIL|CL|GC|SI|HG|PL|PA)/.test(upper)) {
    return 'commodity';
  }

  // Major indices
  if (/^(US30|US500|US100|SPX|NAS|DJI|USTEC|US2000|VIX|DAX|FTSE|CAC|NIKKEI|HANG|ASX)/.test(upper)) {
    return 'index';
  }

  // Forex pairs (two 3-letter currency codes)
  const forexQuotes = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'NZD', 'NOK', 'SEK', 'DKK', 'SGD', 'HKD', 'CNH', 'ZAR', 'MXN', 'BRL', 'TRY', 'PLN', 'CZK', 'HUF', 'ILS', 'INR', 'THB', 'PHP', 'KRW', 'TWD', 'CLP', 'COP', 'PEN'];
  const forexBases = ['EUR', 'GBP', 'AUD', 'NZD', 'USD', 'CAD', 'CHF', 'JPY', 'NOK', 'SEK', 'DKK', 'SGD', 'HKD', 'CNH', 'ZAR', 'MXN', 'BRL', 'TRY'];

  for (const quote of forexQuotes) {
    if (upper.endsWith(quote)) {
      const base = upper.slice(0, -quote.length);
      if (forexBases.includes(base) && base.length >= 3) {
        return 'forex';
      }
    }
  }

  // Default: treat as stock
  return 'stock';
};


// =============================================================================
// isMarketOpenForPair: THE main entry point
//
// This is the function everything calls. It determines if the market is open
// for any given symbol.
//
// RESOLUTION ORDER:
//   1. Check MIC map (populated from the catalog). If found, use MIC to pick
//      which market hours function to call. This is the authoritative path.
//   2. If MIC not found (catalog not loaded yet), fall back to getAssetType()
//      regex classification. This is the legacy path that works on first load.
// =============================================================================

export const isMarketOpenForPair = (pair: string, timestamp?: string | number | Date): boolean => {
  // --- PRIMARY PATH: MIC-driven (from the catalog) ---
  const micInfo = getMicInfo(pair);
  if (micInfo) {
    return isMarketOpenByMic(micInfo.mic, micInfo.category, timestamp);
  }

  // --- FALLBACK PATH: regex-based (before the catalog loads) ---
  const assetType = getAssetType(pair);

  switch (assetType) {
    case 'crypto':
      return true;
    case 'commodity':
      return isCommodityMarketOpen(timestamp);
    case 'forex':
      return isForexMarketOpen(timestamp);
    case 'stock': {
      // Check for international exchange suffix (e.g. .L for London)
      const exchangeId = getExchangeFromSymbol(pair);
      if (exchangeId) {
        return isIntlExchangeOpen(exchangeId, timestamp);
      }
      return isUSMarketOpen(timestamp);
    }
    case 'index':
      return isCommodityMarketOpen(timestamp);
    default:
      return true;
  }
};

/**
 * MIC-driven market open check. This is the clean path used when catalog data
 * is available. Maps MIC codes directly to the correct market hours function.
 *
 * The mapping is:
 *   XCRYPTO -> always open
 *   XFOREX  -> isForexMarketOpen (Sun 5pm ET - Fri 5pm ET)
 *   XOANDA  -> isCommodityMarketOpen (CME Globex hours, for both commodities and indices)
 *   XNYS    -> isUSMarketOpen (9:30am-4pm ET, for both stocks and ETFs)
 *   XLON, XASX, XBOM, XHKG, XKRX, XTAI, XTKS -> isIntlExchangeOpen with mapped exchange ID
 */
const isMarketOpenByMic = (mic: string, category: string, timestamp?: string | number | Date): boolean => {
  switch (mic) {
    case 'XCRYPTO':
      return true;

    case 'XFOREX':
      return isForexMarketOpen(timestamp);

    case 'XOANDA':
      // Both CFD commodities (XAU/USD, BCO/USD) and CFD indices (SPX500/USD,
      // NAS100/USD) follow CME Globex hours. The category doesn't matter here
      // because the trading schedule is the same.
      return isCommodityMarketOpen(timestamp);

    case 'XNYS':
      // Both US stocks and ETFs trade on NYSE/NASDAQ with the same hours.
      return isUSMarketOpen(timestamp);

    default: {
      // International exchanges: look up exchange ID from MIC
      const exchangeId = MIC_TO_EXCHANGE_ID[mic];
      if (exchangeId) {
        return isIntlExchangeOpen(exchangeId, timestamp);
      }
      // Unknown MIC: default to open (safe fallback)
      return true;
    }
  }
};


// =============================================================================
// MARKET STATUS INFO: used by ProChart session popover for display text
// =============================================================================

export type MarketStatus = 'open' | 'closed' | 'early_close' | 'reduced_liquidity';

export interface MarketStatusInfo {
  status: MarketStatus;
  message: string;
  nextOpen?: Date;
}

export const getUSMarketStatus = (date: Date = new Date()): MarketStatusInfo => {
  if (isUSHoliday(date)) {
    return { status: 'closed', message: 'Holiday - Market Closed' };
  }

  if (isUSEarlyClose(date)) {
    if (isUSMarketOpen(date)) {
      return { status: 'early_close', message: 'Early Close Today (1:00 PM ET)' };
    }
    return { status: 'closed', message: 'Market Closed (Early Close Day)' };
  }

  if (isUSMarketOpen(date)) {
    return { status: 'open', message: 'Market Open' };
  }

  return { status: 'closed', message: 'Market Closed' };
};

export const getForexMarketStatus = (date: Date = new Date()): MarketStatusInfo => {
  if (isForexClosed(date)) {
    return { status: 'closed', message: 'Holiday - Forex Closed' };
  }

  if (isForexReducedLiquidity(date)) {
    if (isForexMarketOpen(date)) {
      return { status: 'reduced_liquidity', message: 'Reduced Liquidity' };
    }
    return { status: 'closed', message: 'Forex Closed' };
  }

  if (isForexMarketOpen(date)) {
    return { status: 'open', message: 'Forex Open' };
  }

  return { status: 'closed', message: 'Forex Closed' };
};
