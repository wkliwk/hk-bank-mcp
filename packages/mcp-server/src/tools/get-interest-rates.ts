import {
  buildHkdSeries,
  filterRange,
  type HkmaClient,
  HkmaError,
  isHiborTenor,
  isHkdTenor,
  mergeHiborSeries,
  RAW_ROW_THRESHOLD,
  RateDateError,
  ratesFrom,
  restrictToLatestWhenNoRange,
  summarise,
  validateDate,
} from '@hk-bank-mcp/hkma-client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolResult } from './find-bank-location.js';

export const inputShape = {
  rate_type: z
    .enum(['hibor', 'hkd_reference'])
    .describe(
      '"hibor" for Hong Kong Interbank Offered Rate. "hkd_reference" for HKD deposit/lending ' +
        'reference rates including the best lending (prime) rate.',
    ),
  tenor: z
    .enum(['overnight', '1w', '1m', '3m', '6m', '9m', '12m'])
    .describe(
      'Interest period. hkd_reference does not have "overnight" or "9m" — omit tenor for ' +
        'hkd_reference to get the best lending rate and savings rate instead.',
    )
    .optional(),
  from: z
    .string()
    .optional()
    .describe('Start date, YYYY-MM-DD. Omit both from and to for just the latest figure.'),
  to: z.string().optional().describe('End date, YYYY-MM-DD. Defaults to today when from is given.'),
  detail: z
    .boolean()
    .default(false)
    .describe(
      `Return every point in the range instead of a summary. Ranges over ${RAW_ROW_THRESHOLD} ` +
        'points are summarised by default regardless of this flag being false — set true to ' +
        'force raw rows for a specific comparison, but prefer the summary for trend questions.',
    ),
};

export function registerGetInterestRates(server: McpServer, client: HkmaClient): void {
  server.registerTool(
    'hk_get_interest_rates',
    {
      title: 'Hong Kong interest rates',
      description:
        'HIBOR and HKD reference rates from official HKMA sources. Two upstream sources back ' +
        'HIBOR with a genuine trade-off: one is fresh (published next business day) but only ' +
        'has overnight and 1-month; the other has every tenor but lags roughly three weeks. ' +
        'This tool merges them and reports which date each figure actually came from — never ' +
        "imply a rate is today's without checking as_of.\n\n" +
        'With no from/to, returns the single latest figure. With a range, returns a trend ' +
        `summary (latest/min/max/average/change) once it exceeds ${RAW_ROW_THRESHOLD} points; ` +
        'shorter ranges or detail:true return every point.\n\n' +
        'Examples:\n' +
        '- "3個月HIBOR而家幾多?" → {rate_type:"hibor", tenor:"3m"}\n' +
        '- "3個月HIBOR過去一個月走勢點?" → {rate_type:"hibor", tenor:"3m", from:"<30 days ago>"}\n' +
        '- "最優惠利率而家幾多?" → {rate_type:"hkd_reference"} (best_lending_rate in the reply)',
      inputSchema: inputShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => handleGetInterestRates(client, args),
  );
}

/** Parsed arguments, as the SDK hands them to the handler. */
export type GetInterestRatesArgs = z.infer<z.ZodObject<typeof inputShape>>;

/**
 * Extracted from registerTool so the behaviour is testable without a server
 * (#29): source selection, date validation, latest-vs-range, error mapping.
 */
export async function handleGetInterestRates(
  client: HkmaClient,
  args: GetInterestRatesArgs,
): Promise<ToolResult> {
  {
    const today = new Date().toISOString().slice(0, 10);
    const rates = ratesFrom(client);

    let from: string | undefined;
    let to: string | undefined;
    try {
      if (args.from !== undefined) from = validateDate(args.from, 'from', today);
      if (args.to !== undefined) to = validateDate(args.to, 'to', today);
      if (from !== undefined && to === undefined) to = today;
      if (from !== undefined && to !== undefined && from > to) {
        return errorResult(
          `from (${from}) is after to (${to}).`,
          'Swap the dates or drop one — from must not be later than to.',
        );
      }
    } catch (error) {
      if (error instanceof RateDateError) return errorResult(error.message, error.agentHint);
      throw error;
    }

    try {
      let series: ReturnType<typeof mergeHiborSeries>;
      let sourcesStale = false;

      if (args.rate_type === 'hibor') {
        const tenor = args.tenor ?? '3m';
        if (!isHiborTenor(tenor)) {
          return errorResult(
            `"${tenor}" is not a HIBOR tenor.`,
            'Use one of: overnight, 1w, 1m, 3m, 6m, 9m, 12m.',
          );
        }
        const [monthly, daily] = await Promise.all([
          rates.hiborDaily(from),
          rates.dailyMonetary(from),
        ]);
        sourcesStale = monthly.stale || daily.stale;
        series = mergeHiborSeries(monthly.records, daily.records, tenor);
        series = filterRange(series, from, to, false);
      } else {
        const tenor = args.tenor;
        if (tenor !== undefined && !isHkdTenor(tenor)) {
          return errorResult(
            `"${tenor}" is not an HKD reference tenor.`,
            'Use one of: 1w, 1m, 3m, 6m, 12m — or omit tenor for the prime/savings rate.',
          );
        }
        const source = await rates.hkdReference(from);
        sourcesStale = source.stale;
        if (tenor === undefined) {
          // No tenor: the question is almost always about the prime rate.
          const points = source.records
            .filter((r) => typeof r.best_lending_rate === 'number')
            .map((r) => ({
              date: r.effect_date,
              value: r.best_lending_rate as number,
              sourceId: 'hkma-monthly-bulletin',
            }))
            .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
          series = filterRange(points, from, to, true);
        } else {
          series = buildHkdSeries(source.records, tenor);
          series = filterRange(series, from, to, true);
        }
      }

      // 冇 from/to = 「而家幾多」,DoD 寫明要淨係答最新一個點,唔可以夾埋
      // 一堆冇人問過嘅歷史 min/max/average。呢個判斷同 restrictToLatestWhenNoRange
      // 本身分開咗做 pure function,方便直接 unit test。
      series = restrictToLatestWhenNoRange(
        series,
        args.from !== undefined || args.to !== undefined,
      );

      if (series.length === 0) {
        return errorResult(
          'No data available for that tenor and date range.',
          'HKMA may not publish this combination, or the range predates available records. ' +
            'Try a wider range or a different tenor.',
        );
      }

      const summary = summarise(series);
      const wantRaw = args.detail === true || series.length <= RAW_ROW_THRESHOLD;
      const asOfDate = series[series.length - 1]?.date;

      const payload = {
        rate_type: args.rate_type,
        ...(args.tenor === undefined ? {} : { tenor: args.tenor }),
        as_of: asOfDate,
        latest: summary?.latest,
        ...(summary === undefined || series.length <= 1
          ? {}
          : {
              min: summary.min,
              max: summary.max,
              average: summary.average,
              change: summary.change,
            }),
        points_count: series.length,
        ...(wantRaw ? { points: series } : {}),
        ...(sourcesStale
          ? {
              stale: true,
              staleness_note:
                'One or more underlying HKMA sources is currently unreachable; this uses cached data.',
            }
          : {}),
        note:
          args.rate_type === 'hibor'
            ? "HIBOR merges two HKMA sources; check each point's date before treating it as current."
            : 'Effective-date series: a rate applies from its date until the next entry changes it.',
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    } catch (error) {
      if (error instanceof HkmaError) {
        return errorResult(error.toAgentMessage(), error.agentHint);
      }
      throw error;
    }
  }
}

function errorResult(message: string, agentHint: string) {
  const payload = { error: message, hint: agentHint };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}
