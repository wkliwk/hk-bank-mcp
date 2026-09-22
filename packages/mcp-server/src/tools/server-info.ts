import { DATA_SOURCES } from '@hk-bank-mcp/hkma-client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_NAME, SERVER_VERSION } from '../meta.js';

/** Shape returned by `hk_server_info`, exported so tests can assert on it. */
export interface ServerInfo {
  name: string;
  version: string;
  data_sources: {
    id: string;
    name: string;
    publisher: string;
    requires_auth: boolean;
    freshness: string;
  }[];
  capabilities: string[];
  /** When this response was produced. Static data, so it is always now. */
  as_of: string;
  limitations: string[];
}

export function buildServerInfo(): ServerInfo {
  return {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    data_sources: DATA_SOURCES.map((source) => ({
      id: source.id,
      name: source.name,
      publisher: source.publisher,
      requires_auth: source.requiresAuth,
      freshness: source.freshness,
    })),
    capabilities: ['Report which data sources are configured and how fresh each one is'],
    as_of: new Date().toISOString(),
    limitations: [
      'Reads published data only — no bank credentials, no login, no account balances',
      'Published rates are indicative and are not an offer or financial advice',
    ],
  };
}

export function registerServerInfo(server: McpServer): void {
  server.registerTool(
    'hk_server_info',
    {
      title: 'Hong Kong bank server info',
      description:
        'Report this server version and the official data sources it reads, including how ' +
        'fresh each source is. Call this when you need to know what this server can answer, ' +
        'or to explain to the user where a figure came from.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const info = buildServerInfo();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }],
        structuredContent: info as unknown as Record<string, unknown>,
      };
    },
  );
}
