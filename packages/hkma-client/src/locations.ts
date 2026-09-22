import { type Bank, bankByPublishedName, bankNames, matchBanks } from './banks.js';
import { type District, districtNames, resolvePlace } from './districts.js';
import type { BankLocation } from './endpoints.js';

export type LocationType = 'atm' | 'branch' | 'self_service';
export type ResponseFormat = 'concise' | 'detailed';

/** Result shape returned to callers. Deliberately narrower than the raw record. */
export interface ResolvedLocation {
  bank: string;
  district: string;
  address: string;
  type: LocationType;
  service_hours?: string;
  /** Distance in km, present only when the search had a reference point. */
  distance_km?: number;
  // detailed only
  currencies?: string;
  network?: string;
  barrier_free?: string;
  machine_type?: string;
}

export interface Coordinates {
  lat: number;
  lon: number;
}

export interface LocationQuery {
  type?: LocationType | 'any';
  /** District or neighbourhood, English or Chinese. */
  place?: string;
  bank?: string;
  /** Substring match against the currencies field, e.g. "RMB". */
  currency?: string;
  near?: Coordinates;
  radiusKm?: number;
  limit?: number;
  format?: ResponseFormat;
  lang?: 'en' | 'tc';
}

export const LIMIT_DEFAULT = 10;
/**
 * Hard ceiling regardless of what the caller asks for. Exceeding a client's
 * context window is not a degraded response, it ends the conversation — so this
 * is enforced rather than advisory.
 */
export const LIMIT_MAX = 100;
/** Above this, narrowing is more useful to the caller than a truncated list. */
export const TOO_MANY_THRESHOLD = 400;

export interface LocationResult {
  summary: string;
  total_matches: number;
  showing: number;
  results: ResolvedLocation[];
  /** Present when the query was too broad to answer usefully. */
  narrow_hint?: string;
  /** Set when a neighbourhood was translated to its district. */
  resolved_place?: string;
}

export class LocationQueryError extends Error {
  readonly agentHint: string;
  readonly candidates: string[] | undefined;

  constructor(message: string, agentHint: string, candidates?: string[]) {
    super(message);
    this.name = 'LocationQueryError';
    this.agentHint = agentHint;
    this.candidates = candidates;
  }
}

