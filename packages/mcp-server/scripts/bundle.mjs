#!/usr/bin/env node
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
/**
 * Bundles the server for npm publish.
 *
 * The regular `tsc --build` output still references the workspace package
 * `@hk-bank-mcp/hkma-client` via pnpm's `workspace:*` protocol, which npm does
 * not understand. Rather than publish two packages and rewrite that protocol,
 * everything — hkma-client, zod, the MCP SDK — is bundled into one file with
 * no runtime dependencies at all. A published package that npx has to resolve
 * nothing for is one less way for a stranger's install to fail (#38).
 */
import { build } from 'esbuild';

const outfile = fileURLToPath(new URL('../dist/index.js', import.meta.url));

await build({
  entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // The SDK and zod are bundled too, so the published package has zero
  // runtime dependencies — nothing for npx to fail to resolve.
  //
  // No banner here: src/index.ts already carries its own shebang. esbuild
  // preserves a leading shebang from the entry point automatically, and
  // adding a second one via banner produced two shebang lines — Node's ESM
  // loader accepts a shebang only as the literal first line of the file, so
  // the second line broke with "Invalid or unexpected token" the moment the
  // bundle was actually run outside this repo (caught by testing the
  // installed tarball standalone, not by any unit test).
  external: [],
  sourcemap: false,
  logLevel: 'info',
});

chmodSync(outfile, 0o755);
console.log(`bundled → ${outfile}`);
