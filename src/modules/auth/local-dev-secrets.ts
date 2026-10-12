import type { ConfigService } from '@nestjs/config';

/**
 * Whether a live secret (an OTP) may be printed to the logs: on a developer's
 * machine only — `NODE_ENV=development` AND not flagged as production.
 *
 * FAIL-CLOSED. The checks this replaces logged unless `IS_PROD` was exactly
 * "true", and the production workflow defaults `IS_PROD` to "false" when the
 * key is missing from Vault — so one missing key put every login code in the
 * production log stream next to its phone number or email, and anyone who can
 * read logs could sign in as anyone. Now an unset or unexpected environment
 * logs nothing.
 */
export function mayLogSecretsLocally(config: ConfigService): boolean {
  return (
    config.get<string>('NODE_ENV') === 'development' &&
    config.get<string>('IS_PROD') !== 'true'
  );
}
