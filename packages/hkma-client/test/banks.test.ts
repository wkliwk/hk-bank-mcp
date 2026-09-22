import { describe, expect, it } from 'vitest';
import { BANKS, bankByPublishedName, matchBanks, resolveBank } from '../src/banks.js';
import { readFixture } from './helpers.js';

interface Row {
  bank_name?: string | null;
}
const bankNamesIn = (name: string): Set<string> => {
  const recs = (JSON.parse(readFixture(name)) as { result: { records: Row[] } }).result.records;
  return new Set(recs.map((r) => r.bank_name).filter((n): n is string => Boolean(n)));
};

describe('bank matching', () => {
  it('recognises every published name in the real data, in both languages', () => {
    const names = new Set([
      ...bankNamesIn('atm-locator-en.json'),
      ...bankNamesIn('atm-locator-tc.json'),
    ]);
    const unknown = [...names].filter((n) => bankByPublishedName(n) === undefined);
    expect(unknown).toEqual([]);
  });

  it('resolves the short forms people actually type', () => {
    // "HSBC" appears nowhere in "The Hongkong and Shanghai Banking Corporation
    // Limited", so substring search alone would fail here.
    const cases: [string, string][] = [
      ['HSBC', 'hsbc'],
      ['滙豐', 'hsbc'],
      ['匯豐', 'hsbc'],
      ['恒生', 'hangseng'],
      ['恆生', 'hangseng'],
      ['Hang Seng', 'hangseng'],
      ['中銀', 'bochk'],
      ['BOC', 'bochk'],
      ['渣打', 'scb'],
      ['SCB', 'scb'],
      ['東亞', 'bea'],
      ['花旗', 'citi'],
      ['星展', 'dbs'],
    ];
    for (const [input, id] of cases) {
      expect(resolveBank(input)?.id, input).toBe(id);
    }
  });

  it('returns every candidate when the input is ambiguous rather than guessing', () => {
    // Silently picking one of these would answer the wrong bank's ATMs.
    const matches = matchBanks('中國');
    expect(matches.length).toBeGreaterThan(1);
    expect(resolveBank('中國')).toBeUndefined();
  });

  it('returns nothing for a bank that does not operate here', () => {
    expect(matchBanks('Barclays')).toEqual([]);
    expect(matchBanks('')).toEqual([]);
  });

  it('prefers an exact legal name over a partial match', () => {
    const matches = matchBanks('Hang Seng Bank Limited');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.matchedAs).toBe('exact');
  });

  it('has unique ids and no duplicate published names', () => {
    expect(new Set(BANKS.map((b) => b.id)).size).toBe(BANKS.length);
    expect(new Set(BANKS.map((b) => b.en)).size).toBe(BANKS.length);
    expect(new Set(BANKS.map((b) => b.tc)).size).toBe(BANKS.length);
  });
});
