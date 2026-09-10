/**
 * Loads `.env.local` then `.env`, as a side effect, on import.
 *
 * Exists so a script can put the environment in place BEFORE importing any
 * module that reads it at load time. `REDIS_KEY_PREFIX` is the one that bites:
 * it is computed once, from `process.env.IS_PROD`, the moment its module is
 * evaluated. Imports are hoisted above ordinary statements, so a script calling
 * `config()` in its own body has already imported — and already frozen — the
 * wrong prefix by the time that line runs.
 *
 * Import this FIRST, before anything from `src/`:
 *
 *   import './load-env';
 *   import { REDIS_KEY_PREFIX } from '../src/common/services/redis/redis.constants';
 *
 * The order is load-bearing. A tool that sorts imports alphabetically would
 * break it silently — and silently is the whole danger here, since the wrong
 * prefix does not error, it just matches nothing.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });
config({ path: '.env' });
