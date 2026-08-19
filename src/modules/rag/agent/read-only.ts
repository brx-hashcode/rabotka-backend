import { Logger } from '@nestjs/common';
import type { ProfileService } from '../../profile/profile.service';
import type { JobOfferService } from '../../job-offer/job-offer.service';
import type { ApplicationService } from '../../application/application.service';
import type { WalletService } from '../../wallet/wallet.service';
import type { ContactUnlockService } from '../../contact-unlock/contact-unlock.service';
import type { SystemConfigService } from '../../system-config/system-config.service';

/**
 * The assistant is READ-ONLY. This file is what makes that structural.
 *
 * Vova may look things up and explain them; it may not change anything. Not the
 * wallet, not a candidature, not a profile, not a claim. The reason is not
 * timidity — it is that a mutation triggered by a sentence is a mutation
 * triggered by whoever can write that sentence, and the users on the other end
 * of this bot are being asked to trust the platform with their work and their
 * money. `PROJECT_CONTEXT.md` §10 already says it: the assistant proposes, the
 * user confirms, through the flows that were built and tested for it.
 *
 * A rule in a prompt would not survive contact with a future tool. So each
 * service reaches the tools through a `Pick<>` of named read methods — the
 * compiler rejects `deps.wallet.debitProfileWallet(...)` outright — and the
 * same list drives a runtime Proxy, so a dynamic call cannot slip past either.
 *
 * **To add a capability, add a method name below.** That single line is the
 * review: anything not on these lists does not exist as far as the agent is
 * concerned.
 */

export const PROFILE_READS = [
  'findById',
  'getApplicationsByProfileId',
  'getPenaltiesByProfileId',
] as const;

export const JOB_OFFER_READS = [
  'findActive',
  'findByReference',
  // An employer asking « combien de missions j'ai publiées ? » had no tool at
  // all, so the model answered with whatever it did have — the wallet balance.
  'findByEmployerId',
] as const;

/** Applications an employer RECEIVED. Read-only, like everything here. */
export const APPLICATION_READS = ['findByEmployer'] as const;

export const WALLET_READS = ['getProfileWalletBalance'] as const;

export const UNLOCK_READS = ['getByApplicationId'] as const;

export const SYSTEM_CONFIG_READS = [
  'getContactUnlockFees',
  'getContactInfo',
] as const;

export type ReadOnlyProfiles = Pick<
  ProfileService,
  (typeof PROFILE_READS)[number]
>;
export type ReadOnlyJobOffers = Pick<
  JobOfferService,
  (typeof JOB_OFFER_READS)[number]
>;
export type ReadOnlyApplications = Pick<
  ApplicationService,
  (typeof APPLICATION_READS)[number]
>;
export type ReadOnlyWallet = Pick<WalletService, (typeof WALLET_READS)[number]>;
export type ReadOnlyUnlock = Pick<
  ContactUnlockService,
  (typeof UNLOCK_READS)[number]
>;
export type ReadOnlySystemConfig = Pick<
  SystemConfigService,
  (typeof SYSTEM_CONFIG_READS)[number]
>;

const logger = new Logger('VovaReadOnly');

/**
 * Wraps a service so only the named methods are reachable at runtime.
 *
 * The `Pick<>` types above already stop this at compile time; this is the
 * second lock, for the paths a type cannot see — a cast, a dynamic property
 * name, a refactor that widens an interface without anyone noticing. It throws
 * rather than returning undefined, because a silent no-op mutation is worse
 * than a loud failure: the agent would report success for something that never
 * happened.
 */
export function readOnly<T extends object>(
  service: T,
  allowed: readonly string[],
  name: string,
): T {
  const permitted = new Set<string>(allowed);

  return new Proxy(service, {
    get(target, prop, receiver) {
      if (typeof prop !== 'string') return Reflect.get(target, prop, receiver);
      if (!permitted.has(prop)) {
        logger.error(
          `Blocked: the assistant tried to reach ${name}.${prop}, which is not a permitted read`,
        );
        throw new Error(
          `Vova is read-only — ${name}.${prop} is not available to the assistant`,
        );
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(_target, prop) {
      throw new Error(
        `Vova is read-only — cannot assign ${name}.${String(prop)}`,
      );
    },
  });
}
