import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ProfileService } from '../../profile/profile.service';
import { JobOfferService } from '../../job-offer/job-offer.service';
import { ApplicationService } from '../../application/application.service';
import { WalletService } from '../../wallet/wallet.service';
import { ContactUnlockService } from '../../contact-unlock/contact-unlock.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import { HelpRetrieveService } from '../retrieval/retrieve.service';
import { JobCategoryRegistry } from '../intents/job-category.registry';
import type { ToolDeps } from './tools';
import {
  APPLICATION_READS,
  JOB_OFFER_READS,
  PROFILE_READS,
  SYSTEM_CONFIG_READS,
  UNLOCK_READS,
  WALLET_READS,
  readOnly,
} from './read-only';

/**
 * Resolves the tools' service dependencies from the application container,
 * instead of importing the six modules that own them.
 *
 * **Why not plain module imports.** The assistant is reached from `BotModule`,
 * and importing `ProfileModule`, `ContactUnlockModule` and friends from here
 * closed require cycles that left sibling modules `undefined` at evaluation
 * time — the app refused to boot with "the module at index [4] of the
 * ProfileModule imports array is undefined". That is the same knot
 * `worker.module.ts` documents (`BotModule ↔ PaymentsModule ↔
 * SystemConfigModule ↔ AuthModule`), and it does not yield to `forwardRef`
 * once the graph is this wide.
 *
 * Everything it hands out is wrapped read-only first (see `read-only.ts`): the
 * assistant explains and looks up, it never changes anything.
 *
 * `ModuleRef` with `strict: false` reads from the whole container, so the
 * assistant depends on these services without their modules depending on it.
 * The cost is that a missing provider becomes a runtime error rather than a
 * compile-time one — which is why {@link onApplicationBootstrap} resolves every
 * one at startup and fails loudly there, instead of on somebody's first message.
 */
@Injectable()
export class ToolDepsProvider implements OnApplicationBootstrap {
  private readonly logger = new Logger(ToolDepsProvider.name);
  private cached: ToolDeps | null = null;

  constructor(private readonly moduleRef: ModuleRef) {}

  onApplicationBootstrap(): void {
    try {
      this.get();
      this.logger.log('Vova tool dependencies resolved');
    } catch (err) {
      // Loud, and at boot. A silent failure here surfaces as "the assistant
      // answers nothing", days later, in production.
      this.logger.error(
        'Vova tool dependencies could not be resolved — the assistant will fall back on every message',
        err,
      );
    }
  }

  get(): ToolDeps {
    if (this.cached) return this.cached;

    const pick = <T>(type: new (...args: never[]) => T): T =>
      this.moduleRef.get(type, { strict: false });

    // Each service is wrapped before the agent can reach it, so the read-only
    // guarantee holds even for a call the type system cannot see.
    const deps: ToolDeps = {
      profiles: readOnly(pick(ProfileService), PROFILE_READS, 'profiles'),
      jobOffers: readOnly(pick(JobOfferService), JOB_OFFER_READS, 'jobOffers'),
      applications: readOnly(
        pick(ApplicationService),
        APPLICATION_READS,
        'applications',
      ),
      wallet: readOnly(pick(WalletService), WALLET_READS, 'wallet'),
      unlock: readOnly(pick(ContactUnlockService), UNLOCK_READS, 'unlock'),
      systemConfig: readOnly(
        pick(SystemConfigService),
        SYSTEM_CONFIG_READS,
        'systemConfig',
      ),
      help: pick(HelpRetrieveService),
      categories: pick(JobCategoryRegistry),
    };
    this.cached = deps;
    return deps;
  }
}
