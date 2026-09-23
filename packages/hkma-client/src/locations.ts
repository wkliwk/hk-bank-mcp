import { type Bank, bankByPublishedName, bankNames, matchBanks } from './banks.js';
import {
  type District,
  districtById,
  districtNames,
  resolveNeighbourhood,
  resolvePlace,
} from './districts.js';
import type { BankLocation } from './endpoints.js';
import { placeKey } from './normalise.js';

export type LocationType = 'atm' | 'branch' | 'self_service';
export type ResponseFormat = 'concise' | 'detailed';

/** Result shape returned to callers. Deliberately narrower than the raw record. */
export interface ResolvedLocation {
  bank: string;
  district: string;
  address: string;
  type: LocationType;
  /**
   * What this facility is called — "Yuen Long Branch", "Yuen Long i-Teller".
   * Identity, not detail: three facilities can share one address and differ
   * only here, so trimming it made them indistinguishable (#25).
   */
  branch_name?: string;
  service_hours?: string;
  /** Distance in km, present only when the search had a reference point. */
  distance_km?: number;
  // detailed only
  currencies?: string;
  network?: string;
  barrier_free?: string;
  machine_type?: string;
  /** Present when a neighbourhood label was supplied. */
  place_match?: 'label' | 'elsewhere';
}

export interface Coordinates {
  lat: number;
  lon: number;
}

export interface LocationQuery {
  type?: LocationType | 'any';
  /**
   * Canonical district ids. The caller — in practice the model — maps whatever
   * the user said onto these, which it does far better than a table here can:
   * 16/16 against 3/11 in measurement, including old names and slang.
   */
  districts?: readonly string[];
  /**
   * What the user actually called the place, e.g. 旺角 when the districts are
   * ["yau-tsim-mong"]. Never used to filter — only to rank results within the
   * district and to say plainly that the search covered the wider area.
   */
  placeLabel?: string;
  /** District or neighbourhood as free text. Resolved here when given. */
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
  searched_districts?: string[];
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
  placeMatch?: 'label' | 'elsewhere',
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
  const branchName = str((record as Record<string, unknown>).branch_name);
  if (branchName) out.branch_name = branchName;
  // Same reasoning as branch_name: at one address this is what separates a
  // cash machine from a deposit machine, so it identifies rather than decorates.
  const machineType = str((record as Record<string, unknown>).type_of_machine);
  if (machineType) out.machine_type = machineType;
  const hours = str(record.service_hours);
  if (hours) out.service_hours = hours;
  if (distanceKm !== undefined) out.distance_km = Math.round(distanceKm * 100) / 100;
  if (placeMatch !== undefined) out.place_match = placeMatch;

  if (format === 'detailed') {
    const extras: [keyof ResolvedLocation, string][] = [
      ['currencies', str((record as Record<string, unknown>).currencies_supported)],
      ['network', str((record as Record<string, unknown>).network)],
      ['barrier_free', str((record as Record<string, unknown>)['barrier-free_access'])],
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

  // A filter that quietly does nothing is worse than one that fails: the user
  // asked to limit by distance and would be handed everything instead, with no
  // signal that the limit was dropped. Same reasoning as #22 — an error is
  // something the model corrects, a vanished filter is something it cannot see.
  if (query.radiusKm !== undefined && query.near === undefined) {
    throw new LocationQueryError(
      'radius_km was given without near.',
      "A radius needs a point to measure from. Supply near with the user's coordinates, " +
        'or drop radius_km and filter by district instead.',
    );
  }

  if (query.districts !== undefined && query.districts.length === 0) {
    throw new LocationQueryError(
      'districts must contain at least one district id.',
      "Omit districts to search all of Hong Kong, or provide every district id the user's region covers.",
    );
  }

  // `districts` is the canonical, machine-checked input and takes precedence.
  // When it is present, `place` is ignored entirely rather than partially —
  // previously the filter used `districts` while `resolved_place` still
  // described whatever `place` resolved to, so the model was told one thing
  // and handed results for another (#27).
  const districtsGiven = query.districts !== undefined;

  let districts: District[] = [];
  let resolvedPlace: string | undefined;

  if (districtsGiven) {
    districts = (query.districts ?? []).map((id) => {
      const district = districtById(id);
      if (district === undefined) {
        throw new LocationQueryError(
          `Unknown district id: ${id}.`,
          'Use one of the canonical district ids provided by the tool schema.',
          DISTRICT_IDS_FOR_ERROR,
        );
      }
      return district;
    });
  } else if (query.place !== undefined && query.place.trim() !== '') {
    const place = resolvePlace(query.place);
    if (place === undefined) {
      throw new LocationQueryError(
        `Unknown place: ${query.place}.`,
        'That is not a Hong Kong district or a neighbourhood this server knows. ' +
          'Ask the user to confirm, or retry with one of the 18 districts listed in candidates.',
        districtNamesFor(lang),
      );
    }
    districts = [place.district];
    if (place.matchedAs === 'neighbourhood') {
      resolvedPlace = `${query.place} is in ${lang === 'tc' ? place.district.tc : place.district.en}`;
    }
  }

  const districtIds = new Set(districts.map((d) => d.id));

  // The label only falls back to `place` when `place` was actually used to pick
  // the districts. Falling back to an overridden `place` would rank results by
  // a neighbourhood that is not in any district being searched — every row
  // would come back `elsewhere`, which is true but meaningless.
  const placeLabel =
    query.placeLabel?.trim() || (districtsGiven ? undefined : query.place?.trim()) || undefined;
  const labelKeys = placeLabel === undefined ? [] : placeKeys(placeLabel);

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

  const matched: {
    record: BankLocation;
    type: LocationType;
    distance?: number;
    placeMatch: boolean;
  }[] = [];
  for (const source of sources) {
    if (wantedType !== 'any' && source.type !== wantedType) continue;
    for (const record of source.records) {
      const recordDistrict = resolvePlace(str(record.district))?.district;
      if (districts.length > 0) {
        if (recordDistrict === undefined || !districtIds.has(recordDistrict.id)) continue;
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
          ? {
              record,
              type: source.type,
              placeMatch: placeMatch(record, labelKeys),
            }
          : {
              record,
              type: source.type,
              distance,
              placeMatch: placeMatch(record, labelKeys),
            },
      );
    }
  }

  const total = matched.length;

  matched.sort((a, b) => {
    const byPlace = (b.placeMatch ? 1 : 0) - (a.placeMatch ? 1 : 0);
    if (byPlace !== 0) return byPlace;
    return query.near === undefined ? 0 : (a.distance ?? Infinity) - (b.distance ?? Infinity);
  });

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
      ...(districts.length === 0 ? {} : { searched_districts: districts.map((d) => d.id) }),
    };
  }

