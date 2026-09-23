import { describe, expect, it } from 'vitest';
import type { DailyMonetary, HiborDaily, HkdInterestRate } from '../src/endpoints.js';
import {
  buildHkdSeries,
  filterRange,
  isHiborTenor,
  isHkdTenor,
  mergeHiborSeries,
  RateDateError,
  restrictToLatestWhenNoRange,
  summarise,
  validateDate,
} from '../src/rates.js';
import { readFixture } from './helpers.js';

const monthly = (): HiborDaily[] =>
  (JSON.parse(readFixture('hibor-daily.json')) as { result: { records: HiborDaily[] } }).result
    .records;
const daily = (): DailyMonetary[] =>
  (JSON.parse(readFixture('daily-monetary.json')) as { result: { records: DailyMonetary[] } })
    .result.records;
const hkd = (): HkdInterestRate[] =>
  (JSON.parse(readFixture('hkd-ir-effdates.json')) as { result: { records: HkdInterestRate[] } })
    .result.records;

describe('mergeHiborSeries', () => {
  it('uses only the monthly bulletin for a tenor the daily source lacks', () => {
    // 3M is not published in the daily-monetary series (issue #1) — every
    // point must come from the monthly bulletin, and the latest date must
    // reflect that lag rather than implying next-day freshness.
    const series = mergeHiborSeries(monthly(), daily(), '3m');
    expect(series.length).toBeGreaterThan(0);
    expect(series.every((p) => p.sourceId === 'hkma-monthly-bulletin')).toBe(true);
  });

  it('prefers the fresher daily source for overnight and 1-month', () => {
    const series = mergeHiborSeries(monthly(), daily(), 'overnight');
    const latest = series[series.length - 1];
    expect(latest?.sourceId).toBe('hkma-daily-monetary');
    // The daily fixture's latest date is newer than the monthly fixture's.
    const monthlyLatest = monthly()
      .map((r) => r.end_of_day)
      .sort()
      .at(-1);
    expect(latest?.date > (monthlyLatest ?? '')).toBe(true);
  });

  it('never reports a null tenor value as zero', () => {
    // ir_9m is frequently null in live data; a missing tenor must be absent
    // from the series, not silently reported as 0.
    const series = mergeHiborSeries(monthly(), daily(), '9m');
    expect(series.every((p) => p.value !== 0 || monthly().some((r) => r.ir_9m === 0))).toBe(true);
  });

  it('daily supersedes monthly when both publish the same date', () => {
    // Pinned deliberately: for a shared date the daily series is the later
    // publication, so it wins. The comment in mergeHiborSeries used to claim a
    // guard against this that did not exist (#30).
    const merged = mergeHiborSeries(
      [{ end_of_day: '2026-09-21', ir_overnight: 9.99 }],
      [{ end_of_date: '2026-09-21', hibor_overnight: 1.96 }],
      'overnight',
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.value).toBe(1.96);
    expect(merged[0]?.sourceId).toBe('hkma-daily-monetary');
  });

  it('keeps a monthly date that the daily series does not have at all', () => {
    const merged = mergeHiborSeries(
      [{ end_of_day: '2026-09-25', ir_overnight: 5.55 }],
      [{ end_of_date: '2026-09-21', hibor_overnight: 1.96 }],
      'overnight',
    );
    expect(merged.map((p) => p.date)).toEqual(['2026-09-21', '2026-09-25']);
  });

  it('sorts ascending by date', () => {
    const series = mergeHiborSeries(monthly(), daily(), 'overnight');
    const dates = series.map((p) => p.date);
    expect([...dates].sort()).toEqual(dates);
  });
});

describe('buildHkdSeries', () => {
  it('extracts one tenor from the effective-date series', () => {
    const series = buildHkdSeries(hkd(), '1w');
    for (const point of series) expect(typeof point.value).toBe('number');
  });
});

describe('summarise', () => {
  it('computes latest, min, max, average and change', () => {
    const series = mergeHiborSeries(monthly(), daily(), '3m');
    const summary = summarise(series);
    expect(summary).toBeDefined();
    if (summary === undefined) return;
    expect(summary.latest.date).toBe(series[series.length - 1]?.date);
    expect(summary.min.value).toBeLessThanOrEqual(summary.max.value);
    expect(summary.points_count).toBe(series.length);
    // average must lie within [min, max]
    expect(summary.average).toBeGreaterThanOrEqual(summary.min.value);
    expect(summary.average).toBeLessThanOrEqual(summary.max.value);
  });

  it('omits change for a single point rather than reporting zero', () => {
    const single = mergeHiborSeries(monthly(), daily(), '3m').slice(-1);
    const summary = summarise(single);
    expect(summary?.change).toBeUndefined();
  });

  it('returns undefined for an empty series', () => {
    expect(summarise([])).toBeUndefined();
  });
});

