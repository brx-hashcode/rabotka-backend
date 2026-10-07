// Shared guard for the test-data seeds (seed-agent-feed, seed-agent): they
// write fictitious data and must never reach production.
//
// Allowed: a local database (localhost, or `postgres` from the dev
// docker-compose), or the develop environment's container (APP_ENV=develop,
// set by deploy-develop.yml). Always refused: APP_ENV=prod.
// No imports from src/: these scripts also run in the image, which has no src/.

const LOCAL_HOSTS = ['localhost', '127.0.0.1', 'postgres'];

/** Returns DATABASE_URL once it is known to be a dev database; throws otherwise. */
export function devDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? '';
  const appEnv = (process.env.APP_ENV ?? '').toLowerCase();
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();

  if (appEnv === 'prod' || appEnv === 'production') {
    throw new Error('Refusing to seed: APP_ENV is production.');
  }
  if (!url) {
    throw new Error('Refusing to seed: DATABASE_URL is not set.');
  }
  if (appEnv !== 'develop' && !LOCAL_HOSTS.includes(host)) {
    throw new Error(
      `Refusing to seed: DATABASE_URL host is "${host || 'unreadable'}" and APP_ENV is ` +
        `"${appEnv || 'unset'}". Allowed: a local database, or APP_ENV=develop.`,
    );
  }
  return url;
}

/** `--name value` or `--name=value` from argv. */
export function argValue(name: string): string | undefined {
  const args = process.argv.slice(2);
  for (const [i, arg] of args.entries()) {
    if (arg === `--${name}`) return args[i + 1];
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  return undefined;
}