  const page = matched.slice(0, limit);
  const results = page.map((m) =>
    project(
      m.record,
      m.type,
      format,
      m.distance,
      lang,
      m.placeMatch ? 'label' : placeLabel ? 'elsewhere' : undefined,
    ),
  );

  return {
    summary: buildSummary(total, results.length, {
      districts,
      bank,
      wantedType,
      query,
      lang,
      labelMatchCount: matched.filter((m) => m.placeMatch).length,
    }),
    total_matches: total,
    showing: results.length,
    results,
    ...(resolvedPlace === undefined ? {} : { resolved_place: resolvedPlace }),
    ...(districts.length === 0 ? {} : { searched_districts: districts.map((d) => d.id) }),
  };
}

const DISTRICT_IDS_FOR_ERROR = [
  'central-western',
  'wan-chai',
  'eastern',
  'southern',
  'yau-tsim-mong',
  'sham-shui-po',
  'kowloon-city',
  'wong-tai-sin',
  'kwun-tong',
  'kwai-tsing',
  'tsuen-wan',
  'tuen-mun',
  'yuen-long',
  'north',
  'tai-po',
  'sha-tin',
  'sai-kung',
  'islands',
];

function placeKeys(label: string): string[] {
  const neighbourhood = resolveNeighbourhood(label);
  const names = neighbourhood?.names ?? [label];
  return names.map(placeKey).filter((key, index, all) => key !== '' && all.indexOf(key) === index);
}

function placeMatch(record: BankLocation, keys: readonly string[]): boolean {
  if (keys.length === 0) return false;
  const address = placeKey(str(record.address));
  return keys.some((key) => address.includes(key));
}

function buildSummary(
  total: number,
  showing: number,
  ctx: {
    districts: District[];
    bank: Bank | undefined;
    wantedType: LocationType | 'any';
    query: LocationQuery;
    lang: 'en' | 'tc';
    labelMatchCount: number;
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
  if (ctx.districts.length === 1) {
    const district = ctx.districts[0];
    if (district !== undefined) parts.push(`in ${ctx.lang === 'tc' ? district.tc : district.en}`);
  } else if (ctx.districts.length > 1) {
    parts.push(`across ${ctx.districts.length} districts`);
  }
  if (ctx.query.currency !== undefined && ctx.query.currency !== '')
    parts.push(`supporting ${ctx.query.currency.toUpperCase()}`);
  if (ctx.query.near !== undefined) parts.push('sorted by distance');
  if (ctx.query.placeLabel !== undefined && ctx.districts.length === 1) {
    const district = ctx.districts[0];
    if (district !== undefined) {
      const districtName = ctx.lang === 'tc' ? district.tc : district.en;
      return `${ctx.labelMatchCount} in ${ctx.query.placeLabel}, ${total - ctx.labelMatchCount} elsewhere in ${districtName}${showing < total ? `, showing the first ${showing}` : ''}.`;
    }
  }
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
