import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { inputShape } from '../src/tools/get-interest-rates.js';

const schema = z.object(inputShape);

describe('hk_get_interest_rates input contract', () => {
  it('requires rate_type', () => {
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('accepts the minimal hibor query', () => {
    expect(schema.safeParse({ rate_type: 'hibor' }).success).toBe(true);
  });

  it('accepts hkd_reference with no tenor (prime/savings rate)', () => {
    expect(schema.safeParse({ rate_type: 'hkd_reference' }).success).toBe(true);
  });

  it('rejects a tenor that is not one of the seven HIBOR periods', () => {
    expect(schema.safeParse({ rate_type: 'hibor', tenor: '2m' }).success).toBe(false);
  });

  it('accepts a from/to range', () => {
    const result = schema.safeParse({
      rate_type: 'hibor',
      tenor: '3m',
      from: '2026-08-01',
      to: '2026-09-01',
    });
    expect(result.success).toBe(true);
  });

  it('defaults detail to false', () => {
    const result = schema.safeParse({ rate_type: 'hibor', tenor: '3m' });
    expect(result.success && result.data.detail).toBe(false);
  });
});
