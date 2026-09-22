import {
  type BankLocation,
  type HkmaClient,
  HkmaError,
  LIMIT_DEFAULT,
  LIMIT_MAX,
  LocationQueryError,
  type LocationType,
  searchLocations,
  type TypedRecords,
} from '@hk-bank-mcp/hkma-client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const ENDPOINT_BY_TYPE = {
  atm: 'atmLocator',
  branch: 'branchLocator',
  self_service: 'selfServiceLocator',
} as const satisfies Record<LocationType, string>;

const inputSchema = {
  type: z
    .enum(['atm', 'branch', 'self_service', 'any'])
    .default('any')
    .describe(
      'What kind of place. "atm" for cash machines, "branch" for staffed branches, ' +
        '"self_service" for self-service banking points, "any" for all three.',
    ),
  place: z
    .string()
    .optional()
    .describe(
      'District or neighbourhood, English or Chinese. Accepts what people actually say — ' +
        '"Mong Kok", "旺角", "Causeway Bay", "沙田", "TST" — not just the 18 official ' +
        'district names. Omit to search all of Hong Kong.',
    ),
  bank: z
    .string()
    .optional()
    .describe(
      'Bank name in any common form: "HSBC", "滙豐", "Hang Seng", "恒生", "BOC", "中銀". ' +
        'Omit to search every bank. An ambiguous name returns the candidates rather than guessing.',
    ),
  currency: z
    .string()
    .optional()
    .describe('Only machines dispensing this currency, e.g. "RMB" or "USD". ATMs only.'),
  near: z
    .object({ lat: z.number(), lon: z.number() })
    .optional()
    .describe(
      'Reference point. When given, results are sorted nearest first and each carries ' +
        'distance_km. Use when the user asks for the closest one.',
    ),
  radius_km: z.number().positive().optional().describe('Only with near: maximum distance in km.'),
  limit: z
    .number()
    .int()
    .positive()
    .default(LIMIT_DEFAULT)
    .describe(`How many to return. Default ${LIMIT_DEFAULT}, capped at ${LIMIT_MAX}.`),
  response_format: z
    .enum(['concise', 'detailed'])
    .default('concise')
    .describe(
      '"concise" returns bank, district, address and hours. "detailed" adds currencies, ' +
        'card networks, barrier-free access and machine type. Prefer concise.',
    ),
  lang: z.enum(['en', 'tc']).default('en').describe('Language for names. "tc" for Chinese.'),
};

export function registerFindBankLocation(server: McpServer, client: HkmaClient): void {
  server.registerTool(
    'hk_find_bank_location',
    {
      title: 'Find a Hong Kong bank ATM, branch or self-service point',
      description:
        'Find ATMs, bank branches and self-service banking points anywhere in Hong Kong, ' +
        'filtered by district or neighbourhood, bank, currency, or distance from a point. ' +
        'Data comes from the HKMA public register.\n\n' +
        'Every filter is optional, but a search with no filter at all matches thousands of ' +
        'places and will ask you to narrow it rather than returning a misleading sample.\n\n' +
        'Examples:\n' +
        '- "邊度有恒生分行喺沙田?" → {type:"branch", place:"沙田", bank:"恒生"}\n' +
        '- "Closest ATM that takes RMB?" → {type:"atm", currency:"RMB", near:{lat:22.28,lon:114.16}}\n\n' +
        'Use hk_get_bank_contact instead when the user wants a phone number rather than a place.',
      inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const wanted: LocationType[] =
        args.type === 'any' ? ['atm', 'branch', 'self_service'] : [args.type];

      const sources: TypedRecords[] = [];
      const unavailable: string[] = [];
      let stale = false;
      let maxAgeSeconds = 0;

      for (const type of wanted) {
        try {
          const page = await client.fetchAll(ENDPOINT_BY_TYPE[type], { lang: args.lang });
          sources.push({ type, records: page.records as BankLocation[] });
          if (page.stale) {
            stale = true;
            maxAgeSeconds = Math.max(maxAgeSeconds, page.ageSeconds);
          }
        } catch (error) {
          // One dataset being down must not fail the whole search — the other
          // two still answer most questions.
          unavailable.push(type);
          if (!(error instanceof HkmaError)) throw error;
        }
      }

      if (sources.length === 0) {
        return errorResult(
          'The HKMA location data could not be retrieved.',
          'The official source is not responding. Tell the user it is temporarily ' +
            'unavailable and offer to retry. Do not recall an address from memory.',
        );
      }

      try {
        const result = searchLocations(sources, {
          type: args.type,
          ...(args.place === undefined ? {} : { place: args.place }),
          ...(args.bank === undefined ? {} : { bank: args.bank }),
          ...(args.currency === undefined ? {} : { currency: args.currency }),
          ...(args.near === undefined ? {} : { near: args.near }),
          ...(args.radius_km === undefined ? {} : { radiusKm: args.radius_km }),
          limit: args.limit,
          format: args.response_format,
          lang: args.lang,
        });

        const payload = {
          ...result,
          ...(stale
            ? {
                stale: true,
                as_of_hours_ago: Math.round(maxAgeSeconds / 3600),
                staleness_note:
                  'Served from cache because the HKMA API is unavailable. Tell the user how old this is.',
              }
            : {}),
          ...(unavailable.length > 0 ? { unavailable_types: unavailable } : {}),
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload as unknown as Record<string, unknown>,
        };
      } catch (error) {
        if (error instanceof LocationQueryError) {
          return errorResult(error.message, error.agentHint, error.candidates);
        }
        throw error;
      }
    },
  );
}

function errorResult(message: string, agentHint: string, candidates?: string[]) {
  const payload = {
    error: message,
    hint: agentHint,
    ...(candidates === undefined ? {} : { candidates }),
  };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}
