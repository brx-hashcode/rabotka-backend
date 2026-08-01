import { Logger } from '@nestjs/common';
import { EngineRolloutService, bucketOf } from '../engine-rollout.service';

jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

function makeConfig(values: Record<string, string> = {}) {
  return {
    get: jest.fn((key: string, fallback: string) =>
      Promise.resolve(values[key] ?? fallback),
    ),
  };
}

describe('EngineRolloutService', () => {
  const build = (values?: Record<string, string>) =>
    new EngineRolloutService(makeConfig(values) as never);

  it('defaults to legacy when nothing is configured', async () => {
    expect(await build().versionFor('p1')).toBe('legacy');
  });

  it('sends everyone to v2 when the version is set globally', async () => {
    const s = build({ 'matching.engine_version': 'v2' });
    for (const id of ['a', 'b', 'c']) {
      expect(await s.versionFor(id)).toBe('v2');
    }
  });

  it('falls back to legacy on an unrecognised version string', async () => {
    expect(
      await build({ 'matching.engine_version': 'v3' }).versionFor('p1'),
    ).toBe('legacy');
  });

  it('keeps everyone on legacy at 0 percent', async () => {
    const s = build({ 'matching.v2_rollout_percent': '0' });
    for (let i = 0; i < 50; i++) {
      expect(await s.versionFor(`p${i}`)).toBe('legacy');
    }
  });

  it('moves everyone to v2 at 100 percent', async () => {
    const s = build({ 'matching.v2_rollout_percent': '100' });
    for (let i = 0; i < 50; i++) {
      expect(await s.versionFor(`p${i}`)).toBe('v2');
    }
  });

  it('gives the same profile the same engine on every call', async () => {
    const s = build({ 'matching.v2_rollout_percent': '50' });
    const first = await s.versionFor('stable-profile');
    for (let i = 0; i < 20; i++) {
      expect(await s.versionFor('stable-profile')).toBe(first);
    }
  });

  it('splits a population roughly in line with the configured percentage', async () => {
    const s = build({ 'matching.v2_rollout_percent': '25' });
    const ids = Array.from({ length: 2000 }, (_, i) => `profile-${i}`);
    let v2 = 0;
    for (const id of ids) {
      if ((await s.versionFor(id)) === 'v2') v2++;
    }
    expect(v2 / ids.length).toBeGreaterThan(0.2);
    expect(v2 / ids.length).toBeLessThan(0.3);
  });

  it('only ever grows the v2 cohort as the percentage rises', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `p-${i}`);
    let previous = new Set<string>();

    for (const percent of ['10', '30', '60', '90']) {
      const s = build({ 'matching.v2_rollout_percent': percent });
      const cohort = new Set<string>();
      for (const id of ids) {
        if ((await s.versionFor(id)) === 'v2') cohort.add(id);
      }
      // Nobody who was already on v2 may be pulled back off it.
      for (const id of previous) expect(cohort.has(id)).toBe(true);
      previous = cohort;
    }
  });

  it('treats a non-numeric percentage as 0 rather than as NaN', async () => {
    expect(
      await build({ 'matching.v2_rollout_percent': 'oui' }).versionFor('p1'),
    ).toBe('legacy');
  });

  it('clamps an out-of-range percentage', async () => {
    expect(
      await build({ 'matching.v2_rollout_percent': '-20' }).versionFor('p1'),
    ).toBe('legacy');
    expect(
      await build({ 'matching.v2_rollout_percent': '500' }).versionFor('p1'),
    ).toBe('v2');
  });

  it('fails closed to legacy when the config lookup throws', async () => {
    const config = { get: jest.fn().mockRejectedValue(new Error('down')) };
    const s = new EngineRolloutService(config as never);
    expect(await s.versionFor('p1')).toBe('legacy');
  });

  describe('bucketOf', () => {
    it('always lands in [0,99]', () => {
      for (let i = 0; i < 500; i++) {
        const b = bucketOf(`profile-${i}`);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThan(100);
      }
    });

    it('is stable across calls', () => {
      expect(bucketOf('abc')).toBe(bucketOf('abc'));
    });
  });
});
