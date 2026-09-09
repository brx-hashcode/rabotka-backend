import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type Redis from 'ioredis';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../../common/services/redis/redis.constants';
import { LlmService } from '../llm/llm.service';
import { VovaHistoryService, type HistoryTurn } from './history.service';

export interface MemoryFact {
  /** One short sentence, in the person's own terms. */
  text: string;
  /** ISO date the fact was last seen to hold. */
  at: string;
}

/**
 * What VoVa remembers about someone between conversations.
 *
 * `VovaHistoryService` is working memory: six turns, four hours, and then
 * nothing. That is the right shape for "don't repeat yourself", and the wrong
 * shape for "you already know this" — somebody who explained on Monday that
 * they only work weekends explained it again on Thursday.
 *
 * The fix is not a longer history. Re-reading a transcript costs tokens on
 * every turn and tokens are latency here. What carries across sessions is a
 * handful of FACTS, rewritten in place: read as one row by primary key, spent
 * as a few dozen tokens, and never derived on the reply path.
 */
@Injectable()
export class VovaMemoryService {
  private readonly logger = new Logger(VovaMemoryService.name);

  /**
   * Hard ceiling on what memory may cost.
   *
   * Eight facts is roughly sixty tokens — enough to carry a trade, a
   * neighbourhood, an availability and a constraint or two, and small enough
   * that it never competes with the retrieved corpus passages for room. The cap
   * is enforced on read as well as on write, so a row written by an older build
   * cannot bloat a prompt today.
   */
  private static readonly MAX_FACTS = 8;
  private static readonly MAX_FACT_CHARS = 90;

  /**
   * When a fact stops being asserted.
   *
   * A memory that is merely old is not neutral: "cherche du ménage" replayed in
   * September to someone who moved to masonry in March produces a confident
   * wrong answer, which is worse than having no memory at all. Ninety days is
   * longer than a job search and shorter than a change of trade.
   */
  private static readonly STALE_DAYS = 90;

