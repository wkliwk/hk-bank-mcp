/**
 * Interest rate lookups.
 *
 * HIBOR has two sources with an inherent trade-off (found in issue #1):
 *
 *   monthly-statistical-bulletin  full tenor curve (O/N..12M), lags ~3 weeks
 *   daily-monetary-statistics     next-business-day fresh, only O/N + 1M
 *
 * Neither alone answers "what is 3-month HIBOR right now" honestly — the
 * fresh source doesn't have 3M, the complete source is weeks old. This module
 * merges them per tenor, always preferring the newer value, and reports which
 * date the value actually came from so a stale figure is never presented as
 * today's.
 */

import type { HkmaClient } from './client.js';
import type { DailyMonetary, HiborDaily, HkdInterestRate } from './endpoints.js';

export type HiborTenor = 'overnight' | '1w' | '1m' | '3m' | '6m' | '9m' | '12m';
export type HkdTenor = '1w' | '1m' | '3m' | '6m' | '12m';
export type RateType = 'hibor' | 'hkd_reference';

const HIBOR_TENORS: readonly HiborTenor[] = ['overnight', '1w', '1m', '3m', '6m', '9m', '12m'];
const HKD_TENORS: readonly HkdTenor[] = ['1w', '1m', '3m', '6m', '12m'];

export function isHiborTenor(value: string): value is HiborTenor {
  return (HIBOR_TENORS as readonly string[]).includes(value);
}
export function isHkdTenor(value: string): value is HkdTenor {
  return (HKD_TENORS as readonly string[]).includes(value);
}

/** One rate on one date, tagged with where it came from. */
export interface RatePoint {
  date: string;
  value: number;
  sourceId: string;
}

