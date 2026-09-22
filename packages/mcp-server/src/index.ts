#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION } from './meta.js';
import { registerServerInfo } from './tools/server-info.js';

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  registerServerInfo(server);

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  // stdout is the MCP transport — anything written there that is not a protocol
  // message corrupts the stream, so diagnostics must go to stderr.
  await server.connect(new StdioServerTransport());
  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