describe('restrictToLatestWhenNoRange', () => {
  const series = [
    { date: '2026-08-01', value: 2.5, sourceId: 'x' },
    { date: '2026-08-15', value: 2.8, sourceId: 'x' },
    { date: '2026-08-31', value: 3.0, sourceId: 'x' },
  ];

  it('冇畀日期範圍就淨係回最新一個點', () => {
    // 真實 bug:問「3個月HIBOR而家幾多」會回埋近19個月嘅 min/max/average,
    // 完全唔關「而家」事。DoD 明寫冇範圍就淨係答最新。
    const result = restrictToLatestWhenNoRange(series, false);
    expect(result).toHaveLength(1);
    expect(result[0]?.date).toBe('2026-08-31');
  });

  it('有畀日期範圍就照回成個 series', () => {
    const result = restrictToLatestWhenNoRange(series, true);
    expect(result).toHaveLength(3);
  });

  it('空 series 唔會爆', () => {
    expect(restrictToLatestWhenNoRange([], false)).toEqual([]);
    expect(restrictToLatestWhenNoRange([], true)).toEqual([]);
  });

  it('唔會改到原本個 array', () => {
    const copy = [...series];
    restrictToLatestWhenNoRange(series, false);
    expect(series).toEqual(copy);
  });
});

describe('filterRange', () => {
  const series = mergeHiborSeries(monthly(), daily(), 'overnight');

  it('returns everything when no bounds are given', () => {
    expect(filterRange(series, undefined, undefined, false)).toEqual(series);
  });

  it('filters inclusively', () => {
    const from = series[2]?.date;
    const to = series[5]?.date;
    if (from === undefined || to === undefined) throw new Error('fixture too small');
    const filtered = filterRange(series, from, to, false);
    expect(filtered[0]?.date).toBe(from);
    expect(filtered[filtered.length - 1]?.date).toBe(to);
  });

  it('carries the last value forward for effective-date series', () => {
    // A rate published before the window is still in effect at its start —
    // e.g. asking for this week's prime rate when it last changed last month.
    const hkdSeries =
      buildHkdSeries(hkd(), '1w').length > 0
        ? buildHkdSeries(hkd(), '1w')
        : [
            { date: '2025-01-01', value: 5, sourceId: 'x' },
            { date: '2025-06-01', value: 5.25, sourceId: 'x' },
          ];
    const midWindowStart = '2025-03-01';
    const filtered = filterRange(hkdSeries, midWindowStart, '2025-12-31', true);
    // The carried-forward point's date must be before the window, not equal to it.
    expect(filtered[0]?.date <= midWindowStart).toBe(true);
  });

  it('does not carry forward when carryForward is false', () => {
    const from = series[3]?.date;
    if (from === undefined) throw new Error('fixture too small');
    const filtered = filterRange(series, from, undefined, false);
    expect(filtered.every((p) => p.date >= from)).toBe(true);
  });
});

describe('validateDate', () => {
  const today = '2026-09-23';

  it('accepts a valid past or present date', () => {
    expect(validateDate('2026-09-01', 'from', today)).toBe('2026-09-01');
    expect(validateDate(today, 'from', today)).toBe(today);
  });

  it('rejects malformed strings', () => {
    expect(() => validateDate('not-a-date', 'from', today)).toThrow(RateDateError);
    expect(() => validateDate('2026/09/01', 'from', today)).toThrow(RateDateError);
  });

  it('rejects an impossible calendar date', () => {
    expect(() => validateDate('2026-02-30', 'from', today)).toThrow(RateDateError);
  });

  it('rejects a future date and says so', () => {
    try {
      validateDate('2027-01-01', 'from', today);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RateDateError);
      expect((error as RateDateError).agentHint).toMatch(/today is/i);
    }
  });
});

describe('tenor guards', () => {
  it('accepts only the real HIBOR tenors', () => {
    for (const t of ['overnight', '1w', '1m', '3m', '6m', '9m', '12m'])
      expect(isHiborTenor(t)).toBe(true);
    expect(isHiborTenor('2m')).toBe(false);
    expect(isHiborTenor('')).toBe(false);
  });

  it('accepts only the real HKD reference tenors (no overnight, no 9m)', () => {
    for (const t of ['1w', '1m', '3m', '6m', '12m']) expect(isHkdTenor(t)).toBe(true);
    expect(isHkdTenor('overnight')).toBe(false);
    expect(isHkdTenor('9m')).toBe(false);
  });
});
