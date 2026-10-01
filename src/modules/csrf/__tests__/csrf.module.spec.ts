import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CsrfModule } from '../csrf.module';
import { CSRF_UTILITIES } from '../csrf.constants';

async function compileWith(secret: string | undefined) {
  return Test.createTestingModule({ imports: [CsrfModule] })
    .overrideProvider(ConfigService)
    .useValue({
      get: (key: string) => (key === 'CSRF_SECRET' ? secret : undefined),
    })
    .compile();
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
});
