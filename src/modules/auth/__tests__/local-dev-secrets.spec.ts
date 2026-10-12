import type { ConfigService } from '@nestjs/config';
import { mayLogSecretsLocally } from '../local-dev-secrets';

const config = (env: Record<string, string | undefined>) =>
  ({ get: (key: string) => env[key] }) as unknown as ConfigService;

describe('mayLogSecretsLocally', () => {
  it('allows it on a developer machine', () => {
    expect(mayLogSecretsLocally(config({ NODE_ENV: 'development' }))).toBe(
      true,
    );
  });

  it('refuses in production when IS_PROD is missing — the case that leaked', () => {
    expect(mayLogSecretsLocally(config({ NODE_ENV: 'production' }))).toBe(
      false,
    );
  });

  it('refuses when IS_PROD defaulted to "false" on a production server', () => {
    expect(
      mayLogSecretsLocally(
        config({ NODE_ENV: 'production', IS_PROD: 'false' }),
      ),
    ).toBe(false);
  });

  it('refuses when nothing is set at all', () => {
    expect(mayLogSecretsLocally(config({}))).toBe(false);
  });

  it('refuses in development flagged as production', () => {
    expect(
      mayLogSecretsLocally(
        config({ NODE_ENV: 'development', IS_PROD: 'true' }),
      ),
    ).toBe(false);
  });
});