/** Great-circle distance in km. */
export function haversineKm(a: Coordinates, b: Coordinates): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function coordsOf(record: BankLocation): Coordinates | undefined {
  const lat = Number(record.latitude);
  const lon = Number(record.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  if (lat === 0 && lon === 0) return undefined;
  return { lat, lon };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Project a raw record down to what answers the question.
 *
 * The raw record has 13 fields at about 701 characters. Two of them
 * (`function_code`, `barrier-free_access_code`) are null on every row observed.
 * Latitude and longitude are used for distance and then dropped: they cost
 * tokens and no user asks to be told coordinates.
 */
export function project(
  record: BankLocation,
  type: LocationType,
  format: ResponseFormat,
  distanceKm?: number,
  lang: 'en' | 'tc' = 'en',
): ResolvedLocation {
  const bankRecord = bankByPublishedName(str(record.bank_name));
  const districtRecord = resolvePlace(str(record.district))?.district;

  // Names must follow the requested language. The raw record already carries
  // the right language for its dataset, but normalising through the canonical
  // record would otherwise force everything back to English.
  const out: ResolvedLocation = {
    bank: (lang === 'tc' ? bankRecord?.tc : bankRecord?.en) ?? str(record.bank_name),
    district: (lang === 'tc' ? districtRecord?.tc : districtRecord?.en) ?? str(record.district),
    address: str(record.address),
    type,
  };
  const hours = str(record.service_hours);
  if (hours) out.service_hours = hours;
  if (distanceKm !== undefined) out.distance_km = Math.round(distanceKm * 100) / 100;

  if (format === 'detailed') {
    const extras: [keyof ResolvedLocation, string][] = [
      ['currencies', str((record as Record<string, unknown>).currencies_supported)],
      ['network', str((record as Record<string, unknown>).network)],
      ['barrier_free', str((record as Record<string, unknown>)['barrier-free_access'])],
      ['machine_type', str((record as Record<string, unknown>).type_of_machine)],
    ];
    for (const [key, value] of extras) {
      if (value) (out as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

export interface TypedRecords {
  type: LocationType;
  records: BankLocation[];
}

/**
 * Filter, sort and cap. Every filter is optional: omitting one widens the
 * search rather than applying a default the caller did not ask for.
 */
export function searchLocations(sources: TypedRecords[], query: LocationQuery): LocationResult {
  const lang = query.lang ?? 'en';
  const format = query.format ?? 'concise';
  const limit = Math.min(Math.max(1, query.limit ?? LIMIT_DEFAULT), LIMIT_MAX);

  let district: District | undefined;
  let resolvedPlace: string | undefined;
  if (query.place !== undefined && query.place.trim() !== '') {
    const place = resolvePlace(query.place);
    if (place === undefined) {
      throw new LocationQueryError(
        `Unknown place: ${query.place}.`,
        'That is not a Hong Kong district or a neighbourhood this server knows. ' +
          'Ask the user to confirm, or retry with one of the 18 districts listed in candidates.',
        districtNamesFor(lang),
      );
    }
    district = place.district;
    if (place.matchedAs === 'neighbourhood') {
      resolvedPlace = `${query.place} is in ${lang === 'tc' ? district.tc : district.en}`;
    }
  }

  let bank: Bank | undefined;
  if (query.bank !== undefined && query.bank.trim() !== '') {
    const matches = matchBanks(query.bank);
    if (matches.length === 0) {
      throw new LocationQueryError(
        `Unknown bank: ${query.bank}.`,
        'No Hong Kong retail bank matched. Check the spelling against candidates, ' +
          'or drop the bank filter to search every bank.',
        bankNamesFor(lang),
      );
    }
    if (matches.length > 1) {
      throw new LocationQueryError(
        `"${query.bank}" matches ${matches.length} banks.`,
        'Ambiguous. Ask the user which one they meant — do not pick one.',
        matches.map((m) => (lang === 'tc' ? m.bank.tc : m.bank.en)),
      );
    }
    bank = matches[0]?.bank;
  }

  const wantedType = query.type ?? 'any';
  const currency = query.currency?.toLowerCase().trim();

  const matched: { record: BankLocation; type: LocationType; distance?: number }[] = [];
  for (const source of sources) {
    if (wantedType !== 'any' && source.type !== wantedType) continue;
    for (const record of source.records) {
      if (district !== undefined) {
        if (resolvePlace(str(record.district))?.district.id !== district.id) continue;
      }
      if (bank !== undefined) {
        if (bankByPublishedName(str(record.bank_name))?.id !== bank.id) continue;
      }
      if (currency !== undefined && currency !== '') {
        const supported = str(
          (record as Record<string, unknown>).currencies_supported,
        ).toLowerCase();
        if (!supported.includes(currency)) continue;
      }
      let distance: number | undefined;
      if (query.near !== undefined) {
        const coords = coordsOf(record);
        if (coords === undefined) continue;
        distance = haversineKm(query.near, coords);
        if (query.radiusKm !== undefined && distance > query.radiusKm) continue;
      }
      matched.push(
        distance === undefined
          ? { record, type: source.type }
          : { record, type: source.type, distance },
      );
    }
  }

  const total = matched.length;

  if (query.near !== undefined) {
    matched.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
  }

  // Refusing beats truncating silently: a caller that cannot see it is missing
  // results will answer confidently and wrongly.
  if (total > TOO_MANY_THRESHOLD && query.near === undefined) {
    return {
      summary: `${total} locations match — too many to list usefully.`,
      total_matches: total,
      showing: 0,
      results: [],
      narrow_hint:
        'Add a filter before retrying: place (district or neighbourhood), bank, ' +
        'currency, or near + radius_km for the closest ones.',
      ...(resolvedPlace === undefined ? {} : { resolved_place: resolvedPlace }),
    };
  }

  const page = matched.slice(0, limit);
  const results = page.map((m) => project(m.record, m.type, format, m.distance, lang));

  return {
    summary: buildSummary(total, results.length, { district, bank, wantedType, query, lang }),
    total_matches: total,
    showing: results.length,
    results,
    ...(resolvedPlace === undefined ? {} : { resolved_place: resolvedPlace }),
  };
}

function buildSummary(
  total: number,
  showing: number,
  ctx: {
    district: District | undefined;
    bank: Bank | undefined;
    wantedType: LocationType | 'any';
    query: LocationQuery;
    lang: 'en' | 'tc';
  },
): string {
  if (total === 0) {
    return 'No locations match those filters.';
  }
  const noun =
    ctx.wantedType === 'atm'
      ? 'ATMs'
      : ctx.wantedType === 'branch'
        ? 'branches'
        : ctx.wantedType === 'self_service'
          ? 'self-service points'
          : 'locations';
  const parts: string[] = [`${total} ${noun}`];
  if (ctx.bank !== undefined) parts.push(`at ${ctx.lang === 'tc' ? ctx.bank.tc : ctx.bank.en}`);
  if (ctx.district !== undefined)
    parts.push(`in ${ctx.lang === 'tc' ? ctx.district.tc : ctx.district.en}`);
  if (ctx.query.currency !== undefined && ctx.query.currency !== '')
    parts.push(`supporting ${ctx.query.currency.toUpperCase()}`);
  if (ctx.query.near !== undefined) parts.push('sorted by distance');
  const shown = showing < total ? `, showing the first ${showing}` : '';
  return `${parts.join(' ')}${shown}.`;
}

const districtNameCache = { en: districtNames('en'), tc: districtNames('tc') } as const;
const bankNameCache = { en: bankNames('en'), tc: bankNames('tc') } as const;

function districtNamesFor(lang: 'en' | 'tc'): string[] {
  return [...districtNameCache[lang]];
}

function bankNamesFor(lang: 'en' | 'tc'): string[] {
  return [...bankNameCache[lang]];
}
