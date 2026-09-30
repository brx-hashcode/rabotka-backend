import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { MetricsAccessGuard } from '../metrics-access.guard';

function contextFor(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

function guardWith(token?: string): MetricsAccessGuard {
  return new MetricsAccessGuard({
    get: (key: string) => (key === 'METRICS_TOKEN' ? token : undefined),
  } as never);
}

describe('MetricsAccessGuard', () => {
  it('lets a scraper inside the network through', () => {
    // Straight to the container: nothing the reverse proxy would have added.
    expect(guardWith().canActivate(contextFor({ host: 'api:3000' }))).toBe(
      true,
    );
  });

  it.each([
    ['x-forwarded-for', '203.0.113.7'],
    ['x-forwarded-host', 'api.rabotka.work'],
    ['x-real-ip', '203.0.113.7'],
    ['forwarded', 'for=203.0.113.7'],
  ])(
    'hides the route from a request that came through the proxy (%s)',
    (header, value) => {
      expect(() =>
        guardWith().canActivate(contextFor({ [header]: value })),
      ).toThrow(NotFoundException);
    },
  );

  it('lets a public scraper through with the token', () => {
    expect(
      guardWith('s3cret-token').canActivate(
        contextFor({
          'x-forwarded-for': '203.0.113.7',
          authorization: 'Bearer s3cret-token',
        }),
      ),
    ).toBe(true);
  });

  it.each([
    'Bearer wrong-token!',
    'Bearer s3cret-token-and-more',
    'Bearer ',
    'Basic s3cret-token',
  ])('refuses "%s"', (authorization) => {
    expect(() =>
      guardWith('s3cret-token').canActivate(
        contextFor({ 'x-forwarded-for': '203.0.113.7', authorization }),
      ),
    ).toThrow(NotFoundException);
  });

  it('never treats an unset token as one that matches an empty header', () => {
    expect(() =>
      guardWith(undefined).canActivate(
        contextFor({
          'x-forwarded-for': '203.0.113.7',
          authorization: 'Bearer ',
        }),
      ),
    ).toThrow(NotFoundException);
    expect(() =>
      guardWith('  ').canActivate(
        contextFor({
          'x-forwarded-for': '203.0.113.7',
          authorization: 'Bearer ',
        }),
      ),
    ).toThrow(NotFoundException);
  });
});
