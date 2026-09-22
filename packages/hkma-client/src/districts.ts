/**
 * Hong Kong has 18 districts. The HKMA ATM dataset contains 68 distinct spellings
 * of them, because each bank submits its own formatting and HKMA does not
 * normalise before publishing.
 *
 * The variation is not cosmetic. Measured against the full 2,003-record dataset,
 * matching only the single most common spelling of a district misses:
 *
 *   Sha Tin            53% of its ATMs  (4 spellings)
 *   Central & Western  45%              (5 spellings, incl. "CentralNWestern")
 *   Sham Shui Po       30%              (5 spellings, incl. a typo)
 *   Wan Chai           27%              (5 spellings)
 *   Yau Tsim Mong      23%              (4 spellings, incl. a typo)
 *
 * Two outright misspellings are published as data and must be matched anyway:
 * "Shum Shui Po District" (Shum/Sham) and "Yau Tsui Mong" (Tsui/Tsim).
 */

import { placeKey } from './normalise.js';

export interface District {
  /** Canonical English name. */
  readonly id: string;
  readonly en: string;
  readonly tc: string;
  /**
   * Extra spellings seen in the data that normalisation does not already reach.
   * Case, whitespace, "District" suffixes, and &/and are handled generically,
   * so only genuine oddities and typos are listed here.
   */
  readonly quirks?: readonly string[];
}

export const DISTRICTS: readonly District[] = [
  { id: 'central-western', en: 'Central & Western', tc: '中西區', quirks: ['centralnwestern'] },
  { id: 'wan-chai', en: 'Wan Chai', tc: '灣仔區' },
  { id: 'eastern', en: 'Eastern', tc: '東區' },
  { id: 'southern', en: 'Southern', tc: '南區' },
  { id: 'yau-tsim-mong', en: 'Yau Tsim Mong', tc: '油尖旺區', quirks: ['yautsuimong'] },
  { id: 'sham-shui-po', en: 'Sham Shui Po', tc: '深水埗區', quirks: ['shumshuipo'] },
  { id: 'kowloon-city', en: 'Kowloon City', tc: '九龍城區' },
  { id: 'wong-tai-sin', en: 'Wong Tai Sin', tc: '黃大仙區' },
  { id: 'kwun-tong', en: 'Kwun Tong', tc: '觀塘區' },
  { id: 'kwai-tsing', en: 'Kwai Tsing', tc: '葵青區', quirks: ['葵青/kuiqing'] },
  { id: 'tsuen-wan', en: 'Tsuen Wan', tc: '荃灣區' },
  { id: 'tuen-mun', en: 'Tuen Mun', tc: '屯門區' },
  { id: 'yuen-long', en: 'Yuen Long', tc: '元朗區' },
  { id: 'north', en: 'North', tc: '北區', quirks: ['northern'] },
  { id: 'tai-po', en: 'Tai Po', tc: '大埔區' },
  { id: 'sha-tin', en: 'Sha Tin', tc: '沙田區' },
  { id: 'sai-kung', en: 'Sai Kung', tc: '西貢區' },
  {
    id: 'islands',
    en: 'Islands',
    tc: '離島區',
    // The data also files individual islands as if they were districts.
    quirks: [
      'outlyingisland',
      'outlyingislands',
      'cheungchau',
      'lammaisland',
      'lantauisland',
      'pengchau',
      '長洲',
      '大嶼山',
      '坪洲',
      '南丫島',
    ],
  },
];

/**
 * Reduce a district string to a comparable key.
 *
 * Handles, in order: case, surrounding and internal whitespace, a trailing
 * "District" (present on some rows and not others, sometimes with a trailing
 * space), "&" written as "and" or as the letter "N", and finally all remaining
 * separators — which is what collapses "ShaTin", "Sha Tin" and "Shatin".
 */
export function districtKey(value: string): string {
  return placeKey(value);
}

const BY_KEY = new Map<string, District>();
for (const district of DISTRICTS) {
  BY_KEY.set(districtKey(district.en), district);
  BY_KEY.set(districtKey(district.tc), district);
  // Chinese input frequently omits the 區 suffix: 沙田 rather than 沙田區.
  BY_KEY.set(districtKey(district.tc.replace(/區$/, '')), district);
  BY_KEY.set(district.id.replace(/-/g, ''), district);
  for (const quirk of district.quirks ?? []) BY_KEY.set(districtKey(quirk), district);
}

