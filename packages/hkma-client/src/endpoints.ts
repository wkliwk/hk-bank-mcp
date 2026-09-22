import { z } from 'zod';
import { TTL } from './cache.js';
import { HKMA_BASE_URL } from './sources.js';

/**
 * Endpoint definitions.
 *
 * Each one declares its own `maxPageSize` because the ceiling is undocumented and
 * differs per endpoint: the ATM locator accepted 5000 in testing, while the
 * register of authorised institutions fails with err_code 9999 somewhere between
 * 150 and 200. Encoding the limit here is what stops the client from generating
 * a request the API will reject.
 */
export interface EndpointDefinition<TRecord> {
  readonly id: string;
  /** Path relative to the HKMA public API base. */
  readonly path: string;
  readonly schema: z.ZodType<TRecord>;
  readonly ttlMs: number;
  readonly maxPageSize: number;
  /** Whether the endpoint honours the `lang` parameter. */
  readonly supportsLang: boolean;
  /** Which data source in `sources.ts` this belongs to, for attribution. */
  readonly sourceId: string;
}

const nullableNumber = z.number().nullable();
const nullableString = z.string().nullable();

/** One day's interbank rates. The full tenor curve, but published with a lag. */
export const hiborDailySchema = z.object({
  end_of_day: z.string(),
  ir_overnight: nullableNumber.optional(),
  ir_1w: nullableNumber.optional(),
  ir_1m: nullableNumber.optional(),
  ir_3m: nullableNumber.optional(),
  ir_6m: nullableNumber.optional(),
  // Frequently null in live data — a missing tenor must not be read as zero.
  ir_9m: nullableNumber.optional(),
  ir_12m: nullableNumber.optional(),
});
export type HiborDaily = z.infer<typeof hiborDailySchema>;

/** Next-business-day figures. Fresh, but only overnight and the 1M fixing. */
export const dailyMonetarySchema = z
  .object({
    end_of_date: z.string(),
    hibor_overnight: nullableNumber.optional(),
    hibor_fixing_1m: nullableNumber.optional(),
    disc_win_base_rate: nullableNumber.optional(),
    twi: nullableNumber.optional(),
    opening_balance: nullableNumber.optional(),
  })
  .passthrough();
export type DailyMonetary = z.infer<typeof dailyMonetarySchema>;

export const hkdInterestRateSchema = z.object({}).passthrough();
export type HkdInterestRate = z.infer<typeof hkdInterestRateSchema>;

/** Shared by the ATM, branch and self-service locators. */
export const bankLocationSchema = z
  .object({
    district: nullableString.optional(),
    bank_name: nullableString.optional(),
    address: nullableString.optional(),
    service_hours: nullableString.optional(),
    latitude: nullableString.optional(),
    longitude: nullableString.optional(),
  })
  .passthrough();
export type BankLocation = z.infer<typeof bankLocationSchema>;

export const authorisedInstitutionSchema = z.object({}).passthrough();
export type AuthorisedInstitution = z.infer<typeof authorisedInstitutionSchema>;

/**
 * Published scam list. Note `fraud_website_address` arrives **defanged**
 * (`hxxps://`, `[.]`) and often with trailing whitespace — matching a user's
 * real URL against it requires normalisation first.
 */
export const fraudulentScamSchema = z
  .object({
    issue_date: nullableString.optional(),
    alleged_name: nullableString.optional(),
    scam_type: nullableString.optional(),
    pr_url: nullableString.optional(),
    fraud_website_address: nullableString.optional(),
  })
  .passthrough();
export type FraudulentScam = z.infer<typeof fraudulentScamSchema>;

const MONTHLY = 'market-data-and-statistics/monthly-statistical-bulletin';
const DAILY = 'market-data-and-statistics/daily-monetary-statistics';
const BANK_INFO = 'bank-svf-info';

export const ENDPOINTS = {
  hiborDaily: {
    id: 'hiborDaily',
    path: `${MONTHLY}/er-ir/hk-interbank-ir-daily`,
    schema: hiborDailySchema,
    ttlMs: TTL.rates,
    maxPageSize: 100,
    supportsLang: false,
    sourceId: 'hkma-monthly-bulletin',
  } satisfies EndpointDefinition<HiborDaily>,

  dailyMonetary: {
    id: 'dailyMonetary',
    path: `${DAILY}/daily-figures-interbank-liquidity`,
    schema: dailyMonetarySchema,
    ttlMs: TTL.rates,
    maxPageSize: 100,
    supportsLang: false,
    sourceId: 'hkma-daily-monetary',
  } satisfies EndpointDefinition<DailyMonetary>,

  hkdInterestRates: {
    id: 'hkdInterestRates',
    path: `${MONTHLY}/er-ir/hkd-ir-effdates`,
    schema: hkdInterestRateSchema,
    ttlMs: TTL.rates,
    maxPageSize: 100,
    supportsLang: false,
    sourceId: 'hkma-monthly-bulletin',
  } satisfies EndpointDefinition<HkdInterestRate>,

  atmLocator: {
    id: 'atmLocator',
    path: `${BANK_INFO}/banks-atm-locator`,
    schema: bankLocationSchema,
    ttlMs: TTL.locators,
    maxPageSize: 1000,
    supportsLang: true,
    sourceId: 'hkma-bank-svf-info',
  } satisfies EndpointDefinition<BankLocation>,

  branchLocator: {
    id: 'branchLocator',
    path: `${BANK_INFO}/banks-branch-locator`,
    schema: bankLocationSchema,
    ttlMs: TTL.locators,
    maxPageSize: 1000,
    supportsLang: true,
    sourceId: 'hkma-bank-svf-info',
  } satisfies EndpointDefinition<BankLocation>,

  authorisedInstitutions: {
    id: 'authorisedInstitutions',
    path: `${BANK_INFO}/register-ais-lros`,
    // Measured ceiling: 150 works, 200 returns err_code 9999.
    schema: authorisedInstitutionSchema,
    ttlMs: TTL.registers,
    maxPageSize: 150,
    supportsLang: true,
    sourceId: 'hkma-bank-svf-info',
  } satisfies EndpointDefinition<AuthorisedInstitution>,

  fraudulentScams: {
    id: 'fraudulentScams',
    path: `${BANK_INFO}/fraudulent-bank-scams`,
    schema: fraudulentScamSchema,
    ttlMs: TTL.registers,
    maxPageSize: 1000,
    supportsLang: true,
    sourceId: 'hkma-bank-svf-info',
  } satisfies EndpointDefinition<FraudulentScam>,
} as const;

export type EndpointId = keyof typeof ENDPOINTS;

export interface QueryParams {
  lang?: 'en' | 'tc' | 'sc';
  pagesize?: number;
  offset?: number;
  sortby?: string;
  sortorder?: 'asc' | 'desc';
}

export function buildUrl(
  definition: { path: string; supportsLang: boolean },
  params: QueryParams = {},
): string {
  const url = new URL(`${HKMA_BASE_URL}/${definition.path}`);
  if (params.lang !== undefined && definition.supportsLang)
    url.searchParams.set('lang', params.lang);
  if (params.pagesize !== undefined) url.searchParams.set('pagesize', String(params.pagesize));
  if (params.offset !== undefined) url.searchParams.set('offset', String(params.offset));
  if (params.sortby !== undefined) url.searchParams.set('sortby', params.sortby);
  if (params.sortorder !== undefined) url.searchParams.set('sortorder', params.sortorder);
  return url.toString();
}
