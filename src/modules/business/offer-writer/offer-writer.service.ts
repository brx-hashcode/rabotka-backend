import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { LlmService } from '../../rag/llm/llm.service';
import { BUSINESS_CATEGORY_LABELS } from '../business-catalog';
import { BusinessSubscriptionService } from '../subscription/business-subscription.service';
import type { OfferDraftDto } from './dto/offer-draft.dto';
import {
  draftMessages,
  JSON_REMINDER,
  parseDraft,
  type OfferDraft,
} from './offer-writer';

/** Longest wait for one answer before the next model gets its turn. */
const LLM_TIMEOUT_MS = 45_000;

/**
 * « Rédiger avec l'IA »: writes an offer from a few words, within the plan's
 * « offres rédigées par l'IA ». A draft that could not be written is given
 * back: it does not count.
 */
@Injectable()
export class OfferWriterService {
  private readonly logger = new Logger(OfferWriterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly subscriptions: BusinessSubscriptionService,
  ) {}

  async draft(profileId: string, dto: OfferDraftDto) {
    const businessId = await this.subscriptions.businessOf(profileId);
    if (!businessId) {
      throw new ForbiddenException('Espace réservé aux comptes entreprise.');
    }
    const [business, trades] = await Promise.all([
      this.prisma.business.findUnique({
        where: { id: businessId },
        select: { name: true, category: true },
      }),
      this.prisma.jobCategory.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    const { subscriptionId } =
      await this.subscriptions.consumeOfferDraft(businessId);

    const names = trades.map((t) => t.name);
    const messages = draftMessages(
      {
        brief: dto.brief.trim(),
        title: dto.title?.trim() || null,
        employmentType: dto.employmentType ?? null,
        city: dto.city?.trim() || null,
        isRemote: dto.isRemote ?? false,
        quantity: dto.quantity ?? null,
        businessName: business?.name ?? '',
        businessCategory: business
          ? BUSINESS_CATEGORY_LABELS[business.category]
          : null,
      },
      names,
    );

    let draft: OfferDraft | null = null;
    try {
      const options = {
        tier: 'writing' as const,
        timeoutMs: LLM_TIMEOUT_MS,
        correlationId: `offer-draft:${businessId}`,
      };
      const first = text(
        (await this.llm.invoke(messages, options)).output.content,
      );
      draft = parseDraft(first, names);
      if (!draft) {
        const second = text(
          (
            await this.llm.invoke(
              [
                ...messages,
                new AIMessage(first),
                new HumanMessage(JSON_REMINDER),
              ],
              options,
            )
          ).output.content,
        );
        draft = parseDraft(second, names);
      }
    } catch (err) {
      this.logger.warn(
        `Offer draft failed for business ${businessId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!draft) {
      await this.subscriptions.releaseOfferDraft(subscriptionId);
      throw new ServiceUnavailableException(
        'La rédaction n’a pas abouti. Réessayez dans un instant : elle n’est pas décomptée.',
      );
    }

    const e = await this.subscriptions.entitlements(businessId);
    return {
      ...draft,
      categoryId: trades.find((t) => t.name === draft.categoryName)?.id ?? null,
      remaining: e.offerDraftsRemaining,
    };
  }
}

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) =>
        typeof part === 'string'
          ? part
          : part &&
              typeof part === 'object' &&
              'text' in part &&
              typeof part.text === 'string'
            ? part.text
            : '',
      )
      .join('');
  }
  return '';
}
