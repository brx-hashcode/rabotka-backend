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

  /**
   * The same dependencies, memoised for the length of ONE turn.
   *
   * Safe because every method reachable here is read-only by construction —
   * `read-only.ts` allow-lists the reads per service and a runtime Proxy
   * refuses anything else — so serving a repeat call from the turn's own cache
   * cannot change what the assistant does, only how many times it asks.
   *
   * It pays three times over:
   *
   *  - **Raced runs.** Two runs answering the same question ask the same
   *    questions of Postgres. Without this, racing doubles database load for
   *    nothing; with it, the second run's lookups are free.
   *  - **Sequential failover.** A run restarting on the next provider replays
   *    the first one's lookups from memory. This is the recoverable part of
   *    "restarting discards completed work" — and it gets there WITHOUT
   *    touching the message history, so it goes nowhere near Gemini's
   *    `thought_signature` constraint, which is what makes the tempting version
   *    of that fix unshippable.
   *  - **Within one run.** The react loop asks `etat_du_profil` more than once
   *    in a conversation more often than you would hope.
   *
   * Staleness is bounded by the turn's own deadline — 25s — and by nothing here
   * being able to write. A fresh instance per turn, so nothing leaks between
   * conversations.
   */
  getForTurn(): ToolDeps {
    const base = this.get();
    const memo = new Map<string, unknown>();

    const wrap = <T extends object>(service: T, name: string): T =>
      new Proxy(service, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if (typeof value !== 'function') return value;

          return (...args: unknown[]) => {
            // Arguments are ids, slugs and small option objects, so this is
            // cheap and stable. A key that cannot be built (a circular arg, a
            // callback) falls through to calling the real method rather than
            // guessing — correctness first, caching second.
            let key: string;
            try {
              key = `${name}.${String(prop)}(${JSON.stringify(args)})`;
            } catch {
              return (value as (...a: unknown[]) => unknown).apply(
                target,
                args,
              );
            }

            if (memo.has(key)) return memo.get(key);

            const result = (value as (...a: unknown[]) => unknown).apply(
              target,
              args,
            );

            // A rejected promise must NOT stay in the cache: a transient
            // failure would otherwise be replayed for the rest of the turn,
            // including to the very fallback run started to escape it.
            if (result instanceof Promise) {
              memo.set(
                key,
                result.catch((err: unknown) => {
                  memo.delete(key);
                  throw err;
                }),
              );
              return memo.get(key);
            }

            memo.set(key, result);
            return result;
          };
        },
      });

    return {
      profiles: wrap(base.profiles, 'profiles'),
      jobOffers: wrap(base.jobOffers, 'jobOffers'),
      applications: wrap(base.applications, 'applications'),
      wallet: wrap(base.wallet, 'wallet'),
      unlock: wrap(base.unlock, 'unlock'),
      systemConfig: wrap(base.systemConfig, 'systemConfig'),
      help: wrap(base.help, 'help'),
      categories: wrap(base.categories, 'categories'),
    };
  }
}
