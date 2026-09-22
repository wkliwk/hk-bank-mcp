import { describe, expect, it } from 'vitest';
import type { BankLocation } from '../src/endpoints.js';
import type { TypedRecords } from '../src/locations.js';
import {
  haversineKm,
  LIMIT_MAX,
  LocationQueryError,
  project,
  searchLocations,
  TOO_MANY_THRESHOLD,
} from '../src/locations.js';
import { readFixture } from './helpers.js';

const atmRecords = (name = 'atm-locator-en.json'): BankLocation[] =>
  (JSON.parse(readFixture(name)) as { result: { records: BankLocation[] } }).result.records;

const atmSource = (): TypedRecords[] => [{ type: 'atm', records: atmRecords() }];

describe('searchLocations', () => {
  it('finds locations across every spelling of a district, not just one', () => {
    const records = atmRecords();
    // What a naive `district === "Sha Tin District"` filter would return.
    const naive = records.filter((r) => r.district === 'Sha Tin District').length;
    const found = searchLocations([{ type: 'atm', records }], { place: '沙田' }).total_matches;

    expect(naive).toBeGreaterThan(0);
    expect(found).toBeGreaterThan(naive);
  });

  it('accepts a neighbourhood and reports which district it resolved to', () => {
    const result = searchLocations(atmSource(), { place: '旺角', limit: 1 });
    expect(result.resolved_place).toContain('Yau Tsim Mong');
    expect(result.total_matches).toBeGreaterThan(0);
  });

  it('ranks address matches for a labelled neighbourhood before the rest of its district', () => {
    const records = atmRecords();
    const mongKok = records.find((r) => r.address?.includes('Mongkok'));
    const jordan = records.find((r) => r.address?.includes('Jordan'));
    if (mongKok === undefined || jordan === undefined) throw new Error('fixture missing rows');
    const result = searchLocations([{ type: 'atm', records: [jordan, mongKok] }], {
      districts: ['yau-tsim-mong'],
      placeLabel: '旺角',
      limit: 2,
      lang: 'tc',
    });

    expect(result.results[0]?.address).toContain('Mongkok');
    expect(result.summary).toMatch(/1 in 旺角, 1 elsewhere in 油尖旺區/);
    expect(result.results[0]?.place_match).toBe('label');
    expect(result.results[1]?.place_match).toBe('elsewhere');
  });

  it('merges multiple district ids and reports how many districts were searched', () => {
    const result = searchLocations(atmSource(), {
      districts: ['yau-tsim-mong', 'sham-shui-po'],
      limit: 1,
      lang: 'tc',
    });

    expect(result.total_matches).toBeGreaterThan(0);
    expect(result.searched_districts).toEqual(['yau-tsim-mong', 'sham-shui-po']);
    expect(result.summary).toMatch(/2 districts/);
  });

  it('rejects an empty district id list', () => {
    expect(() => searchLocations(atmSource(), { districts: [] })).toThrow(LocationQueryError);
  });

  it('filters by bank using a short form', () => {
    const result = searchLocations(atmSource(), { bank: '恒生', limit: 50 });
    expect(result.total_matches).toBeGreaterThan(0);
    for (const row of result.results) expect(row.bank).toBe('Hang Seng Bank Limited');
  });

  it('filters by currency', () => {
    const result = searchLocations(atmSource(), { currency: 'RMB', limit: 50, format: 'detailed' });
    for (const row of result.results) expect(row.currencies?.toUpperCase()).toContain('RMB');
  });

  it('sorts by distance and reports it when given a reference point', () => {
    const central = { lat: 22.2819, lon: 114.158 };
    const result = searchLocations(atmSource(), { near: central, limit: 5 });

    const distances = result.results.map((r) => r.distance_km ?? Number.NaN);
    expect(distances.every((d) => Number.isFinite(d))).toBe(true);
    expect([...distances]).toEqual([...distances].sort((a, b) => a - b));
  });

  it('honours a radius', () => {
    const central = { lat: 22.2819, lon: 114.158 };
    const result = searchLocations(atmSource(), { near: central, radiusKm: 1, limit: LIMIT_MAX });
    for (const row of result.results) expect(row.distance_km).toBeLessThanOrEqual(1);
  });

  it('caps limit at the hard maximum however large a value is asked for', () => {
    // Exceeding a client's context is not a degraded response, it ends the
    // conversation — so the ceiling is enforced, not advisory.
    const result = searchLocations(atmSource(), { limit: 99_999, place: '中西區' });
    expect(result.showing).toBeLessThanOrEqual(LIMIT_MAX);
  });

  it('refuses a query that is too broad instead of truncating it silently', () => {
    const many = Array.from({ length: TOO_MANY_THRESHOLD + 50 }, () => atmRecords()[0]).filter(
      (r): r is BankLocation => r !== undefined,
    );
    const result = searchLocations([{ type: 'atm', records: many }], {});

    expect(result.showing).toBe(0);
    expect(result.results).toEqual([]);
    expect(result.total_matches).toBeGreaterThan(TOO_MANY_THRESHOLD);
    // A caller that cannot see it is missing results answers confidently and wrongly.
    expect(result.narrow_hint).toMatch(/place|bank|currency|near/);
  });

  it('always states the total, so the caller knows what it is not seeing', () => {
    const result = searchLocations(atmSource(), { place: '中西區', limit: 2 });
    expect(result.total_matches).toBeGreaterThan(result.showing);
    expect(result.summary).toMatch(/showing the first 2/);
  });

  it('errors with the valid districts when the place is not in Hong Kong', () => {
    const error = (() => {
      try {
        searchLocations(atmSource(), { place: 'Tokyo' });
      } catch (e) {
        return e as LocationQueryError;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(LocationQueryError);
    expect(error?.candidates).toHaveLength(18);
    expect(error?.agentHint).toMatch(/confirm|retry/i);
  });

  it('refuses to guess between banks when the name is ambiguous', () => {
    expect(() => searchLocations(atmSource(), { bank: '中國' })).toThrow(LocationQueryError);
    try {
      searchLocations(atmSource(), { bank: '中國' });
    } catch (e) {
      expect((e as LocationQueryError).agentHint).toMatch(/do not pick one/i);
    }
  });

  it('returns an empty result rather than an error when filters simply match nothing', () => {
    const result = searchLocations(atmSource(), { place: '離島區', bank: '集友', currency: 'JPY' });
    expect(result.total_matches).toBe(0);
    expect(result.summary).toMatch(/No locations/);
  });
});

describe('district ids and neighbourhood ranking', () => {
  it('ranks the named neighbourhood above the rest of its district', () => {
    // Without this, asking about 旺角 answers with Tsim Sha Tsui: both are in
    // Yau Tsim Mong, and the raw order decides what the user is told.
    const result = searchLocations(atmSource(), {
      districts: ['yau-tsim-mong'],
      placeLabel: '旺角',
      limit: 6,
    });
    const isMongKok = (address: string) => /mongkok|mong kok|旺角/i.test(address);
    const flags = result.results.map((r) => isMongKok(r.address));
    const firstFalse = flags.indexOf(false);
    // Every Mong Kok row must come before every non-Mong Kok row.
    if (firstFalse !== -1) expect(flags.slice(firstFalse).some(Boolean)).toBe(false);
    expect(flags[0]).toBe(true);
  });

  it('says how many are in the named place and how many merely in the district', () => {
    const result = searchLocations(atmSource(), {
      districts: ['yau-tsim-mong'],
      placeLabel: '旺角',
      limit: 6,
    });
    expect(result.summary).toMatch(/旺角/);
    expect(result.summary).toMatch(/elsewhere/i);
  });

  it('searches several districts at once for a region', () => {
    const kowloon = ['yau-tsim-mong', 'sham-shui-po', 'kowloon-city', 'wong-tai-sin', 'kwun-tong'];
    const result = searchLocations(atmSource(), { districts: kowloon, placeLabel: '九龍' });
    expect(result.searched_districts).toHaveLength(5);
    expect(result.summary).toMatch(/5 districts/);
  });

  it('rejects an empty district list rather than reading it as everywhere', () => {
    // A caller that means everywhere omits the parameter.
    expect(() => searchLocations(atmSource(), { districts: [] })).toThrow(LocationQueryError);
  });

  it('rejects an unknown district id and lists the valid ones', () => {
    try {
      searchLocations(atmSource(), { districts: ['mars'] });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LocationQueryError);
      expect((error as LocationQueryError).candidates).toHaveLength(18);
    }
  });

  it('treats the label as ranking only, never as a filter', () => {
    // A label the table does not know must not shrink the result set.
    const withLabel = searchLocations(atmSource(), {
      districts: ['yau-tsim-mong'],
      placeLabel: '某個唔存在嘅地方',
    });
    const withoutLabel = searchLocations(atmSource(), { districts: ['yau-tsim-mong'] });
    expect(withLabel.total_matches).toBe(withoutLabel.total_matches);
  });
});

describe('project', () => {
  const sample = (): BankLocation => {
    const record = atmRecords()[0];
    if (record === undefined) throw new Error('fixture empty');
    return record;
  };

  it('drops coordinates and null-only columns from the concise shape', () => {
    const out = project(sample(), 'atm', 'concise') as unknown as Record<string, unknown>;
    // latitude/longitude drive distance internally; no user asks to be told them.
    for (const dropped of [
      'latitude',
      'longitude',
      'function_code',
      'barrier-free_access_code',
      'network',
    ]) {
      expect(out, dropped).not.toHaveProperty(dropped);
    }
    expect(out).toHaveProperty('bank');
    expect(out).toHaveProperty('address');
  });

  it('keeps the fields that identify a record, not just the ones that describe it', () => {
    // Three facilities share one Yuen Long address — an i-Teller, a
    // SupremeGold centre and the branch itself. Trimming branch_name made them
    // look like duplicate data, and that is how it was reported (#25).
    const branches = (
      JSON.parse(readFixture('branch-locator-en.json')) as {
        result: { records: BankLocation[] };
      }
    ).result.records;

    const projected = branches.map((r) => project(r, 'branch', 'concise'));
    const grouped = new Map<string, string[]>();
    projected.forEach((row, index) => {
      const raw = JSON.stringify(branches[index]);
      const key = `${row.bank}|${row.address}`;
      const existing = grouped.get(key) ?? [];
      existing.push(raw);
      grouped.set(key, existing);
    });

    // The property that matters: where two raw records differ, their projections
    // must differ too. The size test cannot see this, which is how the field was
    // dropped in the first place.
    projected.forEach((row, index) => {
      projected.forEach((other, otherIndex) => {
        if (index >= otherIndex) return;
        const rawDiffers = JSON.stringify(branches[index]) !== JSON.stringify(branches[otherIndex]);
        if (!rawDiffers) return;
        expect(
          JSON.stringify(row) === JSON.stringify(other),
          `rows ${index} and ${otherIndex}`,
        ).toBe(false);
      });
    });
  });

  it('returns branch_name in the concise form, not only detailed', () => {
    // Detailed is not the default, so putting it there would not have fixed it.
    const branches = (
      JSON.parse(readFixture('branch-locator-en.json')) as {
        result: { records: BankLocation[] };
      }
    ).result.records;
    const withName = branches.find(
      (r) => typeof r.branch_name === 'string' && r.branch_name !== '',
    );
    expect(withName, 'fixture should contain a named branch').toBeDefined();
    if (withName !== undefined) {
      expect(project(withName, 'branch', 'concise').branch_name).toBeTruthy();
    }
  });

  it('is materially smaller than the raw record', () => {
    const raw = JSON.stringify(sample()).length;
    const concise = JSON.stringify(project(sample(), 'atm', 'concise')).length;
    expect(concise).toBeLessThan(raw * 0.6);
  });

  it('adds the extra fields only when detailed is asked for', () => {
    const concise = project(sample(), 'atm', 'concise');
    const detailed = project(sample(), 'atm', 'detailed');
    expect(concise.currencies).toBeUndefined();
    expect(detailed.currencies).toBeTruthy();
    expect(JSON.stringify(detailed).length).toBeGreaterThan(JSON.stringify(concise).length);
  });

  it('returns Chinese names when Chinese is requested', () => {
    // Regression: the summary honoured lang while the rows stayed English,
    // so a Cantonese answer was half-translated.
    const odd: BankLocation = {
      bank_name: '恒生銀行有限公司',
      district: '沙田區',
      address: '新界沙田',
    };
    const tc = project(odd, 'atm', 'concise', undefined, 'tc');
    expect(tc.bank).toBe('恒生銀行有限公司');
    expect(tc.district).toBe('沙田區');

    const en = project(odd, 'atm', 'concise', undefined, 'en');
    expect(en.bank).toBe('Hang Seng Bank Limited');
    expect(en.district).toBe('Sha Tin');
  });

  it('normalises the bank and district onto their canonical names', () => {
    const odd: BankLocation = {
      bank_name: 'Hang Seng Bank Limited',
      district: 'ShaTin',
      address: 'somewhere',
    };
    const out = project(odd, 'atm', 'concise');
    expect(out.district).toBe('Sha Tin');
    expect(out.bank).toBe('Hang Seng Bank Limited');
  });
});

describe('haversineKm', () => {
  it('measures a known Hong Kong distance', () => {
    // Central to Tsim Sha Tsui across the harbour is roughly 2 km.
    const km = haversineKm({ lat: 22.2819, lon: 114.158 }, { lat: 22.2971, lon: 114.1722 });
    expect(km).toBeGreaterThan(1.5);
    expect(km).toBeLessThan(3);
  });

  it('is zero for the same point', () => {
    expect(haversineKm({ lat: 22.3, lon: 114.2 }, { lat: 22.3, lon: 114.2 })).toBe(0);
  });
});
