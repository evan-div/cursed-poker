import { describe, expect, it } from 'vitest';
import { ConfigError, readConfig } from './config.js';

const DIST = '/srv/client/dist';
const read = (env: Record<string, string | undefined>, argv: string[] = []) =>
  readConfig(env, argv, { clientDist: DIST });
const SECRET = 'a-session-secret-that-is-long-enough';

describe('server configuration', () => {
  it('is a development server unless told otherwise', () => {
    const config = read({});
    expect(config.production).toBe(false);
    expect(config.port).toBe(3001);
    expect(config.clientDist).toBeNull();
    expect(config.trustedProxies).toBe(0);
    expect(config.sessionSecret).toBeNull();
  });

  it('is production by flag or by environment', () => {
    expect(read({ SESSION_SECRET: SECRET }, ['--production']).production).toBe(true);
    expect(read({ SESSION_SECRET: SECRET, NODE_ENV: 'production' }).production).toBe(true);
  });

  it('serves the built client in production, from where it was built', () => {
    expect(read({ SESSION_SECRET: SECRET }, ['--production']).clientDist).toBe(DIST);
    expect(read({ SESSION_SECRET: SECRET, CLIENT_DIST: '/elsewhere' }, ['--production']).clientDist).toBe('/elsewhere');
  });

  it('refuses to run in production without a session secret', () => {
    // Without one the server invents a secret at boot, and every restart
    // silently throws every player out of their seat. In development that is a
    // warning; on a real deployment it has to be a refusal.
    expect(() => read({}, ['--production'])).toThrow(ConfigError);
    expect(() => read({}, ['--production'])).toThrow(/SESSION_SECRET/);
    expect(() => read({ SESSION_SECRET: 'short' }, ['--production'])).toThrow(/at least/);
  });

  it('trusts no proxy unless asked to', () => {
    expect(read({ TRUST_PROXY: '0' }).trustedProxies).toBe(0);
    expect(read({ TRUST_PROXY: 'false' }).trustedProxies).toBe(0);
    expect(read({ TRUST_PROXY: '' }).trustedProxies).toBe(0);
    expect(read({ TRUST_PROXY: '1' }).trustedProxies).toBe(1);
    expect(read({ TRUST_PROXY: 'true' }).trustedProxies).toBe(1);
    expect(read({ TRUST_PROXY: '2' }).trustedProxies).toBe(2);
  });

  it('says so when a setting makes no sense, rather than guessing', () => {
    expect(() => read({ TRUST_PROXY: 'yes please' })).toThrow(/TRUST_PROXY/);
    expect(() => read({ TRUST_PROXY: '-1' })).toThrow(/TRUST_PROXY/);
    expect(() => read({ PORT: 'eighty' })).toThrow(/PORT/);
    expect(() => read({ PORT: '70000' })).toThrow(/PORT/);
    expect(() => read({ ACTION_TIMEOUT_MS: 'soon' })).toThrow(/ACTION_TIMEOUT_MS/);
  });

  it('carries the development switches through', () => {
    const config = read({ DEV_FAST: '1', ACTION_TIMEOUT_MS: '600000', STRESS_TELEMETRY_DIR: '.telemetry', PORT: '8080' });
    expect(config.fast).toBe(true);
    expect(config.actionTimeoutMs).toBe(600_000);
    expect(config.stressTelemetryDir).toBe('.telemetry');
    expect(config.port).toBe(8080);
  });

  it('takes an explicit client origin, for a client hosted somewhere else', () => {
    expect(read({ CLIENT_ORIGIN: 'https://cards.example' }).clientOrigin).toBe('https://cards.example');
    expect(read({}).clientOrigin).toBeNull();
  });
});
