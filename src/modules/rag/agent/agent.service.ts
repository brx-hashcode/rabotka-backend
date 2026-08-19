import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { ProfileType, VerificationStatus } from '@prisma/client';
import { LlmService } from '../llm/llm.service';
import { LlmRouterService } from '../llm/router.service';
import type { LlmCallTelemetry } from '../llm/llm.types';
import { JobCategoryRegistry } from '../intents/job-category.registry';
import { FallbackChatModel } from './fallback-chat-model';
import { GuardService } from './guard.service';
import { buildAnonymousSystemPrompt, buildSystemPrompt } from './prompts';
import { refusal, type RefusalId } from './refusals';
import { LlmFatalError } from '../llm/llm.errors';
import { buildAnonymousTools, buildTools } from './tools';
import { ToolDepsProvider } from './tool-deps.provider';
import { readNumber } from '../shared/config';
import { destinationFor } from './destination';
import { resolveLanguage } from './language';
import { VovaHistoryService } from './history.service';

export interface AgentRequest {
  profileId: string;
  profileType: ProfileType;
  firstName: string | null;
  verificationStatus: VerificationStatus;
  categorySlugs: string[];
  text: string;
  correlationId?: string;
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

@Injectable()
export class VovaAgentService {
  private readonly logger = new Logger(VovaAgentService.name);
  private readonly maxIterations: number;

  constructor(
    private readonly llm: LlmService,
    private readonly router: LlmRouterService,
    private readonly guard: GuardService,
    private readonly categories: JobCategoryRegistry,
    private readonly history: VovaHistoryService,
    private readonly deps: ToolDepsProvider,
    config: ConfigService,
  ) {
    this.maxIterations = readNumber(config, 'VOVA_MAX_TOOL_STEPS', 6);
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
    },
  ): Promise<{ messages: BaseMessage[] }> {
    // Same reasoning as the provider SDKs: LangGraph is ~4 MB of heap that a
    // disabled assistant should not pay for at boot.
    const { createReactAgent } = await import('@langchain/langgraph/prebuilt');

    const chain = await this.llm.usableChain(tier);
    if (chain.length === 0) throw new Error(`no usable provider for ${tier}`);

    let lastError: unknown;

    for (const spec of chain) {
      const model = new FallbackChatModel({
        llm: this.llm,
        tier,
        spec,
        correlationId: opts.correlationId,
        onTelemetry: opts.onTelemetry,
      });

      try {
        // Same dual-package cast as the factory: the dynamically imported
        // LangGraph sees the ESM type identities.
        return (await createReactAgent({
          llm: model as never,
          tools: tools as never,
        }).invoke(
          { messages },
          { recursionLimit: this.maxIterations * 2 },
        )) as { messages: BaseMessage[] };
      } catch (err) {
        lastError = err;
        if (err instanceof LlmFatalError) throw err;
        this.logger.warn(
          `Agent run failed on ${spec.provider}/${spec.model} — restarting on the next provider`,
        );
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('every provider failed to complete the agent run');
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
      const language = resolveLanguage(request.text, request.history);
      const grounding = await this.deps
        .get()
        .help.search(request.text, undefined, 'anonymous', language !== 'fr');

      const messages: BaseMessage[] = [
        new SystemMessage(
          buildAnonymousSystemPrompt({
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

      const result = await this.runChain(
        messages,
        buildAnonymousTools(this.deps.get()),
        tier,
        {
          correlationId: request.correlationId,
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
      this.logger.error('Vova agent failed for an anonymous caller', err);
      return {
        text: refusal('rien_trouve_anonyme'),
        origin: 'error',
        refusalId: 'rien_trouve_anonyme',
        telemetry,
        sanitizerBlocked: [],
      };
    }
  }

  async handle(request: AgentRequest): Promise<AgentReply> {
    const decision = this.guard.prefilter(request.text);

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
      const knownCategorySlugs = await this.categories.slugs();

      // The conversation so far, so a repeated « merci » does not produce a
      // repeated sentence and a subject already given is not asked for twice.
      //
      // Loaded BEFORE the language is resolved, which is why it moved up from
      // below: « ok » carries no language of its own, and without the previous
      // turns to read it defaulted to French and switched an English
      // conversation mid-thread.
      const past = await this.history.recent(request.profileId);
      const language = resolveLanguage(request.text, past);

      const grounding = await this.deps
        .get()
        .help.search(
          request.text,
          undefined,
          request.profileType === ProfileType.WORKER ? 'worker' : 'employer',
          language !== 'fr',
        );
      const tools = buildTools(
        this.deps.get(),
        { profileId: request.profileId, profileType: request.profileType },
        knownCategorySlugs,
      );

      const tier = this.router.route({
        text: request.text,
        hasTools: true,
        historyLength: 0,
      });

      const messages: BaseMessage[] = [
        new SystemMessage(
          buildSystemPrompt({
            firstName: request.firstName,
            profileType: request.profileType,
            verificationStatus: request.verificationStatus,
            categorySlugs: request.categorySlugs,
            knownCategorySlugs,
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

      const result = await this.runChain(messages, tools, tier, {
        correlationId: request.correlationId,
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
      this.logger.error(
        `Vova agent failed for profile ${request.profileId}`,
        err,
      );
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
