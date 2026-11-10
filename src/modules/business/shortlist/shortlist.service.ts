import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ApplicationStatus, ExternalApplicationStatus } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import type { BulkShortlistDto } from './dto/shortlist.dto';

/** What « Présélectionnée » may be put on or taken off: a candidature still waiting. */
const WAITING_RABOTKA: ApplicationStatus[] = [
  ApplicationStatus.PENDING,
  ApplicationStatus.VIEWED,
];
const WAITING_EXTERNAL: ExternalApplicationStatus[] = [
  ExternalApplicationStatus.PENDING,
];

export type ShortlistKind = 'rabotka' | 'external';

/**
 * « Présélectionnée »: a step between « Vue » and « Retenue » that only the
 * business sees. It is a date on the candidature, not a status: the status
 * drives the candidate's side (bot, apps, reminders), which this never
 * touches, and the candidate is never told. Retaining or refusing takes the
 * candidature out of the step; the date stays as history.
 */
@Injectable()
export class ShortlistService {
  constructor(private readonly prisma: PrismaService) {}

  /** One candidature, from its card: answered 409 once it is decided. */
  async set(
    profileId: string,
    kind: ShortlistKind,
    id: string,
    shortlisted: boolean,
  ) {
    const at = shortlisted ? new Date() : null;
    if (kind === 'rabotka') {
      const app = await this.prisma.application.findFirst({
        where: {
          id,
          deleted_at: null,
          job_offer: { employer_id: profileId, deleted_at: null },
        },
        select: { status: true, shortlisted_at: true },
      });
      if (!app) throw new NotFoundException('Candidature introuvable.');
      if (!WAITING_RABOTKA.includes(app.status)) throw this.decided();
      // Shortlisting twice keeps the first date: the Historique says when.
      if (shortlisted && app.shortlisted_at)
        return this.view(app.shortlisted_at);
      await this.prisma.application.update({
        where: { id },
        data: { shortlisted_at: at },
      });
      return this.view(at);
    }
    const app = await this.prisma.externalApplication.findFirst({
      where: { id, job_offer: { employer_id: profileId, deleted_at: null } },
      select: { status: true, shortlisted_at: true },
    });
    if (!app) throw new NotFoundException('Candidature introuvable.');
    if (!WAITING_EXTERNAL.includes(app.status)) throw this.decided();
    if (shortlisted && app.shortlisted_at) return this.view(app.shortlisted_at);
    await this.prisma.externalApplication.update({
      where: { id },
      data: { shortlisted_at: at },
    });
    return this.view(at);
  }

  /**
   * Several candidatures of one offer at once. Only those still waiting
   * change; the others (decided meanwhile, another offer's) are skipped.
   */
  async bulk(profileId: string, offerId: string, dto: BulkShortlistDto) {
    const rabotka = dto.rabotka ?? [];
    const external = dto.external ?? [];
    if (rabotka.length + external.length === 0) {
      throw new BadRequestException('Choisissez les candidatures.');
    }
    const offer = await this.prisma.jobOffer.findFirst({
      where: { id: offerId, employer_id: profileId, deleted_at: null },
      select: { id: true },
    });
    if (!offer) throw new NotFoundException('Offre introuvable.');

    const at = dto.shortlisted ? new Date() : null;
    // Shortlisting keeps a date already set; taking off clears any.
    const keepDate = dto.shortlisted ? { shortlisted_at: null } : {};
    const [a, b] = await Promise.all([
      rabotka.length
        ? this.prisma.application.updateMany({
            where: {
              id: { in: rabotka },
              job_offer_id: offer.id,
              deleted_at: null,
              status: { in: WAITING_RABOTKA },
              ...keepDate,
            },
            data: { shortlisted_at: at },
          })
        : { count: 0 },
      external.length
        ? this.prisma.externalApplication.updateMany({
            where: {
              id: { in: external },
              job_offer_id: offer.id,
              status: { in: WAITING_EXTERNAL },
              ...keepDate,
            },
            data: { shortlisted_at: at },
          })
        : { count: 0 },
    ]);
    const changed = a.count + b.count;
    return { changed, skipped: rabotka.length + external.length - changed };
  }

  private view(at: Date | null) {
    return {
      shortlisted: at !== null,
      shortlistedAt: at?.toISOString() ?? null,
    };
  }

  private decided() {
    return new ConflictException(
      'Cette candidature est déjà retenue ou refusée.',
    );
  }
}
