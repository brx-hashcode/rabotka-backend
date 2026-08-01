import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { SystemConfigService } from '../system-config/system-config.service';

export type EngineVersion = 'legacy' | 'v2';

/**
 * Decides which ranker serves a given profile.
 *
 * Bucketing is a stable hash of the profile id, not a coin flip: a user must get
 * the same engine on every request, or their feed reshuffles on each refresh and
 * any comparison between the two rankers is meaningless.
 *
 * Fails closed to `legacy` — a config outage must not silently move all traffic
 * onto the new path.
 */
@Injectable()
export class EngineRolloutService {
  private readonly logger = new Logger(EngineRolloutService.name);

  constructor(private readonly systemConfig: SystemConfigService) {}

  async versionFor(profileId: string): Promise<EngineVersion> {
    try {
      const version = await this.systemConfig.get(
        'matching.engine_version',
        'legacy',
      );
      // An explicit global setting wins outright; the percentage only governs
      // the gradual ramp in between.
      if (version === 'v2') return 'v2';
      if (version !== 'legacy') {
        this.logger.warn(`Unknown matching.engine_version "${version}"`);
        return 'legacy';
      }

      const percent = clampPercent(
        Number(await this.systemConfig.get('matching.v2_rollout_percent', '0')),
      );
      if (percent <= 0) return 'legacy';
      if (percent >= 100) return 'v2';

      return bucketOf(profileId) < percent ? 'v2' : 'legacy';
    } catch (err) {
      this.logger.warn(`Rollout lookup failed for ${profileId}`, err);
      return 'legacy';
    }
  }
}

/** Stable 0–99 bucket for a profile. */
export function bucketOf(profileId: string): number {
  const digest = createHash('sha256').update(profileId).digest();
  return digest.readUInt32BE(0) % 100;
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}
