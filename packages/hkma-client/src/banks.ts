/**
 * Bank name matching.
 *
 * Unlike the district field, bank names in the HKMA data are consistent — 20
 * institutions, spelled the same way on every row, with the English and Chinese
 * datasets agreeing exactly.
 *
 * The problem is different: the published names are the legal ones, and nobody
 * uses them. "HSBC" does not appear anywhere in "The Hongkong and Shanghai
 * Banking Corporation Limited". Neither does "中銀" in "中國銀行(香港)有限公司".
 * Matching therefore needs an alias table, not just a substring search.
 *
 * The English/Chinese pairs below were derived by joining the two language
 * datasets on latitude and longitude. Joining them positionally gives the wrong
 * answer — the API returns the two languages in different row orders.
 */

export interface Bank {
  readonly id: string;
  /** Legal name exactly as the API publishes it in English. */
  readonly en: string;
  /** Legal name exactly as the API publishes it in Chinese. */
  readonly tc: string;
  /** What people actually type. */
  readonly aliases: readonly string[];
}

export const BANKS: readonly Bank[] = [
  {
    id: 'hsbc',
    en: 'The Hongkong and Shanghai Banking Corporation Limited',
    tc: '香港上海滙豐銀行有限公司',
    aliases: ['hsbc', '滙豐', '匯豐', '滙丰', 'hongkong and shanghai banking'],
  },
  {
    id: 'hangseng',
    en: 'Hang Seng Bank Limited',
    tc: '恒生銀行有限公司',
    aliases: ['hang seng', 'hangseng', '恒生', '恆生'],
  },
  {
    id: 'bochk',
    en: 'Bank of China (Hong Kong) Limited',
    tc: '中國銀行(香港)有限公司',
    aliases: ['boc', 'bochk', 'bank of china', '中銀', '中国银行', '中國銀行'],
  },
  {
    id: 'scb',
    en: 'Standard Chartered Bank (Hong Kong) Limited',
    tc: '渣打銀行(香港)有限公司',
    aliases: ['scb', 'standard chartered', '渣打'],
  },
  {
    id: 'bea',
    en: 'The Bank of East Asia Limited',
    tc: '東亞銀行有限公司',
    aliases: ['bea', 'bank of east asia', '東亞', '东亚'],
  },
  {
    id: 'icbc',
    en: 'Industrial and Commercial Bank of China ( Asia ) Limited',
    tc: '中國工商銀行(亞洲)有限公司',
    aliases: ['icbc', 'industrial and commercial', '工商銀行', '工銀', '工商'],
  },
  {
    id: 'citi',
    en: 'Citibank (Hong Kong) Limited',
    tc: '花旗銀行(香港)有限公司',
    aliases: ['citi', 'citibank', '花旗'],
  },
  {
    id: 'bocom',
    en: 'Bank of Communications (Hong Kong) Limited',
    tc: '交通銀行(香港)有限公司',
    aliases: ['bocom', 'bank of communications', '交通銀行', '交行'],
  },
  {
    id: 'dahsing',
    en: 'Dah Sing Bank',
    tc: '大新銀行',
    aliases: ['dah sing', 'dahsing', '大新'],
  },
  {
    id: 'shacom',
    en: 'Shanghai Commercial Bank Limited',
    tc: '上海商業銀行有限公司',
    aliases: ['shacom', 'shanghai commercial', '上海商業', '上商'],
  },
  {
    id: 'ccb',
    en: 'China Construction Bank (Asia)',
    tc: '中國建設銀行(亞洲)',
    aliases: ['ccb', 'china construction', '建設銀行', '建行'],
  },
  {
    id: 'citic',
    en: 'China CITIC Bank International Limited',
    tc: '中信銀行(國際)有限公司',
    aliases: ['citic', 'china citic', '中信'],
  },
  {
    id: 'ncb',
    en: 'Nanyang Commercial Bank',
    tc: '南洋商業銀行',
    aliases: ['ncb', 'nanyang', '南洋'],
  },
  {
    id: 'dbs',
    en: 'DBS Bank (Hong Kong) Limited',
    tc: '星展銀行(香港)有限公司',
    aliases: ['dbs', '星展'],
  },
  {
    id: 'ocbc',
    en: 'OCBC Bank (Hong Kong) Limited',
    tc: '華僑銀行 (香港) 有限公司',
    aliases: ['ocbc', '華僑'],
  },
  {
    id: 'fubon',
    en: 'Fubon Bank (Hong Kong) Limited',
    tc: '富邦銀行(香港)有限公司',
    aliases: ['fubon', '富邦'],
  },
  {
    id: 'chonghing',
    en: 'Chong Hing Bank',
    tc: '創興銀行',
    aliases: ['chong hing', 'chonghing', '創興'],
  },
  {
    id: 'publicbank',
    en: 'Public Bank (Hong Kong) Limited',
    tc: '大眾銀行 (香港) 有限公司',
    aliases: ['public bank', '大眾'],
  },
  {
    id: 'cmbwinglung',
    en: 'CMB WING LUNG BANK',
    tc: '招商永隆銀行',
    aliases: ['wing lung', 'winglung', 'cmb', '永隆', '招商'],
  },
  {
    id: 'chiyu',
    en: 'Chiyu Banking Corporation Limited',
    tc: '集友銀行有限公司',
    aliases: ['chiyu', '集友'],
  },
];

function bankKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Loose key for substring comparison: punctuation and spacing removed. */
function looseKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
}

export interface BankMatch {
  readonly bank: Bank;
  /** `exact` when the input was a legal name or a known alias. */
  readonly matchedAs: 'exact' | 'alias' | 'partial';
}

/**
 * Resolve user input to a bank.
 *
 * Returns every candidate rather than guessing when the input is ambiguous, so
 * the caller can ask which one was meant instead of silently picking one.
 */
export function matchBanks(input: string): BankMatch[] {
  const raw = bankKey(input);
  if (raw.length === 0) return [];
  const loose = looseKey(input);

  const exact: BankMatch[] = [];
  const alias: BankMatch[] = [];
  const partial: BankMatch[] = [];

  for (const bank of BANKS) {
    if (looseKey(bank.en) === loose || looseKey(bank.tc) === loose) {
      exact.push({ bank, matchedAs: 'exact' });
      continue;
    }
    if (bank.aliases.some((a) => looseKey(a) === loose)) {
      alias.push({ bank, matchedAs: 'alias' });
      continue;
    }
    // Substring both ways: "Hang Seng" is inside the legal name, while a typed
    // legal name contains the alias.
    const haystack = `${looseKey(bank.en)} ${looseKey(bank.tc)} ${bank.aliases.map(looseKey).join(' ')}`;
    if (haystack.includes(loose)) partial.push({ bank, matchedAs: 'partial' });
  }

  // Exact beats alias beats partial; a single strong match makes weaker ones noise.
  if (exact.length > 0) return exact;
  if (alias.length > 0) return alias;
  return partial;
}

/** The single bank meant, or undefined when there is no match or several. */
export function resolveBank(input: string): Bank | undefined {
  const matches = matchBanks(input);
  return matches.length === 1 ? matches[0]?.bank : undefined;
}

/** Look up the canonical record for a name exactly as the API publishes it. */
export function bankByPublishedName(name: string): Bank | undefined {
  const loose = looseKey(name);
  return BANKS.find((b) => looseKey(b.en) === loose || looseKey(b.tc) === loose);
}

export function bankNames(lang: 'en' | 'tc' = 'en'): string[] {
  return BANKS.map((b) => (lang === 'tc' ? b.tc : b.en));
}
