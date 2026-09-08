import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { AccountStatus, ProfileType, VerificationStatus } from '@prisma/client';
import { LlmService, withTimeout } from '../llm/llm.service';
import { LlmRouterService } from '../llm/router.service';
import {
  specId,
  type LlmCallTelemetry,
  type LlmProviderSpec,
} from '../llm/llm.types';
import type { Deadline } from '../llm/deadline';
import { JobCategoryRegistry } from '../intents/job-category.registry';
import { FallbackChatModel } from './fallback-chat-model';
import { GuardService, isAbusive } from './guard.service';
import { AbuseReportService } from './abuse-report.service';
import {
  buildAnonymousSystemPromptParts,
  buildSystemPromptParts,
  type SystemPromptParts,
} from './prompts';
import { refusal, type RefusalId } from './refusals';
import { AgentDeadlineExceededError } from './agent.errors';
import { LlmFatalError } from '../llm/llm.errors';
import { classifyLlmError } from '../llm/error-classification';
import { hedgeCounter, llmFallbackCounter } from '../llm/metrics';
import { buildAnonymousTools, buildTools } from './tools';
import { ToolDepsProvider } from './tool-deps.provider';
import { readNumber } from '../shared/config';
import { destinationFor } from './destination';
import { resolveLanguage } from './language';
import { VovaHistoryService } from './history.service';
import type { RetrievalResult } from '../retrieval/retrieve.service';

export interface AgentRequest {
  profileId: string;
  profileType: ProfileType;
  firstName: string | null;
  verificationStatus: VerificationStatus;
  accountStatus: AccountStatus;
  categorySlugs: string[];
  text: string;
  correlationId?: string;
  /**
   * The turn's wall-clock budget, threaded down to every model call.
   *
   * Optional so callers that do not meter a turn (tests, scripts) still work —
   * `LlmService` falls back to the flat per-call cap when it is absent.
   */
  deadline?: Deadline;
}

/** One turn of an anonymous conversation, as held in Redis. */
export interface AnonymousTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface AnonymousAgentRequest {
  text: string;
  /** Recent turns for this phone. Empty is normal, not an error. */
  history: AnonymousTurn[];
  correlationId?: string;
  /** The turn's wall-clock budget, threaded down to every model call. */
  deadline?: Deadline;
}

export interface AnonymousAgentReply {
  text: string;
  origin: 'guard' | 'agent' | 'error';
  refusalId?: RefusalId;
  telemetry?: LlmCallTelemetry;
  sanitizerBlocked: string[];
}

export interface AgentReply {
  text: string;
  /**
   * The screen this message points at. The CARD is not sent from here — the
   * caller decides, because a card on every reply reads as a menu rather than
   * a conversation. See `offer.ts`.
   */
  destination: string;
  origin: 'guard' | 'agent' | 'error';
  refusalId?: RefusalId;
  escalated: boolean;
  telemetry?: LlmCallTelemetry;
  sanitizerBlocked: string[];
}

/**
 * The system prompt as TWO content blocks, stable first.
 *
 * Two blocks rather than one string because that is what a cache breakpoint
 * needs something to attach to: `LlmService` marks the first block for the
 * providers that understand `cache_control`, and leaves it alone for the rest.
 * Deciding here instead would mean this file knowing which vendor is answering,
 * which is exactly what the provider abstraction exists to prevent.
 *
 * Providers that cannot read block arrays are handled at the same boundary —
 * `flattenContent` joins the blocks back into one string for Mistral, and has
 * read `part.text` since it was written, so it needs no change for this.
 */
function systemMessage(parts: SystemPromptParts): SystemMessage {
  return new SystemMessage({
    content: [
      { type: 'text', text: parts.stable },
      { type: 'text', text: parts.volatile },
    ],
  });
}

/** One raced agent run, settled rather than rejected so `Promise.race` stays tractable. */
type RunOutcome =
  | {
      i: number;
      ok: true;
      result: { messages: BaseMessage[] };
      telemetry?: LlmCallTelemetry;
    }
  | { i: number; ok: false; err: unknown };

interface InflightRun {
  spec: LlmProviderSpec;
  controller: AbortController;
  p: Promise<RunOutcome>;
}

/**
 * Cost of getting from "retrieval returned" to "the first model call starts":
 * `buildTools`, `buildSystemPromptParts`, and `usableChain`'s per-provider
 * breaker read. Small, but not zero — and reserving only `minRunMs` for the run
 * meant this ate the difference and the run was refused anyway.
 */
