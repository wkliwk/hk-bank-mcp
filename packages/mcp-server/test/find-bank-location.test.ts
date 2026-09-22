import { describe, expect, it } from 'vitest';
import { inputSchema } from '../src/tools/find-bank-location.js';

/**
 * These tests guard the tool's *interface*, not its logic. The search itself is
 * tested in hkma-client; what can only go wrong here is the contract the model
 * sees and fills in.
 */
describe('hk_find_bank_location input contract', () => {
  it('rejects an unrecognised parameter instead of silently dropping it', () => {
    // The failure this prevents: a filter the user asked for disappears, the
    // call still succeeds, and the model answers as if it had been applied.
    const result = inputSchema.safeParse({ place: '沙田', nonsense: 'x' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toMatch(/nonsense/);
    }
  });

  it('accepts the parameter names the model actually produces', () => {
    // Captured from a real call on 「我想搵間喺旺角嗰邊嘅恒生bank，最好係分行」:
    // the model reached for district and service_type, not place and type.
    const result = inputSchema.safeParse({
      district: '旺角',
      bank: '恒生銀行',
      service_type: 'branch',
      limit: 2,
      lang: 'tc',
    });
    expect(result.success).toBe(true);
  });

  it('accepts the canonical names too', () => {
    expect(inputSchema.safeParse({ place: '旺角', type: 'branch' }).success).toBe(true);
  });

  it('rejects a language the model is likely to guess', () => {
    // "zh-Hant" was the model's first attempt; the enum rejected it and the
    // model corrected itself on the next call. That is the behaviour wanted
    // everywhere, and the reason unknown keys must error rather than vanish.
    expect(inputSchema.safeParse({ lang: 'zh-Hant' }).success).toBe(false);
    expect(inputSchema.safeParse({ lang: 'tc' }).success).toBe(true);
  });

  it('leaves every filter optional', () => {
    expect(inputSchema.safeParse({}).success).toBe(true);
  });

  it('rejects a limit that is not a positive integer', () => {
    expect(inputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(inputSchema.safeParse({ limit: -5 }).success).toBe(false);
    expect(inputSchema.safeParse({ limit: 2.5 }).success).toBe(false);
  });
});
