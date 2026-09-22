import { describe, expect, it } from 'vitest';
import { SERVER_NAME, SERVER_VERSION } from '../src/meta.js';
import { buildServerInfo } from '../src/tools/server-info.js';

describe('hk_server_info', () => {
  it('reports the server identity', () => {
    const info = buildServerInfo();
    expect(info.name).toBe(SERVER_NAME);
    expect(info.version).toBe(SERVER_VERSION);
  });

  it('lists every data source with its freshness', () => {
    const info = buildServerInfo();
    expect(info.data_sources.length).toBeGreaterThan(0);
    for (const source of info.data_sources) {
      expect(source.id).toBeTruthy();
      expect(source.publisher).toBeTruthy();
      expect(source.freshness).toBeTruthy();
      expect(source.requires_auth).toBe(false);
    }
  });

  it('states the no-credentials limitation, which the README promises', () => {
    const info = buildServerInfo();
    expect(info.limitations.join(' ')).toMatch(/no bank credentials/i);
  });

  it('serialises to JSON without throwing', () => {
    expect(() => JSON.stringify(buildServerInfo())).not.toThrow();
  });
});
