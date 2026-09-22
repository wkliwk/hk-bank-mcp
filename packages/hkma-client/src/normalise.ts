/**
 * Input normalisation shared by bank and place matching.
 *
 * The design rule here is that anything varying *mechanically* is handled by a
 * rule, and only things varying *semantically* go in a list. Enumerating
 * spellings does not scale: listing 恒生 and 恆生 separately works for one pair
 * and fails the moment a variant nobody thought of arrives.
 */

/**
 * Variant and simplified characters mapped to one canonical form.
 *
 * Covers the characters that actually appear in Hong Kong bank and place names,
 * not the whole Unicode simplification table — this is a matching aid, not a
 * converter, and a wrong mapping here would silently merge two institutions.
 */
const CHARACTER_VARIANTS: Readonly<Record<string, string>> = {
  // Traditional variants of the same character
  恆: '恒',
  匯: '滙',
  臺: '台',
  // Simplified → traditional, restricted to characters in bank and district names
  丰: '豐',
  国: '國',
  东: '東',
  银: '銀',
  行: '行',
  华: '華',
  侨: '僑',
  兴: '興',
  业: '業',
  务: '務',
  达: '達',
  众: '眾',
  发: '發',
  储: '儲',
  湾: '灣',
  区: '區',
  龙: '龍',
  门: '門',
  长: '長',
  岛: '島',
  荃: '荃',
  观: '觀',
  塘: '塘',
  尖: '尖',
  沙: '沙',
  咀: '咀',
  嘴: '咀',
};

/** Collapse variant and simplified characters onto one form. */
export function canonicaliseCharacters(value: string): string {
  let out = '';
  for (const ch of value) out += CHARACTER_VARIANTS[ch] ?? ch;
  return out;
}

/**
 * Words carrying no identifying information.
 *
 * Stripped so that "恒生bank", "恒生銀行有限公司" and "恒生" reduce to the same key.
 * Every entry must be a word that appears on *many* institutions — a token that
 * distinguishes one bank from another must never be listed here.
 */
const GENERIC_TOKENS: readonly string[] = [
  'banking corporation',
  'corporation',
  'limited',
  'ltd',
  'bank',
  'hong kong',
  'hongkong',
  'asia',
  '有限公司',
  '股份公司',
  '銀行',
  '香港',
  '分行',
];

/**
 * Strict key: canonical characters, lower case, no punctuation or spacing —
 * but generic words kept.
 *
 * Used for exact and alias matching. Stripping generic words here would be
 * unsafe: "中國銀行" would reduce to "中國", which is what someone means when
 * they say any of four Chinese banks, and the match would silently pick one.
 */
export function strictKey(value: string): string {
  return canonicaliseCharacters(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

/**
 * Loose key: strict key with generic words removed as well.
 *
 * Used only for fuzzy matching, where several candidates coming back is the
 * expected outcome and ambiguity is surfaced rather than resolved.
 */
export function matchKey(value: string): string {
  let out = canonicaliseCharacters(value).toLowerCase();
  // Strip before removing separators, so multi-word tokens still match.
  out = out
    .replace(/[()（）,，.。·・\-_/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const token of GENERIC_TOKENS) {
    out = out.split(token).join(' ');
  }
  return out.replace(/[^a-z0-9一-鿿]/g, '');
}

/**
 * Key for a place name. Same as `matchKey` plus the district suffixes, which
 * appear on districts and are sometimes added to neighbourhoods by users.
 */
export function placeKey(value: string): string {
  let out = canonicaliseCharacters(value).toLowerCase().trim();
  out = out.replace(/\s+/g, ' ').replace(/\s*&\s*/g, 'and');
  out = out.replace(/(?<=central)n(?=western)/, 'and');
  out = out.replace(/\s+district$/, '');
  out = out.replace(/區$/, '');
  return out.replace(/[^a-z0-9一-鿿]/g, '');
}