const RUN_HANDOFF_MS = 250;

/** Distinguishes "the timer won the race" from "a run finished". */
const GRACE_ELAPSED = Symbol('grace-elapsed');

/**
 * A sleep that can be cancelled.
 *
 * The cancel is load-bearing, not tidiness: this runs once per iteration of the
 * scheduler loop, and an uncancelled timer per iteration leaks one live handle
 * per hedge decision for the length of the turn.
 */
function sleepTagged(ms: number): {
  promise: Promise<typeof GRACE_ELAPSED>;
  cancel: () => void;
} {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<typeof GRACE_ELAPSED>((resolve) => {
    timer = setTimeout(() => resolve(GRACE_ELAPSED), ms);
    timer.unref?.();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

@Injectable()
export class VovaAgentService {
  /**
   * Hedges running across the whole process, not just this turn.
   *
   * Static because the thing being bounded is fleet load: a vendor-wide
   * slowdown makes every concurrent turn want to hedge at the same instant,
   * and a per-turn cap cannot see that.
   */
  private static hedgesInFlight = 0;

  private readonly logger = new Logger(VovaAgentService.name);
  private readonly maxIterations: number;
  /** Least budget worth starting a whole agent run with. */
  private readonly minRunMs: number;
  /** Ceiling on retrieval, so grounding can never starve the model call. */
  private readonly retrievalBudgetMs: number;

  private readonly hedgeEnabled: boolean;
  /** Head start the leading provider gets alone. `0` starts everyone at once. */
  private readonly hedgeMs: number;
  private readonly hedgeMaxParallel: number;
  private readonly hedgeMaxConcurrent: number;
  private readonly hedgeMinRemainingMs: number;
  /** How long a preferred run may still overtake one that finished first. */
  private readonly raceGraceMs: number;

  constructor(
    private readonly llm: LlmService,
    private readonly router: LlmRouterService,
    private readonly guard: GuardService,
    private readonly categories: JobCategoryRegistry,
    private readonly history: VovaHistoryService,
    private readonly deps: ToolDepsProvider,
    private readonly abuseReports: AbuseReportService,
    config: ConfigService,
  ) {
    this.maxIterations = readNumber(config, 'VOVA_MAX_TOOL_STEPS', 6);
    this.minRunMs = readNumber(config, 'VOVA_MIN_RUN_MS', 5000);
    this.retrievalBudgetMs = readNumber(
      config,
      'VOVA_RETRIEVAL_BUDGET_MS',
      4000,
    );

    // Off by default. Racing doubles token spend and database reads on the
    // turns it fires, so it is enabled deliberately after the cheaper fixes
    // have been measured — not inherited by anyone who upgrades.
    this.hedgeEnabled = config.get<string>('VOVA_HEDGE_ENABLED') === 'true';
    this.hedgeMs = readNumber(config, 'VOVA_HEDGE_MS', 3500);
    this.hedgeMaxParallel = readNumber(config, 'VOVA_HEDGE_MAX_PARALLEL', 2);
    this.hedgeMaxConcurrent = readNumber(
      config,
      'VOVA_HEDGE_MAX_CONCURRENT',
      8,
    );
    this.hedgeMinRemainingMs = readNumber(
      config,
      'VOVA_HEDGE_MIN_REMAINING_MS',
      8000,
    );
    this.raceGraceMs = readNumber(config, 'VOVA_RACE_PREFERENCE_GRACE_MS', 800);
  }

  /**
   * Run the react agent, walking the provider chain until one completes.
   *
   * One provider per RUN. A conversation that starts on Gemini finishes on
   * Gemini, or restarts from scratch on the next provider — never swaps
   * halfway, which is what corrupted the tool history.
   */
  private async runChain(
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    tier: ReturnType<LlmRouterService['route']>,
    opts: {
      correlationId?: string;
      onTelemetry: (t: LlmCallTelemetry) => void;
      deadline?: Deadline;
    },
  ): Promise<{ messages: BaseMessage[] }> {
    // Same reasoning as the provider SDKs: LangGraph is ~4 MB of heap that a
    // disabled assistant should not pay for at boot.
    const { createReactAgent } = await import('@langchain/langgraph/prebuilt');

    const chain = await this.llm.usableChain(tier);
    if (chain.length === 0) throw new Error(`no usable provider for ${tier}`);

    const inflight = new Map<number, InflightRun>();
    let next = 0;
    let lastError: unknown;

    /** Begin the run at chain position `i`. Never throws; settles into a RunOutcome. */
    const start = (i: number): void => {
      const spec = chain[i];
      const controller = new AbortController();
      const signal = opts.deadline
        ? AbortSignal.any([controller.signal, opts.deadline.signal])
        : controller.signal;

      // A run-LOCAL telemetry slot, deliberately not `opts.onTelemetry`.
      //
      // That callback writes the caller's single `telemetry` variable, so two
      // concurrent runs would race to be the last writer and the reply would be
      // attributed to the loser about half the time. It is called exactly once,
      // at the end, with whichever run actually won.
      let telemetry: LlmCallTelemetry | undefined;

      const model = new FallbackChatModel({
        llm: this.llm,
        tier,
        spec,
        correlationId: opts.correlationId,
        onTelemetry: (t) => {
          telemetry = t;
        },
        deadline: opts.deadline ?? null,
        // The last provider has nobody to save time for, so it may spend the
        // whole remaining budget rather than holding a reserve back.
        reserveMs: i === chain.length - 1 ? 0 : undefined,
      });

      const isHedge = i > 0;
      if (isHedge) {
        hedgeCounter.inc({ provider: spec.provider, result: 'started' });
        VovaAgentService.hedgesInFlight += 1;
      }

      const p = createReactAgent({
        llm: model as never,
        tools: tools as never,
      })
        // A copy of the messages per run: two graphs must never share a mutable
        // input array. Cheap insurance against a class of bug that would only
        // appear under concurrency.
        .invoke(
          { messages: [...messages] },
          {
            recursionLimit: this.maxIterations * 2,
            // LangGraph checks this between graph nodes, so an expired turn —
            // or a lost race — stops at the next step boundary instead of
            // after another full model call.
            signal,
          },
        )
        .then(
          (result): RunOutcome => ({ i, ok: true, result, telemetry }),
          (err): RunOutcome => ({ i, ok: false, err }),
        )
        // Decremented when the run SETTLES, not when it is abandoned: an
        // aborted graph keeps its slot until it actually stops, which is what
        // makes the cap describe real load rather than intent.
        .finally(() => {
          if (isHedge) VovaAgentService.hedgesInFlight -= 1;
        });

      inflight.set(i, { spec, controller, p });
    };

    const abortRest = (): void => {
      for (const [, run] of inflight) {
        run.controller.abort();
        hedgeCounter.inc({ provider: run.spec.provider, result: 'aborted' });
      }
      inflight.clear();
    };

    /**
     * Chain order is a PREFERENCE, not just a start order.
     *
     * A lower-priority run finishing first does not automatically win: its
     * answer is held for a grace window, and a higher-priority run landing
     * inside that window is preferred. Without this, a flat race returns
     * whichever model is fastest — which over a quality-diverse chain is
     * reliably the weakest one, every single turn.
     *
     * Costs nothing on the common path: it only engages when a run EARLIER in
     * the chain is still going, and it is clamped to the remaining budget.
     */
    const settle = async (
      first: RunOutcome & { ok: true },
    ): Promise<{ messages: BaseMessage[] }> => {
      const preferred = [...inflight.keys()].filter((i) => i < first.i);

      if (this.raceGraceMs > 0 && preferred.length > 0) {
        const grace = Math.min(
          this.raceGraceMs,
          opts.deadline?.remainingMs() ?? this.raceGraceMs,
        );
        const timer = sleepTagged(grace);
        try {
          const winner = await Promise.race([
            ...preferred.map((i) => inflight.get(i)!.p),
            timer.promise,
          ]);
          if (winner !== GRACE_ELAPSED && winner.ok) {
            inflight.delete(winner.i);
            this.logger.debug(
              `Preferred ${specId(chain[winner.i])} landed inside the ` +
                `${grace}ms grace — using it over ${specId(chain[first.i])}`,
            );
            return finish(winner);
          }
        } finally {
          timer.cancel();
        }
      }

      return finish(first);
    };

    const finish = (
      won: RunOutcome & { ok: true },
    ): { messages: BaseMessage[] } => {
      inflight.delete(won.i);
      abortRest();
      hedgeCounter.inc({
        provider: chain[won.i].provider,
        result: won.i === 0 ? 'won' : 'won_hedge',
      });
      if (won.telemetry) opts.onTelemetry(won.telemetry);
      return won.result;
    };

    // Do not start a run that cannot finish. The direct fix for the orphaned
    // work in the 2026-09-01 log: the user had already been sent the fallback
    // card, and the chain went on to cold-import Anthropic's SDK, fail, and
    // start Mistral — seconds of billed calls whose answer nobody would read.
    const canStart = (i: number): boolean => {
      if (i >= chain.length) return false;
      const left = opts.deadline?.remainingMs();
      if (left !== undefined && left < this.minRunMs) {
        this.logger.warn(
          `Skipping ${specId(chain[i])} — ${left}ms left in the turn, below ` +
            `the ${this.minRunMs}ms floor for starting a run`,
        );
        return false;
      }
      return true;
    };

    if (!canStart(0)) throw new Error(`no budget to start a run for ${tier}`);
    start(next++);

    try {
      while (inflight.size > 0) {
        const hedge = this.canHedge(next, chain, inflight.size, opts.deadline)
          ? sleepTagged(this.hedgeMs)
          : null;

        let settled: RunOutcome | typeof GRACE_ELAPSED;
        try {
          settled = await Promise.race([
            ...[...inflight.values()].map((r) => r.p),
            ...(hedge ? [hedge.promise] : []),
          ]);
        } finally {
          hedge?.cancel();
        }

        // The hedge timer won: provider 1 is slow enough to be worth doubling
        // up on. It is NOT cancelled — it may still win.
        if (settled === GRACE_ELAPSED) {
          // Re-checked HERE, not just when the timer was armed. The arming
          // decision was made `hedgeMs` ago; under a vendor-wide slowdown every
          // concurrent turn arms its timer while the process-wide count is
          // still zero, and they then all fire together. Asking again at the
          // moment of starting is what makes the cap bind at all — without it
          // six simultaneous turns produced six hedges against a cap of two.
          if (
            this.canHedge(next, chain, inflight.size, opts.deadline) &&
            canStart(next)
          ) {
            start(next++);
          }
          continue;
        }

        inflight.delete(settled.i);

        if (settled.ok) return await settle(settled);

        if (settled.err instanceof LlmFatalError) {
          abortRest();
          throw settled.err;
        }

        lastError = settled.err;

        if (opts.deadline?.causedAbort()) {
          this.logger.warn(
            `Turn budget expired during ${specId(chain[settled.i])} — not advancing`,
          );
          break;
        }

        // THE failover metric. `LlmService.invoke` has one too, but nothing
        // reaches it: the agent pins one provider per run through `invokeWith`,
        // so this loop — not that one — is where a conversation actually
        // changes vendor. Counting only there would have produced a series that
        // sits at zero through an outage.
        //
        // A hedge STARTING is deliberately not counted here: it is not a
        // failover, and conflating them makes this series unreadable.
        llmFallbackCounter.inc({
          from: chain[settled.i].provider,
          to: chain[next]?.provider ?? 'none',
          reason: classifyLlmError(settled.err),
        });
        hedgeCounter.inc({
          provider: chain[settled.i].provider,
          result: 'lost',
        });
        this.logger.warn(
          `Agent run failed on ${specId(chain[settled.i])} — ` +
            `${inflight.size > 0 ? 'a parallel run is still going' : 'restarting on the next provider'}`,
        );

        if (inflight.size === 0 && canStart(next)) start(next++);
      }
    } finally {
      abortRest();
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('every provider failed to complete the agent run');
  }

  /**
   * Stop before a phase the turn no longer has time for.
   *
   * Every await before `runChain` — categories, history, retrieval — ignored
   * the deadline entirely, so a turn whose budget was already gone kept doing
   * database and vector work, then failed at `canStart(0)` with a bare Error.
   * In the 2026-09-01 log that arrived a full second AFTER the user had been
   * sent the fallback card.
   *
   * Two choices worth stating:
   *
   * `remainingMs() < minRunMs`, not `expired()` — `expired()` is only true at
   * exactly zero, and a turn with 200ms left is going to die at `canStart(0)`
   * regardless, just later and louder. Sharing the floor makes the two agree.
   *
   * `causedAbort()` as well — `VovaService.dispose()` aborts the signal but
   * does not move `endsAt`, so a turn that LOST the outer race still reads a
   * positive `remainingMs()`. Without this check the agent keeps working for a
   * caller that has already answered. Same reasoning, and the same asymmetry,
   * as `LlmService.deadlineCaused`.
   *
   * Honest limit: these only fire when the event loop is free. The turn stuck
   * inside a synchronous ONNX embed still burns to the full budget — this
   * saves the ones queued behind it.
   */
  /** Run one phase, recording its elapsed time on the turn's deadline. */
  private async timePhase<T>(
    deadline: Deadline | undefined,
    phase: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const done = deadline?.beginPhase(phase);
    try {
      return await run();
    } finally {
      done?.();
    }
  }

  /**
   * Retrieval, on a budget it cannot exceed.
   *
   * Grounding is worth waiting for, but not worth the whole turn — and before
   * this it could take the whole turn, leaving nothing for the model call the
   * answer actually comes from. The slice is capped at what remains MINUS the
   * same `minRunMs` floor `canStart` uses, which turns "retrieval cannot starve
   * the model" from a hope into an invariant.
   *
   * On expiry we degrade to empty grounding rather than failing the turn:
   * `HelpRetrieveService.search` already returns empty hits on any error, so
   * this is an existing supported path. The assistant answers from the system
   * prompt and its tools instead of not answering at all.
   *
   * **This caps how long we WAIT. It cancels nothing.** `queryEmbed` has no
   * abort signal and runs to completion, still burning main-thread CPU after we
   * stop awaiting it. Worse, while a synchronous ONNX embed holds the loop no
   * timer fires at all — including this one — so the turn that owns a cold
   * embed still pays for it in full. What this genuinely buys is the turns
   * QUEUED BEHIND that one: their timers all fire in the same tick once the
   * loop is released, and they abandon retrieval instead of each queueing
   * another embed. With the inbound worker at concurrency:5, that is four
   * turns saved out of five.
   */
  private async ground(
    deadline: Deadline | undefined,
    run: () => Promise<RetrievalResult>,
  ): Promise<RetrievalResult> {
    const empty: RetrievalResult = {
      hits: [],
      expandedQuery: '',
      requiredTools: [],
    };

    const remaining = deadline?.remainingMs() ?? Number.POSITIVE_INFINITY;
    // Leave the run floor PLUS the handoff between here and the first model
    // call: building the tools and the system prompt, and `usableChain`'s
    // breaker read (one Redis round trip per provider). Reserving exactly
    // `minRunMs` looked right and was not — retrieval would spend its whole
    // slice, the handoff would eat the few milliseconds that left, and the
    // `chain` guard would refuse the run the slice had just been sized to
    // protect. The cushion is what makes "retrieval cannot starve the model"
    // an invariant instead of a near miss.
    const slice = Math.min(
      this.retrievalBudgetMs,
      Math.max(0, remaining - this.minRunMs - RUN_HANDOFF_MS),
    );

    if (slice <= 0) {
      this.logger.warn(
        `Skipping retrieval — ${remaining}ms left, none of it spare above the ` +
          `${this.minRunMs}ms run floor`,
      );
      deadline?.beginPhase('retrieval')();
      return empty;
    }

    const done = deadline?.beginPhase('retrieval');
    try {
      // `run` takes no signal — `help.search` cannot be cancelled — so the
      // callback argument is ignored. The deadline signal still matters as the
      // external one: if the turn dies mid-retrieval we stop waiting at once
      // rather than at the slice boundary.
      return await withTimeout(
        () => run(),
        slice,
        'vova-retrieval',
        deadline?.signal,
      );
    } catch (err) {
      // The turn itself is over — do not degrade and walk into a model call
      // there is no budget for. Let the caller's classification handle it.
      if (deadline?.causedAbort()) {
        throw new AgentDeadlineExceededError('retrieval', 0, this.minRunMs);
      }

      this.logger.warn(
        `Retrieval exceeded its ${slice}ms slice — answering without corpus ` +
          `grounding (${err instanceof Error ? err.message : String(err)})`,
      );
      return empty;
    } finally {
      done?.();
    }
  }

  /**
   * Log a failed turn at the level it deserves.
   *
   * Running out of time is a capacity fact, not a fault: nobody misbehaved,
   * the budget simply ran out. Logging it at ERROR beside genuine failures is
   * what made one slow embedder read as five separate faults, and it is the
   * same distinction `LlmService.deadlineCaused` already draws one layer down.
   *
   * `causedAbort()` is checked as well as the typed error because the turn can
   * die between phase guards — inside `runChain`, or while `VovaService` is
   * losing the outer race.
   */
  private report(
    err: unknown,
    who: string,
    deadline: Deadline | undefined,
  ): void {
    const outOfTime =
      err instanceof AgentDeadlineExceededError ||
      deadline?.causedAbort() === true ||
      deadline?.expired() === true;

    if (outOfTime) {
      this.logger.warn(
        `Vova ran out of time for ${who}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    this.logger.error(`Vova agent failed for ${who}`, err);
  }

  private assertTime(deadline: Deadline | undefined, phase: string): void {
    if (!deadline) return;

    if (deadline.causedAbort()) {
      throw new AgentDeadlineExceededError(phase, 0, this.minRunMs);
    }

    const left = deadline.remainingMs();
    if (left < this.minRunMs) {
      throw new AgentDeadlineExceededError(phase, left, this.minRunMs);
    }
  }

  /**
   * May a second (or third) run start alongside the ones already going?
   *
   * Every condition here is a brake, and the last one is the difference between
   * racing as a latency tool and racing as an outage amplifier: without a
   * process-wide cap, a vendor-wide slowdown makes EVERY concurrent turn hedge
   * at once, doubling load on the database and on provider 2 at exactly the
   * moment the system can least absorb it.
   */
  private canHedge(
    next: number,
    chain: LlmProviderSpec[],
    inflightCount: number,
    deadline?: Deadline,
  ): boolean {
    if (!this.hedgeEnabled) return false;
    if (next >= chain.length) return false;
    if (inflightCount >= this.hedgeMaxParallel) return false;
    if (VovaAgentService.hedgesInFlight >= this.hedgeMaxConcurrent)
      return false;

    const left = deadline?.remainingMs();
    if (left !== undefined && left < this.hedgeMinRemainingMs) return false;

    return true;
  }

  /**
   * Answer someone who has no account.
   *
   * A separate entry point rather than an `anonymous` flag through `handle()`.
   * Almost nothing is shared: no profile id, no role, no tools that read data,
   * no destination, no Postgres history. Threading optionality through the
   * registered path would have put a `?.` in front of the very fields that make
   * its answers correct, on the path that carries real users' figures — for the
   * benefit of a caller that uses none of them.
   *
   * There is no `destination` in the reply, deliberately. A stranger has
   * nothing to open; the only card they can be sent is the signup one, and that
   * belongs to the caller.
   */
  async handleAnonymous(
    request: AnonymousAgentRequest,
  ): Promise<AnonymousAgentReply> {
    const decision = this.guard.prefilter(request.text);

    if (decision.action !== 'allow') {
      this.logger.log(
        `vova.guard anonymous action=${decision.action} reason=${decision.reason} ` +
          `refusal=${decision.refusalId ?? '—'}`,
      );
      return {
        text: refusal(decision.refusalId ?? 'hors_scope'),
        origin: 'guard',
        refusalId: decision.refusalId,
        sanitizerBlocked: [],
      };
    }

    let telemetry: LlmCallTelemetry | undefined;

    try {
      // One memo per turn, shared by the retrieval below and every tool call —
      // so raced runs and a sequential failover replay each other's lookups
      // from memory instead of re-hitting Postgres.
      const deps = this.deps.getForTurn();
      const language = resolveLanguage(request.text, request.history);

      this.assertTime(request.deadline, 'retrieval');
      const grounding = await this.ground(request.deadline, () =>
        deps.help.search(
          request.text,
          undefined,
          'anonymous',
          language !== 'fr',
        ),
      );

      const messages: BaseMessage[] = [
        systemMessage(
          buildAnonymousSystemPromptParts({
            language,
            grounding: grounding.hits.map((hit) => ({
              title: hit.title,
              section: hit.section,
              text: hit.text,
            })),
          }),
        ),
        ...request.history.map((turn) =>
          turn.role === 'user'
            ? new HumanMessage(turn.text)
            : new AIMessage(turn.text),
        ),
        new HumanMessage(request.text),
      ];

      const tier = this.router.route({
        text: request.text,
        hasTools: true,
        historyLength: request.history.length,
      });

      this.assertTime(request.deadline, 'chain');
      const result = await this.runChain(
        messages,
        buildAnonymousTools(deps),
        tier,
        {
          correlationId: request.correlationId,
          deadline: request.deadline,
          onTelemetry: (t) => {
            telemetry = t;
          },
        },
      );

      const last = result.messages.at(-1);
      const raw =
        typeof last?.content === 'string'
          ? last.content
          : JSON.stringify(last?.content ?? '');

      if (!raw.trim()) {
        return {
          text: refusal('rien_trouve_anonyme'),
          origin: 'agent',
          refusalId: 'rien_trouve_anonyme',
          telemetry,
          sanitizerBlocked: ['empty'],
        };
      }

      const contact = await this.deps
        .get()
        .systemConfig.getContactInfo()
        .catch(() => ({ email: '', phone: '', address: '' }));
      const sanitized = this.guard.sanitize(
        raw,
        {
          phone: contact.phone ?? undefined,
          email: contact.email ?? undefined,
        },
        true,
      );

      return {
        text: sanitized.text,
        origin: 'agent',
        telemetry,
        sanitizerBlocked: sanitized.blocked,
      };
    } catch (err) {
      this.report(err, 'an anonymous caller', request.deadline);
      return {
        text: refusal('rien_trouve_anonyme'),
        origin: 'error',
        refusalId: 'rien_trouve_anonyme',
        telemetry,
        sanitizerBlocked: [],
      };
    }
  }

  /**
   * Combien des tours récents de CETTE personne étaient abusifs.
   *
   * Relit l'historique déjà en base plutôt que d'entretenir un compteur : un
   * compteur serait un état de plus à remettre à zéro au bon moment, et se
   * tromper de moment veut dire signaler quelqu'un pour des messages d'il y a
   * trois semaines.
   */
  private async countRecentAbuse(profileId: string): Promise<number> {
    // `priorInboundTexts`, pas `recent()` : il exclut le message courant, dont
    // l'écriture court en parallèle de cet appel. Avec `recent()` le message
    // qu'on est en train de traiter comptait parfois double — une fois lu dans
    // l'historique, une fois ajouté par `prefilter` — et le signalement partait
    // à la deuxième insulte au lieu de la troisième, selon qui gagnait la
    // course. Un compteur qui décide d'une réclamation ne peut pas dépendre de
    // ça.
    const prior = await this.history.priorInboundTexts(profileId);
    return prior.filter(isAbusive).length;
  }

  async handle(request: AgentRequest): Promise<AgentReply> {
    // L'historique n'est chargé QUE si ce message est lui-même abusif. Le
    // compte des récidives n'intéresse personne le reste du temps, et le
    // chemin de refus doit rester bon marché : il est emprunté par tous les
    // hors-sujet, qui sont fréquents.
    const priorAbuse = isAbusive(request.text)
      ? await this.countRecentAbuse(request.profileId)
      : 0;
    const decision = this.guard.prefilter(request.text, priorAbuse);

    if (
      decision.action === 'escalate' &&
      decision.refusalId === 'abus_signale'
    ) {
      // Le PIPELINE dépose le signalement, jamais le modèle.
      //
      // `read-only.ts` interdit à l'agent de créer une réclamation, et cet
      // appel ne l'enfreint pas : il ne passe pas par `tool-deps.provider.ts`,
      // le modèle n'a aucun outil d'écriture, et rien de ce qu'une personne
      // peut écrire ne le déclenche autrement qu'en insultant trois fois. La
      // règle visait « une mutation déclenchée par une phrase » ; ici la
      // mutation est déclenchée par un compteur, en code, sur un critère fixe.
      await this.abuseReports.report(request.profileId, request.text);
    }

    if (decision.action !== 'allow') {
      this.logger.log(
        `vova.guard action=${decision.action} reason=${decision.reason} ` +
          `refusal=${decision.refusalId ?? '—'}`,
      );
      return {
        text: refusal(decision.refusalId ?? 'hors_scope'),
        origin: 'guard',
        refusalId: decision.refusalId,
        escalated: decision.action === 'escalate',
        destination: destinationFor(request.text, request.profileType),
        sanitizerBlocked: [],
      };
    }

    let telemetry: LlmCallTelemetry | undefined;

    try {
      this.assertTime(request.deadline, 'categories');
      const knownCategorySlugs = await this.timePhase(
        request.deadline,
        'categories',
        () => this.categories.slugs(),
      );

      // The conversation so far, so a repeated « merci » does not produce a
      // repeated sentence and a subject already given is not asked for twice.
      //
      // Loaded BEFORE the language is resolved, which is why it moved up from
      // below: « ok » carries no language of its own, and without the previous
      // turns to read it defaulted to French and switched an English
      // conversation mid-thread.
      this.assertTime(request.deadline, 'history');
      const past = await this.timePhase(request.deadline, 'history', () =>
        this.history.recent(request.profileId),
      );
      const language = resolveLanguage(request.text, past);

      // One memo per turn, shared by the retrieval below and every tool call —
      // so raced runs and a sequential failover replay each other's lookups
      // from memory instead of re-hitting Postgres.
      const deps = this.deps.getForTurn();

      this.assertTime(request.deadline, 'retrieval');
      const grounding = await this.ground(request.deadline, () =>
        deps.help.search(
          request.text,
          undefined,
          request.profileType === ProfileType.WORKER ? 'worker' : 'employer',
          language !== 'fr',
        ),
      );
      const tools = buildTools(
        deps,
        { profileId: request.profileId, profileType: request.profileType },
        knownCategorySlugs,
      );

      const tier = this.router.route({
        text: request.text,
        hasTools: true,
        historyLength: 0,
      });

      const messages: BaseMessage[] = [
        systemMessage(
          buildSystemPromptParts({
            firstName: request.firstName,
            profileType: request.profileType,
            verificationStatus: request.verificationStatus,
            accountStatus: request.accountStatus,
            categorySlugs: request.categorySlugs,
            language,
            grounding: grounding.hits.map((hit) => ({
              title: hit.title,
              section: hit.section,
              text: hit.text,
            })),
            requiredTools: grounding.requiredTools,
          }),
        ),
        ...past.map((turn) =>
          turn.role === 'user'
            ? new HumanMessage(turn.text)
            : new AIMessage(turn.text),
        ),
        new HumanMessage(request.text),
      ];

      this.assertTime(request.deadline, 'chain');
      const result = await this.runChain(messages, tools, tier, {
        correlationId: request.correlationId,
        deadline: request.deadline,
        onTelemetry: (t) => {
          telemetry = t;
        },
      });

      const last = result.messages.at(-1);
      const raw =
        typeof last?.content === 'string'
          ? last.content
          : JSON.stringify(last?.content ?? '');

      if (!raw.trim()) {
        return {
          text: refusal('rien_trouve'),
          origin: 'agent',
          refusalId: 'rien_trouve',
          escalated: false,
          telemetry,
          destination: destinationFor(request.text, request.profileType),
          sanitizerBlocked: ['empty'],
        };
      }

      const contact = await this.deps
        .get()
        .systemConfig.getContactInfo()
        .catch(() => ({ email: '', phone: '', address: '' }));
      const sanitized = this.guard.sanitize(
        raw,
        {
          phone: contact.phone ?? undefined,
          email: contact.email ?? undefined,
        },
        // Nobody asked who it was — the guard would have answered that itself.
        true,
      );
      // The way into the app is a TEMPLATE, never a URL in the text.
      //
      // Rabotka runs as a webview inside WhatsApp: a bare link takes the user
      // out to a browser and loses the session the card would have carried.
      // The approved card's button appends the destination as a URL suffix,
      // which `withLoginLinks` turns into a one-tap `/s/<code>` — the user
      // lands signed in, still inside WhatsApp.
      //
      // Appended whether or not the model proposed a screen: it forgets, and an
      // employer asking to recruit got «je vous montre où faire ça» with no way
      // to get there. Everything that changes state happens in the app, so the
      // door is not optional.
      return {
        text: sanitized.text,
        destination: destinationFor(
          request.text,
          request.profileType,
          sanitized.text,
        ),
        origin: 'agent',
        escalated: false,
        telemetry,
        sanitizerBlocked: sanitized.blocked,
      };
    } catch (err) {
      this.report(err, `profile ${request.profileId}`, request.deadline);
      return {
        text: refusal('rien_trouve'),
        origin: 'error',
        refusalId: 'rien_trouve',
        escalated: false,
        telemetry,
        destination: destinationFor(request.text, request.profileType),
        sanitizerBlocked: [],
      };
    }
  }
}
