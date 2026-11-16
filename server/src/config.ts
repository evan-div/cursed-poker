/**
 * What the server was told to be.
 *
 * Read once, from the environment and the command line, into a plain object —
 * and refused, with a sentence saying why, if it does not make sense. A server
 * that guesses at a misspelt setting starts fine and is wrong in a way nobody
 * finds until an evening is underway.
 *
 * Pure: it is handed the environment rather than reaching for it, so every
 * rule here has a test.
 */

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export interface ServerConfig {
  /**
   * A real deployment rather than a desk.
   *
   * It changes three things: the built client is served from this process, a
   * session secret is required instead of invented, and the development
   * conveniences that assume `localhost` stop being assumed.
   */
  production: boolean;
  port: number;
  /** Signs reconnect tokens. Null in development, where one is made up at boot. */
  sessionSecret: string | null;
  /** An origin allowed to connect from elsewhere, for a client hosted separately. */
  clientOrigin: string | null;
  /** The folder the built client is served from, or null to serve only the socket. */
  clientDist: string | null;
  /** How many reverse proxies stand in front of this server. See `client-address.ts`. */
  trustedProxies: number;
  /** Short stacks and quick clocks. A development switch; see `main.ts`. */
  fast: boolean;
  /** Overrides the action clock, in milliseconds. Zero leaves it alone. */
  actionTimeoutMs: number;
  stressTelemetryDir: string | null;
}

type Env = Readonly<Record<string, string | undefined>>;

/** The shortest secret worth signing with. `SessionManager` enforces the same. */
const SECRET_MIN_LENGTH = 16;

export function readConfig(env: Env, argv: readonly string[], defaults: { clientDist: string }): ServerConfig {
  const production = argv.includes('--production') || env['NODE_ENV'] === 'production';

  const sessionSecret = env['SESSION_SECRET'] || null;
  if (production) {
    if (!sessionSecret) {
      throw new ConfigError(
        'SESSION_SECRET is required in production. Without it the server invents one at every start, ' +
          'and every restart throws every player out of their seat. Generate one with:\n' +
          '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }
    if (sessionSecret.length < SECRET_MIN_LENGTH) {
      throw new ConfigError(`SESSION_SECRET must be at least ${SECRET_MIN_LENGTH} characters.`);
    }
  }

  return {
    production,
    port: wholeNumber(env, 'PORT', 3001, 0, 65_535),
    sessionSecret,
    clientOrigin: env['CLIENT_ORIGIN'] || null,
    clientDist: env['CLIENT_DIST'] || (production ? defaults.clientDist : null),
    trustedProxies: proxies(env['TRUST_PROXY']),
    fast: env['DEV_FAST'] === '1',
    actionTimeoutMs: wholeNumber(env, 'ACTION_TIMEOUT_MS', 0, 0, Number.MAX_SAFE_INTEGER),
    stressTelemetryDir: env['STRESS_TELEMETRY_DIR'] || null,
  };
}

function wholeNumber(env: Env, name: string, fallback: number, least: number, most: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < least || value > most) {
    throw new ConfigError(`${name} must be a whole number from ${least} to ${most}, not "${raw}".`);
  }
  return value;
}

/**
 * `TRUST_PROXY`: how many proxies in front of this server to believe.
 *
 * A count rather than a yes or no, because the answer is different behind one
 * platform proxy and behind a CDN in front of one — and getting it one too
 * high hands the choice of address back to the client.
 */
function proxies(raw: string | undefined): number {
  if (raw === undefined || raw === '' || raw === 'false') return 0;
  if (raw === 'true') return 1;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 8) {
    throw new ConfigError(
      `TRUST_PROXY must be the number of reverse proxies in front of this server (0 for none), not "${raw}".`,
    );
  }
  return value;
}