  /**
   * How often the list may be rebuilt, per person.
   *
   * The rebuild is an extra model call, so doing it every turn would roughly
   * double what a conversation costs to serve for a list that barely moves.
   * Thirty minutes means a long exchange rebuilds once or twice, at the end,
   * when there is actually something new to keep.
   */
  private static readonly REBUILD_COOLDOWN_SECONDS = 30 * 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly history: VovaHistoryService,
    private readonly llm: LlmService,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
  ) {}

  /**
   * The facts to put in this turn's prompt.
   *
   * Never throws. No memory is worse than no reply: a Postgres blip must cost
   * the assistant its recall, not its answer — the same trade `history.recent`
   * makes.
   */
  async read(profileId: string): Promise<MemoryFact[]> {
    try {
      const row = await this.prisma.vovaProfileMemory.findUnique({
        where: { profile_id: profileId },
        select: { facts: true },
      });
      return this.sanitize(row?.facts);
    } catch (err) {
      this.logger.warn(`Could not read memory for ${profileId}`, err);
      return [];
    }
  }

  /**
   * Rebuilds the list from the conversation just had, if it is due.
   *
   * `current` is the exchange that just happened, passed in rather than read
   * back, and that is not an optimisation. The inbound row is written in
   * PARALLEL with the bot (`conversation.service.ts`) and the outbound row only
   * when the message is actually sent, so at the moment this runs neither half
   * of the current turn is reliably in Postgres. Reading history alone would
   * rebuild from everything EXCEPT the exchange that triggered the rebuild —
   * and on a short conversation, where the debounce means this fires once and
   * never again, the most informative turn would be the one always missed.
   *
   * Call it AFTER the reply has been sent, never in front of it. Returns
   * silently on every failure — a memory that could not be updated is a memory
   * one turn out of date, which nobody notices.
   */
  async refresh(
    profileId: string,
    current: { user: string; assistant: string },
  ): Promise<void> {
    try {
      if (!(await this.claimRebuild(profileId))) return;

      // The same race cuts the other way: the inbound row is sometimes written
      // before this runs, in which case history already ends with the message
      // we are about to append. Dropping that trailing duplicate is what makes
      // the result identical whichever way the race fell — otherwise the model
      // would see the person say the same thing twice and could read it as
      // insistence. Compared on `recent`'s own 500-char truncation, and only at
      // the tail, so somebody who genuinely repeats themselves keeps both.
      const past = await this.history.recent(profileId);
      const last = past.at(-1);
      if (last?.role === 'user' && last.text === current.user.slice(0, 500)) {
        past.pop();
      }

      // Older turns first, then the one in hand. No length guard: a greeting or
      // a bare « oui » is answered without a model and never reaches this call,
      // so anything arriving here is a real exchange worth reading — including
      // a first message, which is often the most informative one there is.
      const turns: HistoryTurn[] = [
        ...past,
        { role: 'user', text: current.user },
        { role: 'assistant', text: current.assistant },
      ];

      const existing = await this.read(profileId);
      const facts = await this.derive(turns, existing);
      if (!facts) return;

      // `MemoryFact[]` is structurally JSON, but Prisma's `InputJsonValue`
      // rejects declared interfaces on principle — it cannot know they carry no
      // non-serialisable members. `sanitize` has just rebuilt these objects from
      // primitives, so the cast asserts something already true.
      const json = facts as unknown as Prisma.InputJsonValue;
      await this.prisma.vovaProfileMemory.upsert({
        where: { profile_id: profileId },
        create: { profile_id: profileId, facts: json },
        update: { facts: json },
      });
    } catch (err) {
      this.logger.warn(`Could not refresh memory for ${profileId}`, err);
    }
  }

  /** Renders the facts as prompt lines, or nothing when there are none. */
  static render(facts: MemoryFact[]): string[] {
    if (facts.length === 0) return [];
    return [
      'Ce que tu sais déjà de cette personne, de vos échanges précédents :',
      ...facts.map((fact) => `- ${fact.text}`),
      // Without this the model states remembered facts back as though it had
      // just been told them, and a fact that has quietly stopped being true
      // gets asserted to someone who knows better.
      "Sers-t'en pour ne pas reposer des questions déjà répondues. Ne récite pas cette liste, et si un point paraît dépassé, redemande plutôt que d'affirmer.",
      '',
    ];
  }

  /**
   * One rebuild per person per window. `SET NX EX` is the same claim the
   * new-application notice uses to pace itself, and it is the right primitive
   * here for the same reason: it is atomic across the workers that share this
   * Redis, so two concurrent turns cannot both decide it is their job.
   */
  private async claimRebuild(profileId: string): Promise<boolean> {
    const key = `${REDIS_KEY_PREFIX}vova:memory:rebuild:${profileId}`;
    const claimed = await this.redis.set(
      key,
      '1',
      'EX',
      VovaMemoryService.REBUILD_COOLDOWN_SECONDS,
      'NX',
    );
    return claimed !== null;
  }

  /**
   * Asks the cheap tier for the new list.
   *
   * `cheap` on purpose: this is summarising French chat into short French
   * sentences, which is the least demanding thing the platform asks of a model,
   * and it runs off the reply path where a slower better answer buys nothing.
   */
  private async derive(
    turns: HistoryTurn[],
    existing: MemoryFact[],
  ): Promise<MemoryFact[] | null> {
    const transcript = turns
      .map(
        (turn) => `${turn.role === 'user' ? 'Personne' : 'VoVa'}: ${turn.text}`,
      )
      .join('\n');
    const known = existing.length
      ? existing.map((fact) => `- ${fact.text}`).join('\n')
      : '(aucun)';

    const result = await this.llm.invoke(
      [
        new SystemMessage(
          [
            "Tu tiens à jour ce qu'un assistant d'emploi sait d'une personne.",
            '',
            `Rends au plus ${VovaMemoryService.MAX_FACTS} faits durables, un par ligne, préfixés de "- ".`,
            `Chacun tient en une phrase de moins de ${VovaMemoryService.MAX_FACT_CHARS} caractères, en français, à la troisième personne.`,
            '',
            'Garde ce qui reste vrai dans six mois : métier, quartier, disponibilités, contraintes, matériel, langue.',
            // Without this, "contraintes" quietly licenses the worst of it. A
            // model told to keep durable constraints will happily write down
            // "a un enfant malade" — durable, true, volunteered, and something
            // nobody agreed to have recalled to them for ninety days by a job
            // assistant. Named categories, not a vague instruction: "sois
            // prudent" is not a rule a model can apply.
            "N'écris JAMAIS de fait portant sur : santé, grossesse, handicap, situation familiale, religion, origine ethnique, opinions politiques, orientation sexuelle, casier judiciaire, dettes ou difficultés d'argent.",
            "Si une contrainte vient de l'un de ces sujets, note seulement son effet pratique — « indisponible le mardi matin », jamais sa cause.",
            // The failure mode this list exists to prevent: a memory that fills
            // with the texture of one conversation is a memory that says
            // nothing about the person.
            "Jette ce qui ne vaut que pour aujourd'hui : salutations, remerciements, une question ponctuelle, l'humeur, une offre précise consultée.",
            "N'invente rien. Un fait doit avoir été dit, pas déduit.",
            '',
            'Réécris la liste entière : reprends les faits connus encore valables, ajoute ce qui est nouveau, retire ce qui est contredit.',
            'Si tu ne retiens rien, rends une ligne vide.',
          ].join('\n'),
        ),
        new HumanMessage(
          [`Faits connus :`, known, '', 'Conversation :', transcript].join(
            '\n',
          ),
        ),
      ],
      { tier: 'cheap' },
    );

    const text =
      typeof result.output.content === 'string' ? result.output.content : '';
    const now = new Date().toISOString();
    const facts = text
      .split('\n')
      .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim())
      .filter((line) => line.length > 0)
      .map((line) => ({ text: line, at: now }));

    // An empty answer is a legitimate outcome — a conversation can genuinely
    // carry nothing worth keeping — but it must not silently wipe what is
    // already known, which is what returning `[]` here would do.
    return facts.length > 0 ? this.sanitize(facts) : null;
  }

  /**
   * Trims whatever came back — from the model or from an older row — to what a
   * prompt may safely carry: fresh, short, and few.
   */
  private sanitize(raw: unknown): MemoryFact[] {
    if (!Array.isArray(raw)) return [];
    const floor = Date.now() - VovaMemoryService.STALE_DAYS * 86_400_000;

    return raw
      .filter(
        (item): item is { text: unknown; at: unknown } =>
          typeof item === 'object' && item !== null,
      )
      .map((item) => ({
        text: typeof item.text === 'string' ? item.text.trim() : '',
        at: typeof item.at === 'string' ? item.at : '',
      }))
      .filter((fact) => {
        if (fact.text.length === 0) return false;
        const at = Date.parse(fact.at);
        // An unparseable date is treated as fresh rather than dropped: losing a
        // true fact to a formatting slip is the worse of the two errors.
        return Number.isNaN(at) || at >= floor;
      })
      .map((fact) => ({
        text: fact.text.slice(0, VovaMemoryService.MAX_FACT_CHARS),
        at: fact.at || new Date().toISOString(),
      }))
      .slice(0, VovaMemoryService.MAX_FACTS);
  }
}
