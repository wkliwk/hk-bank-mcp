import { describe, expect, it } from 'vitest';
import { BANKS, matchBanks } from '../src/banks.js';
import { DISTRICTS, resolveDistrict, resolvePlace } from '../src/districts.js';
import { canonicaliseCharacters, matchKey, placeKey } from '../src/normalise.js';

describe('character canonicalisation', () => {
  it('collapses traditional variants onto one form', () => {
    expect(canonicaliseCharacters('恆生')).toBe(canonicaliseCharacters('恒生'));
    expect(canonicaliseCharacters('匯豐')).toBe(canonicaliseCharacters('滙豐'));
  });

  it('collapses the simplified characters that appear in bank and district names', () => {
    expect(canonicaliseCharacters('中国银行')).toBe('中國銀行');
    expect(canonicaliseCharacters('东亚')).toBe('東亚');
    expect(canonicaliseCharacters('元朗区')).toBe('元朗區');
  });

  it('leaves everything else untouched', () => {
    expect(canonicaliseCharacters('Hang Seng')).toBe('Hang Seng');
  });
});

describe('matchKey', () => {
  it('strips generic words so a bare name and a full legal name agree', () => {
    // These three are the same bank typed three ways.
    const keys = ['恒生', '恒生銀行有限公司', '恒生bank'].map(matchKey);
    expect(new Set(keys).size).toBe(1);
  });

  it('is insensitive to case, spacing and punctuation', () => {
    const keys = ['HSBC', 'hsbc', 'H S B C', '  hsbc  '].map(matchKey);
    expect(new Set(keys).size).toBe(1);
  });
});

describe('stripping generic words is safe', () => {
  it('never collapses two different banks onto the same key', () => {
    // The risk of stripping words is a false match — answering with the wrong
    // bank's ATMs. This asserts the stripping list contains only words that
    // carry no identifying information.
    const byKey = new Map<string, string>();
    for (const bank of BANKS) {
      for (const name of [bank.en, bank.tc]) {
        const key = matchKey(name);
        const seen = byKey.get(key);
        expect(seen === undefined || seen === bank.id, `${key}: ${seen} vs ${bank.id}`).toBe(true);
        byKey.set(key, bank.id);
      }
    }
  });

  it('never collapses two different districts onto the same key', () => {
    const keys = DISTRICTS.flatMap((d) => [placeKey(d.en), placeKey(d.tc)]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('still refuses to guess when input genuinely matches several banks', () => {
    expect(matchBanks('中國').length).toBeGreaterThan(1);
  });
});

describe('resolution after normalisation', () => {
  it('resolves variant and simplified bank names without listing them as aliases', () => {
    // 恆生 / 匯豐 / 中国银行 are deliberately NOT in the alias tables — if these
    // pass, normalisation is doing the work rather than enumeration.
    const cases: [string, string][] = [
      ['恆生', 'hangseng'],
      ['匯豐', 'hsbc'],
      ['滙丰', 'hsbc'],
      ['中国银行', 'bochk'],
      ['东亚', 'bea'],
    ];
    for (const [input, id] of cases) {
      const matches = matchBanks(input);
      expect(matches.length, input).toBe(1);
      expect(matches[0]?.bank.id, input).toBe(id);
    }
  });

  it('resolves mixed-script input', () => {
    for (const [input, id] of [
      ['恒生bank', 'hangseng'],
      ['HSBC銀行', 'hsbc'],
      ['渣打Bank', 'scb'],
      ['中銀香港', 'bochk'],
    ] as [string, string][]) {
      expect(matchBanks(input)[0]?.bank.id, input).toBe(id);
    }
  });

  it('resolves colloquial and abbreviated place names', () => {
    for (const [input, id] of [
      ['MK', 'yau-tsim-mong'],
      ['尖咀', 'yau-tsim-mong'],
      ['尖沙嘴', 'yau-tsim-mong'],
      ['銅記', 'wan-chai'],
      ['CWB', 'wan-chai'],
      ['旺角區', 'yau-tsim-mong'],
    ] as [string, string][]) {
      expect(resolvePlace(input)?.district.id, input).toBe(id);
    }
  });

  it('resolves simplified district names', () => {
    expect(resolveDistrict('中西区')?.id).toBe('central-western');
    expect(resolveDistrict('元朗区')?.id).toBe('yuen-long');
  });

  it('still rejects places that are not in Hong Kong', () => {
    // Normalisation must widen what matches, not make everything match.
    for (const nope of ['Tokyo', '火星', 'Singapore', '']) {
      expect(resolvePlace(nope), nope).toBeUndefined();
    }
  });
});