/** Resolve any spelling — data or user input, English or Chinese — to a district. */
export function resolveDistrict(value: string): District | undefined {
  return BY_KEY.get(districtKey(value));
}

/** Every canonical district name, for error messages that list valid values. */
export function districtNames(lang: 'en' | 'tc' = 'en'): string[] {
  return DISTRICTS.map((d) => (lang === 'tc' ? d.tc : d.en));
}

/**
 * Neighbourhoods, grouped by the place rather than by the spelling.
 *
 * Grouping matters for ranking, not just lookup: when someone asks about 旺角
 * the English dataset writes "Mongkok" in its addresses, so the two spellings
 * have to be known to be the same place before results can be ordered by
 * relevance to what was asked.
 *
 * This table is deliberately not exhaustive. The model maps places to district
 * ids far better than any list maintained by hand — measured at 16/16 against
 * 3/11 for an earlier version of this table, including old names (九龍仔, 荔園),
 * old spellings (官塘, 深水埔) and slang (銅記). What stays here is what the
 * model cannot do: knowing which spellings appear in the address text so
 * results can be ranked within a district.
 */
export interface Neighbourhood {
  readonly id: string;
  readonly district: string;
  /** Every spelling that may appear in an address or in user input. */
  readonly names: readonly string[];
}

export const NEIGHBOURHOODS: readonly Neighbourhood[] = [
  { id: 'central', district: 'central-western', names: ['中環', 'Central'] },
  { id: 'sheung-wan', district: 'central-western', names: ['上環', 'Sheung Wan'] },
  {
    id: 'sai-wan',
    district: 'central-western',
    names: ['西環', 'Sai Wan', 'Kennedy Town', '堅尼地城'],
  },
  { id: 'admiralty', district: 'central-western', names: ['金鐘', 'Admiralty'] },
  { id: 'causeway-bay', district: 'wan-chai', names: ['銅鑼灣', '銅記', 'CWB', 'Causeway Bay'] },
  { id: 'happy-valley', district: 'wan-chai', names: ['跑馬地', 'Happy Valley'] },
  { id: 'north-point', district: 'eastern', names: ['北角', 'North Point'] },
  { id: 'quarry-bay', district: 'eastern', names: ['鰂魚涌', '太古', 'Quarry Bay', 'Taikoo'] },
  { id: 'shau-kei-wan', district: 'eastern', names: ['筲箕灣', 'Shau Kei Wan'] },
  { id: 'chai-wan', district: 'eastern', names: ['柴灣', 'Chai Wan'] },
  { id: 'aberdeen', district: 'southern', names: ['香港仔', 'Aberdeen'] },
  { id: 'stanley', district: 'southern', names: ['赤柱', 'Stanley'] },
  { id: 'mong-kok', district: 'yau-tsim-mong', names: ['旺角', 'MK', 'Mongkok', 'Mong Kok'] },
  {
    id: 'tsim-sha-tsui',
    district: 'yau-tsim-mong',
    names: ['尖沙咀', '尖咀', 'TST', 'Tsim Sha Tsui', 'Tsimshatsui'],
  },
  { id: 'yau-ma-tei', district: 'yau-tsim-mong', names: ['油麻地', 'Yaumatei', 'Yau Ma Tei'] },
  { id: 'jordan', district: 'yau-tsim-mong', names: ['佐敦', 'Jordan'] },
  { id: 'tai-kok-tsui', district: 'yau-tsim-mong', names: ['大角咀', 'Tai Kok Tsui'] },
  { id: 'prince-edward', district: 'yau-tsim-mong', names: ['太子', 'Prince Edward'] },
  {
    id: 'sham-shui-po-area',
    district: 'sham-shui-po',
    names: ['深水埗', '深水埔', 'Sham Shui Po'],
  },
  { id: 'cheung-sha-wan', district: 'sham-shui-po', names: ['長沙灣', 'Cheung Sha Wan'] },
  {
    id: 'lai-chi-kok',
    district: 'sham-shui-po',
    names: ['荔枝角', '美孚', 'Lai Chi Kok', 'Mei Foo'],
  },
  { id: 'kowloon-tong', district: 'kowloon-city', names: ['九龍塘', 'Kowloon Tong'] },
  { id: 'hung-hom', district: 'kowloon-city', names: ['紅磡', 'Hung Hom', '黃埔', 'Whampoa'] },
  { id: 'to-kwa-wan', district: 'kowloon-city', names: ['土瓜灣', 'To Kwa Wan'] },
  { id: 'ho-man-tin', district: 'kowloon-city', names: ['何文田', 'Ho Man Tin'] },
  {
    id: 'kowloon-city-area',
    district: 'kowloon-city',
    names: ['九龍城', '九龍仔', 'Kowloon City', 'Kowloon Tsai'],
  },
  { id: 'diamond-hill', district: 'wong-tai-sin', names: ['鑽石山', 'Diamond Hill'] },
  { id: 'lok-fu', district: 'wong-tai-sin', names: ['樂富', 'Lok Fu'] },
  { id: 'kwun-tong-area', district: 'kwun-tong', names: ['觀塘', '官塘', 'Kwun Tong'] },
  { id: 'kowloon-bay', district: 'kwun-tong', names: ['九龍灣', 'Kowloon Bay'] },
  { id: 'lam-tin', district: 'kwun-tong', names: ['藍田', 'Lam Tin'] },
  { id: 'kwai-chung', district: 'kwai-tsing', names: ['葵涌', 'Kwai Chung'] },
  { id: 'tsing-yi', district: 'kwai-tsing', names: ['青衣', 'Tsing Yi'] },
  {
    id: 'tsuen-wan-area',
    district: 'tsuen-wan',
    names: ['荃灣', 'Tsuen Wan', '深井', 'Sham Tseng'],
  },
  { id: 'sha-tin-area', district: 'sha-tin', names: ['沙田', 'Shatin', 'Sha Tin'] },
  { id: 'ma-on-shan', district: 'sha-tin', names: ['馬鞍山', 'Ma On Shan'] },
  { id: 'tai-wai', district: 'sha-tin', names: ['大圍', 'Tai Wai'] },
  {
    id: 'tseung-kwan-o',
    district: 'sai-kung',
    names: ['將軍澳', 'TKO', 'Tseung Kwan O', '調景嶺', 'Tiu Keng Leng'],
  },
  { id: 'sai-kung-area', district: 'sai-kung', names: ['西貢', 'Sai Kung'] },
  { id: 'tin-shui-wai', district: 'yuen-long', names: ['天水圍', 'Tin Shui Wai'] },
  { id: 'yuen-long-area', district: 'yuen-long', names: ['元朗', 'Yuen Long'] },
  { id: 'tuen-mun-area', district: 'tuen-mun', names: ['屯門', 'Tuen Mun'] },
  { id: 'tai-po-area', district: 'tai-po', names: ['大埔', 'Tai Po'] },
  { id: 'sheung-shui', district: 'north', names: ['上水', 'Sheung Shui'] },
  { id: 'fanling', district: 'north', names: ['粉嶺', 'Fanling'] },
  { id: 'tung-chung', district: 'islands', names: ['東涌', 'Tung Chung'] },
  { id: 'discovery-bay', district: 'islands', names: ['愉景灣', 'Discovery Bay'] },
];

