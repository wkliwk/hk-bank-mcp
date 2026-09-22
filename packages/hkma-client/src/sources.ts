/**
 * The upstream data sources this project reads from.
 *
 * Kept as data rather than prose so the MCP layer can report it to an agent
 * (see the `hk_server_info` tool) and so the README table can be generated
 * from one place instead of drifting.
 */

export interface DataSource {
  /** Stable identifier used in tool responses to attribute a figure to its origin. */
  readonly id: string;
  readonly name: string;
  readonly publisher: string;
  readonly baseUrl: string;
  /** True when no API key, registration or auth header is required. */
  readonly requiresAuth: boolean;
  /**
   * How fresh the data actually is, verified during the spike (issue #1) rather
   * than taken from the publisher's documentation.
   */
  readonly freshness: string;
  readonly docsUrl: string;
}

export const HKMA_BASE_URL = 'https://api.hkma.gov.hk/public' as const;

export const DATA_SOURCES: readonly DataSource[] = [
  {
    id: 'hkma-daily-monetary',
    name: 'HKMA Daily Monetary Statistics',
    publisher: 'Hong Kong Monetary Authority',
    baseUrl: `${HKMA_BASE_URL}/market-data-and-statistics/daily-monetary-statistics`,
    requiresAuth: false,
    freshness: 'next business day; overnight and 1-month HIBOR only',
    docsUrl: 'https://apidocs.hkma.gov.hk/documentation/',
  },
  {
    id: 'hkma-monthly-bulletin',
    name: 'HKMA Monthly Statistical Bulletin',
    publisher: 'Hong Kong Monetary Authority',
    baseUrl: `${HKMA_BASE_URL}/market-data-and-statistics/monthly-statistical-bulletin`,
    requiresAuth: false,
    freshness: 'lags roughly three weeks; carries the full HIBOR tenor curve',
    docsUrl: 'https://apidocs.hkma.gov.hk/documentation/',
  },
  {
    id: 'hkma-bank-svf-info',
    name: 'HKMA Bank & SVF Information',
    publisher: 'Hong Kong Monetary Authority',
    baseUrl: `${HKMA_BASE_URL}/bank-svf-info`,
    requiresAuth: false,
    freshness: 'updated as banks report; ATM/branch registers and the published scam list',
    docsUrl: 'https://apidocs.hkma.gov.hk/documentation/',
  },
];

export function findDataSource(id: string): DataSource | undefined {
  return DATA_SOURCES.find((source) => source.id === id);
}