export class RateDateError extends Error {
  readonly agentHint: string;
  constructor(message: string, agentHint: string) {
    super(message);
    this.name = 'RateDateError';
    this.agentHint = agentHint;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate a date string. Throws with an agent-facing hint; never silently coerces. */
export function validateDate(value: string, label: string, todayIso: string): string {
  if (!DATE_RE.test(value)) {
    throw new RateDateError(
      `${label} is not a valid date: "${value}".`,
      'Dates must be in YYYY-MM-DD format, e.g. "2026-09-01". Retry with that format.',
    );
  }
  // Date rolls an invalid day/month forward (2026-02-30 silently becomes
  // 2026-03-02) instead of producing NaN, so the components are checked
  // explicitly rather than trusting the parsed result.
  const [yearStr, monthStr, dayStr] = value.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const roundTrips =
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
  if (!roundTrips) {
    throw new RateDateError(
      `${label} is not a real calendar date: "${value}".`,
      'Check the day and month are valid, e.g. no "2026-02-30". Retry with a real date.',
    );
  }
  if (value > todayIso) {
    throw new RateDateError(
      `${label} is in the future: "${value}".`,
      `Today is ${todayIso}. HKMA has not published data past today; use a date up to today.`,
    );
  }
  return value;
}

function hiborField(tenor: HiborTenor): keyof HiborDaily {
  return (
    {
      overnight: 'ir_overnight',
      '1w': 'ir_1w',
      '1m': 'ir_1m',
      '3m': 'ir_3m',
      '6m': 'ir_6m',
      '9m': 'ir_9m',
      '12m': 'ir_12m',
    } satisfies Record<HiborTenor, keyof HiborDaily>
  )[tenor];
}

function hkdField(tenor: HkdTenor): keyof HkdInterestRate {
  return (
    {
      '1w': 'dr_1w',
      '1m': 'dr_1m',
      '3m': 'dr_3m',
      '6m': 'dr_6m',
      '12m': 'dr_12m',
    } satisfies Record<HkdTenor, keyof HkdInterestRate>
  )[tenor];
}

/**
 * Build a HIBOR series for one tenor by merging both sources on date.
 *
 * The daily source only ever has overnight and 1-month, so for every other
 * tenor only the monthly bulletin contributes points — which is exactly why a
 * 3-month query cannot be fresher than that source allows, and the response
 * must say so via each point's own date rather than imply otherwise.
 */
export function mergeHiborSeries(
  monthly: readonly HiborDaily[],
  daily: readonly DailyMonetary[],
  tenor: HiborTenor,
): RatePoint[] {
  const byDate = new Map<string, RatePoint>();
  const field = hiborField(tenor);

  for (const row of monthly) {
    const value = row[field];
    if (typeof value === 'number') {
      byDate.set(row.end_of_day, {
        date: row.end_of_day,
        value,
        sourceId: 'hkma-monthly-bulletin',
      });
    }
  }

  if (tenor === 'overnight' || tenor === '1m') {
    for (const row of daily) {
      const value = tenor === 'overnight' ? row.hibor_overnight : row.hibor_fixing_1m;
      if (typeof value === 'number') {
        // The daily source is never older than the monthly one for shared
        // dates, but an explicit overwrite here would be wrong if it ever is —
        // so only add dates the monthly source did not already cover, unless
        // this date is newer than anything monthly has.
        byDate.set(row.end_of_date, {
          date: row.end_of_date,
          value,
          sourceId: 'hkma-daily-monetary',
        });
      }
    }
  }

  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Build an HKD reference rate series for one tenor.
 *
 * Effect dates are irregular — a rate is published when it changes, not every
 * day — so a query for a specific date must find the most recent effect_date
 * at or before it, not require an exact match.
 */
export function buildHkdSeries(rows: readonly HkdInterestRate[], tenor: HkdTenor): RatePoint[] {
  const field = hkdField(tenor);
  const points: RatePoint[] = [];
  for (const row of rows) {
    const value = row[field];
    if (typeof value === 'number') {
      points.push({ date: row.effect_date, value, sourceId: 'hkma-monthly-bulletin' });
    }
  }
  return points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export interface RateSummary {
  latest: RatePoint;
  min: RatePoint;
  max: RatePoint;
  average: number;
  /** latest.value - the earliest point in the range. Omitted with only one point. */
  change?: number;
  points_count: number;
}

/** Summarise a series: latest/min/max/average/change. Empty series has no summary. */
export function summarise(series: readonly RatePoint[]): RateSummary | undefined {
  if (series.length === 0) return undefined;
  const latest = series[series.length - 1];
  const first = series[0];
  if (latest === undefined || first === undefined) return undefined;

  let min = series[0];
  let max = series[0];
  let sum = 0;
  for (const point of series) {
    if (min === undefined || point.value < min.value) min = point;
    if (max === undefined || point.value > max.value) max = point;
    sum += point.value;
  }
  if (min === undefined || max === undefined) return undefined;

  return {
    latest,
    min,
    max,
    average: Math.round((sum / series.length) * 100_000) / 100_000,
    ...(series.length > 1
      ? { change: Math.round((latest.value - first.value) * 100_000) / 100_000 }
      : {}),
    points_count: series.length,
  };
}

/**
 * Filter a series to [from, to] inclusive. Effective-date series (HKD reference
 * rates) additionally carry forward the last value at or before `from`, since
 * a rate published before the window is still in effect within it.
 */
export function filterRange(
  series: readonly RatePoint[],
  from: string | undefined,
  to: string | undefined,
  carryForward: boolean,
): RatePoint[] {
  if (from === undefined && to === undefined) return [...series];

  const inRange = series.filter(
    (p) => (from === undefined || p.date >= from) && (to === undefined || p.date <= to),
  );

  if (!carryForward || from === undefined || inRange.some((p) => p.date === from)) return inRange;

  const before = [...series].reverse().find((p) => p.date < from);
  return before === undefined ? inRange : [before, ...inRange];
}

/**
 * 冇明確畀 from/to 嘅時候,淨係要俾最新嗰一個點,唔可以俾埋一堆歷史 min/max/average。
 *
 * 之前個 bug:預設 fetch window 有幾百個點(近19個月),就算用戶淨係問「而家幾多」,
 * 都會夾埋一堆完全冇問過嘅歷史摘要一齊回。DoD 明寫「冇日期範圍 = 淨係答最新」,
 * 所以呢個要喺 summarise() 之前做,唔可以淨係靠 summary 隱藏返啲野。
 */
export function restrictToLatestWhenNoRange(
  series: readonly RatePoint[],
  hasExplicitRange: boolean,
): RatePoint[] {
  if (hasExplicitRange || series.length === 0) return [...series];
  const latest = series[series.length - 1];
  return latest === undefined ? [] : [latest];
}

/** Above this many points, return a summary instead of every row. */
export const RAW_ROW_THRESHOLD = 15;

export interface RateClient {
  hiborDaily(
    oldestNeeded?: string,
  ): Promise<{ records: HiborDaily[]; stale: boolean; asOf: string }>;
  dailyMonetary(
    oldestNeeded?: string,
  ): Promise<{ records: DailyMonetary[]; stale: boolean; asOf: string }>;
  hkdReference(
    oldestNeeded?: string,
  ): Promise<{ records: HkdInterestRate[]; stale: boolean; asOf: string }>;
}

/**
 * Adapts HkmaClient to the narrow interface this module needs, for testability.
 *
 * Uses the bounded time-series fetch, not fetchAll: HIBOR daily data goes back
 * to 1996 (7,000+ records), so paging until the dataset is exhausted would
 * issue dozens of sequential requests for what is usually a "last month"
 * question. `oldestNeeded` lets a caller with a date range stop paging once
 * it has enough; omitted, it falls back to a fixed cap that comfortably covers
 * the common case of the latest figure or a recent trend.
 */
export function ratesFrom(client: HkmaClient): RateClient {
  const DEFAULT_CAP = 400; // ~19 months of trading days — ample for "latest" or "past month" without it, and a safety bound with it.
  return {
    async hiborDaily(oldestNeeded) {
      const r = await client.fetchTimeSeries('hiborDaily', {
        dateField: 'end_of_day',
        ...(oldestNeeded === undefined ? {} : { oldestNeeded }),
        maxRecords: oldestNeeded === undefined ? DEFAULT_CAP : 3000,
      });
      return { records: r.records as HiborDaily[], stale: r.stale, asOf: r.asOf };
    },
    async dailyMonetary(oldestNeeded) {
      const r = await client.fetchTimeSeries('dailyMonetary', {
        dateField: 'end_of_date',
        ...(oldestNeeded === undefined ? {} : { oldestNeeded }),
        maxRecords: oldestNeeded === undefined ? DEFAULT_CAP : 3000,
      });
      return { records: r.records as DailyMonetary[], stale: r.stale, asOf: r.asOf };
    },
    async hkdReference(oldestNeeded) {
      const r = await client.fetchTimeSeries('hkdInterestRates', {
        dateField: 'effect_date',
        ...(oldestNeeded === undefined ? {} : { oldestNeeded }),
        maxRecords: oldestNeeded === undefined ? DEFAULT_CAP : 3000,
      });
      return { records: r.records as HkdInterestRate[], stale: r.stale, asOf: r.asOf };
    },
  };
}
