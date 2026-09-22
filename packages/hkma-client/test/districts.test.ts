import { describe, expect, it } from 'vitest';
import { DISTRICTS, districtKey, resolveDistrict, resolvePlace } from '../src/districts.js';
import { readFixture } from './helpers.js';

interface Row {
  district?: string | null;
  bank_name?: string | null;
}
const rows = (name: string): Row[] =>
  (JSON.parse(readFixture(name)) as { result: { records: Row[] } }).result.records;

describe('district normalisation', () => {
  it('resolves every spelling present in the real data, in both languages', () => {
    // The fixture was built to cover all 68 English and 37 Chinese spellings
    // observed in the full 2,003-record dataset. Any spelling this cannot
    // resolve is a location the tool would silently fail to find.
    const spellings = new Set<string>();
    for (const name of ['atm-locator-en.json', 'atm-locator-tc.json']) {
      for (const row of rows(name)) if (row.district) spellings.add(row.district);
    }
    expect(spellings.size).toBeGreaterThan(60);

    const unresolved = [...spellings].filter((s) => resolveDistrict(s) === undefined);
    expect(unresolved).toEqual([]);
  });

  it('collapses the five spellings of Central & Western onto one district', () => {
    const variants = [
      'Central & Western',
      'Central & Western District',
      'Central and Western District',
      'Central and Western District ',
      'CentralNWestern',
      '中西區',
    ];
    const ids = new Set(variants.map((v) => resolveDistrict(v)?.id));
    expect(ids).toEqual(new Set(['central-western']));
  });

  it('matches the two misspellings HKMA actually publishes', () => {
    // These are typos in the source data, not hypotheticals.
    expect(resolveDistrict('Shum Shui Po District')?.id).toBe('sham-shui-po');
    expect(resolveDistrict('Yau Tsui Mong')?.id).toBe('yau-tsim-mong');
  });

  it('handles the spacing and suffix variants generically', () => {
    for (const v of ['Sha Tin District', 'Shatin', 'ShaTin', 'SHA TIN', ' sha tin ', '沙田區']) {
      expect(resolveDistrict(v)?.id, v).toBe('sha-tin');
    }
  });

  it('maps neighbourhoods to their district and says so', () => {
    // Nobody asks about "Yau Tsim Mong" — they ask about Mong Kok.
    const mongkok = resolvePlace('旺角');
    expect(mongkok?.district.id).toBe('yau-tsim-mong');
    expect(mongkok?.matchedAs).toBe('neighbourhood');

    expect(resolvePlace('Causeway Bay')?.district.id).toBe('wan-chai');
    expect(resolvePlace('TST')?.district.id).toBe('yau-tsim-mong');
    expect(resolvePlace('將軍澳')?.district.id).toBe('sai-kung');
  });

  it('reports a district match as a district, not a neighbourhood', () => {
    expect(resolvePlace('沙田')?.matchedAs).toBe('district');
  });

  it('returns undefined for somewhere that is not in Hong Kong', () => {
    expect(resolvePlace('火星')).toBeUndefined();
    expect(resolvePlace('Tokyo')).toBeUndefined();
  });

  it('covers all 18 districts and no more', () => {
    expect(DISTRICTS).toHaveLength(18);
    expect(new Set(DISTRICTS.map((d) => d.id)).size).toBe(18);
  });

  it('produces a stable key regardless of case, spacing or suffix', () => {
    expect(districtKey('Sha Tin District ')).toBe(districtKey('shatin'));
  });
});
