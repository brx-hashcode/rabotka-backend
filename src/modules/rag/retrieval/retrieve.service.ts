import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { expandQuery } from './aliases';
import {
  HelpDocsStore,
  type HelpAudience,
  type HelpHit,
} from './help-docs.store';
import { readNumber } from '../shared/config';

export interface RetrievalResult {
  hits: HelpHit[];
  /** The expanded string actually embedded — logged so recall gaps are debuggable. */
  expandedQuery: string;
  /**
   * Tools a retrieved chunk says must be called before answering. The agent
   * reads this rather than deciding for itself, which is how "never quote a fee
   * from memory" gets a mechanism instead of only a sentence in a prompt.
   */
  requiredTools: string[];
}

/**
 * `rechercher_aide` — the only source of policy and how-to facts.
 *
 * Returns an empty hit list rather than throwing when the index is unreachable.
 * An assistant that says "je ne trouve pas, voici le support" is correct
 * behaviour under `PROJECT_CONTEXT.md` §10; one that 500s mid-conversation is
 * a WhatsApp message that never arrives.
 */
@Injectable()
export class HelpRetrieveService {
  private readonly logger = new Logger(HelpRetrieveService.name);
  private readonly defaultLimit: number;
  private readonly gapScore: number;

  constructor(
    private readonly store: HelpDocsStore,
    config: ConfigService,
  ) {
    this.defaultLimit = readNumber(config, 'VOVA_RETRIEVAL_LIMIT', 5);
    // RRF scores are ordinal, not probabilities: the top hit of a good match
    // sits near 0.75 and a poor one near 0.5. Tuned from the live suite.
    this.gapScore = readNumber(config, 'VOVA_GAP_SCORE', 0.55);
  }

  async search(
    question: string,
    limit?: number,
    audience?: HelpAudience,
    /** Non-French questions skip the English-only lexical leg. */
    denseOnly = false,
  ): Promise<RetrievalResult> {
    const expandedQuery = expandQuery(question);
    const empty: RetrievalResult = {
      hits: [],
      expandedQuery,
      requiredTools: [],
    };

    if (!question?.trim()) return empty;

    try {
      const hits = await this.store.search(
        expandedQuery,
        limit ?? this.defaultLimit,
        audience,
        denseOnly,
      );
      // A question the corpus cannot answer is the most valuable line in the
      // log: it is the next article, written from what people actually ask
      // rather than what we imagined they would.
      //
      // This is as close to "learning" as the system gets, and deliberately so
      // — see the note in `docs/` on why model answers must never be fed back
      // into the corpus automatically.
      const best = hits[0]?.score ?? 0;
      if (hits.length === 0 || best < this.gapScore) {
        this.logger.warn(
          `vova.gap score=${best.toFixed(3)} question=${JSON.stringify(question)} ` +
            `best=${hits[0]?.source ?? 'none'}`,
        );
      }

      return {
        hits,
        expandedQuery,
        requiredTools: [
          ...new Set(
            hits
              .map((h) => h.needsTool)
              .filter(
                (t): t is string => typeof t === 'string' && t.length > 0,
              ),
          ),
        ],
      };
    } catch (err) {
      this.logger.error(`Help retrieval failed for "${question}"`, err);
      return empty;
    }
  }
}
