import { DEFAULT_SYSTEM_CONFIGS as SRC_CONFIGS } from '../system-config.constants';
import { DEFAULT_SYSTEM_CONFIGS as SEED_CONFIGS } from '../../../../prisma/seed/system-config.constants';

/**
 * There are two copies of the config defaults: the runtime list used by
 * `SystemConfigService.seedDefaults()` and the Prisma seed list used by
 * `prisma/seed.ts`. They had already drifted — `matching.recommendation_min_score`
 * existed only in the runtime list — which meant a freshly seeded database was
 * missing a key the code reads, and only the code's hardcoded fallback saved it.
 *
 * This test exists so the next divergence fails CI instead of shipping.
 */
describe('system config defaults', () => {
  const keysOf = (configs: { key: string }[]) =>
    [...configs.map((c) => c.key)].sort((a, b) => a.localeCompare(b));

  it('the runtime list and the prisma seed list define the same keys', () => {
    expect(keysOf(SEED_CONFIGS)).toEqual(keysOf(SRC_CONFIGS));
  });

  it('agrees on the default value for every shared key', () => {
    const seedByKey = new Map(SEED_CONFIGS.map((c) => [c.key, c.value]));
    const mismatched = SRC_CONFIGS.filter(
      (c) => seedByKey.has(c.key) && seedByKey.get(c.key) !== c.value,
    ).map((c) => `${c.key}: src=${c.value} seed=${seedByKey.get(c.key)}`);
    expect(mismatched).toEqual([]);
  });

  it('has no duplicate keys in either list', () => {
    for (const configs of [SRC_CONFIGS, SEED_CONFIGS]) {
      const keys = configs.map((c) => c.key);
      expect(keys).toHaveLength(new Set(keys).size);
    }
  });

  it('keeps score thresholds inside [0,1]', () => {
    // These are compared against relevance values normalized to [0,1]; a default
    // outside that range would empty a feed rather than filter it.
    const scoreKeys = [
      'matching.min_notification_score',
      'matching.recommendation_min_score',
    ];
    for (const key of scoreKeys) {
      const entry = SRC_CONFIGS.find((c) => c.key === key);
      expect(entry).toBeDefined();
      const n = Number(entry!.value);
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
    }
  });
});