const BY_NEIGHBOURHOOD = new Map<string, { neighbourhood: Neighbourhood; district: District }>();
for (const n of NEIGHBOURHOODS) {
  const district = DISTRICTS.find((d) => d.id === n.district);
  if (district === undefined) continue;
  for (const name of n.names) {
    BY_NEIGHBOURHOOD.set(districtKey(name), { neighbourhood: n, district });
  }
}

/** The neighbourhood a label refers to, if this table knows it. */
export function resolveNeighbourhood(label: string): Neighbourhood | undefined {
  return BY_NEIGHBOURHOOD.get(districtKey(label))?.neighbourhood;
}

/** District id, by id string. */
export function districtById(id: string): District | undefined {
  return DISTRICTS.find((d) => d.id === id);
}

/** Every district id, for the tool's enum. */
export const DISTRICT_IDS = DISTRICTS.map((d) => d.id) as readonly string[];

/**
 * Resolve a district name OR a neighbourhood within one. Returns which kind of
 * match it was, so the caller can tell the user "Mong Kok is in Yau Tsim Mong"
 * rather than silently widening the search.
 */
export function resolvePlace(
  value: string,
): { district: District; matchedAs: 'district' | 'neighbourhood' } | undefined {
  const direct = resolveDistrict(value);
  if (direct !== undefined) return { district: direct, matchedAs: 'district' };
  const viaNeighbourhood = BY_NEIGHBOURHOOD.get(districtKey(value));
  if (viaNeighbourhood !== undefined)
    return { district: viaNeighbourhood.district, matchedAs: 'neighbourhood' };
  return undefined;
}
