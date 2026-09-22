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
 * Neighbourhoods mapped to the district that contains them.
 *
 * Nobody asks "where is an ATM in Yau Tsim Mong" — they ask about Mong Kok.
 * The API only files rows by district, so a question phrased the way people
 * actually speak fails against the raw data unless it is translated first.
 */
export const NEIGHBOURHOODS: Readonly<Record<string, string>> = {
  // Central & Western
  中環: 'central-western',
  上環: 'central-western',
  西環: 'central-western',
  堅尼地城: 'central-western',
  金鐘: 'central-western',
  central: 'central-western',
  sheungwan: 'central-western',
  admiralty: 'central-western',
  kennedytown: 'central-western',
  // Wan Chai
  銅鑼灣: 'wan-chai',
  銅記: 'wan-chai',
  cwb: 'wan-chai',
  跑馬地: 'wan-chai',
  causewaybay: 'wan-chai',
  happyvalley: 'wan-chai',
  // Eastern
  北角: 'eastern',
  太古: 'eastern',
  鰂魚涌: 'eastern',
  筲箕灣: 'eastern',
  柴灣: 'eastern',
  northpoint: 'eastern',
  taikoo: 'eastern',
  quarrybay: 'eastern',
  shaukeiwan: 'eastern',
  chaiwan: 'eastern',
  // Southern
  香港仔: 'southern',
  赤柱: 'southern',
  淺水灣: 'southern',
  aberdeen: 'southern',
  stanley: 'southern',
  repulsebay: 'southern',
  // Yau Tsim Mong
  旺角: 'yau-tsim-mong',
  尖沙咀: 'yau-tsim-mong',
  尖咀: 'yau-tsim-mong',
  尖沙嘴: 'yau-tsim-mong',
  mk: 'yau-tsim-mong',
  油麻地: 'yau-tsim-mong',
  佐敦: 'yau-tsim-mong',
  大角咀: 'yau-tsim-mong',
  mongkok: 'yau-tsim-mong',
  tsimshatsui: 'yau-tsim-mong',
  tst: 'yau-tsim-mong',
  yaumatei: 'yau-tsim-mong',
  jordan: 'yau-tsim-mong',
  // Sham Shui Po
  深水埗: 'sham-shui-po',
  長沙灣: 'sham-shui-po',
  美孚: 'sham-shui-po',
  石硤尾: 'sham-shui-po',
  cheungshawan: 'sham-shui-po',
  meifoo: 'sham-shui-po',
  // Kowloon City
  九龍塘: 'kowloon-city',
  紅磡: 'kowloon-city',
  土瓜灣: 'kowloon-city',
  何文田: 'kowloon-city',
  kowloontong: 'kowloon-city',
  hunghom: 'kowloon-city',
  // Wong Tai Sin
  鑽石山: 'wong-tai-sin',
  樂富: 'wong-tai-sin',
  慈雲山: 'wong-tai-sin',
  diamondhill: 'wong-tai-sin',
  lokfu: 'wong-tai-sin',
  // Kwun Tong
  觀塘: 'kwun-tong',
  九龍灣: 'kwun-tong',
  牛頭角: 'kwun-tong',
  藍田: 'kwun-tong',
  kowloonbay: 'kwun-tong',
  ngautaukok: 'kwun-tong',
  lamtin: 'kwun-tong',
  // Kwai Tsing
  葵涌: 'kwai-tsing',
  青衣: 'kwai-tsing',
  kwaichung: 'kwai-tsing',
  tsingyi: 'kwai-tsing',
  // Tsuen Wan
  荃灣: 'tsuen-wan',
  深井: 'tsuen-wan',
  // Sha Tin
  沙田: 'sha-tin',
  馬鞍山: 'sha-tin',
  大圍: 'sha-tin',
  火炭: 'sha-tin',
  mataunshan: 'sha-tin',
  taiwai: 'sha-tin',
  // Sai Kung
  將軍澳: 'sai-kung',
  西貢: 'sai-kung',
  tseungkwano: 'sai-kung',
  tko: 'sai-kung',
  // Yuen Long
  天水圍: 'yuen-long',
  元朗: 'yuen-long',
  tinshuiwai: 'yuen-long',
  // Tuen Mun
  屯門: 'tuen-mun',
  // Tai Po
  大埔: 'tai-po',
  // North
  上水: 'north',
  粉嶺: 'north',
  sheungshui: 'north',
  fanling: 'north',
  // Islands
  東涌: 'islands',
  tungchung: 'islands',
  discoverybay: 'islands',
};

const BY_NEIGHBOURHOOD = new Map<string, District>();
for (const [place, districtId] of Object.entries(NEIGHBOURHOODS)) {
  const district = DISTRICTS.find((d) => d.id === districtId);
  if (district !== undefined) BY_NEIGHBOURHOOD.set(districtKey(place), district);
}

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
    return { district: viaNeighbourhood, matchedAs: 'neighbourhood' };
  return undefined;
}
