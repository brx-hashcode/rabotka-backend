import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CsrfModule } from '../csrf.module';
import { CSRF_UTILITIES } from '../csrf.constants';

async function compileWith(
  secret: string | undefined,
  env: Record<string, string> = {},
) {
  return Test.createTestingModule({ imports: [CsrfModule] })
    .overrideProvider(ConfigService)
    .useValue({
      get: (key: string) => (key === 'CSRF_SECRET' ? secret : env[key]),
    })
    .compile();
}

/** The cookie a token request sets, under whatever name the module picked. */
function tokenCookie(utilities: {
  generateCsrfToken: (req: unknown, res: unknown) => string;
}) {
  const res = { cookie: jest.fn() };
  utilities.generateCsrfToken(
    { cookies: { 'csrf-visitor-id': 'v-1' }, headers: {} },
    res,
  );
  const [name, , options] = res.cookie.mock.calls[0] as [
    string,
    string,
    { secure: boolean; sameSite: string },
  ];
  return { name, options };
}

describe('CsrfModule', () => {
  it.each([undefined, '', '   ', 'too-short'])(
    'refuses to start with CSRF_SECRET=%p',
    async (secret) => {
      // It used to sign with an empty key — protection anyone could forge.
      await expect(compileWith(secret)).rejects.toThrow(/CSRF_SECRET/);
    },
  );

  it('starts with a real secret', async () => {
    const module = await compileWith('x'.repeat(32));
    expect(module.get(CSRF_UTILITIES)).toBeDefined();
  });

  it('sets the token cookie Secure in production, keeping its name', async () => {
    const module = await compileWith('x'.repeat(32), {
      NODE_ENV: 'production',
    });
    const { name, options } = tokenCookie(module.get(CSRF_UTILITIES));
    // Still `csrf-token`: renaming it to the __Host- form remains
    // SECURE_COOKIES's decision, so this changes no cookie anyone holds.
    expect(name).toBe('csrf-token');
    expect(options).toMatchObject({ secure: true, sameSite: 'lax' });
  });

  it('leaves it non-Secure in development, which runs over plain http', async () => {
    const module = await compileWith('x'.repeat(32), {
      NODE_ENV: 'development',
    });
    expect(tokenCookie(module.get(CSRF_UTILITIES)).options.secure).toBe(false);
  });
});
