import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ApplicationStatus, ExternalApplicationStatus } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import {
  ApplicationService,
  refusalMessage,
} from '../../application/application.service';
import { CareersService } from '../careers/careers.service';
import type { BulkRefuseDto } from './dto/bulk-refuse.dto';

const WAITING: ApplicationStatus[] = [
  ApplicationStatus.PENDING,
  ApplicationStatus.VIEWED,
];

/**
 * Several refusals at once on one offer — those picked, or every application
 * still waiting once the posts are filled — each through the usual refusal,
 * so every candidate is told as with a single one, the same message for all.
 */
@Injectable()
export class BulkRefuseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly applications: ApplicationService,
    private readonly careers: CareersService,
  ) {}

  async refuse(profileId: string, offerId: string, dto: BulkRefuseDto) {
    const offer = await this.prisma.jobOffer.findFirst({
      where: { id: offerId, employer_id: profileId, deleted_at: null },
      select: { id: true },
    });
    if (!offer) throw new NotFoundException('Offre introuvable.');
    if (
      !dto.remaining &&
      !dto.applicationIds?.length &&
      !dto.externalIds?.length
    ) {
      throw new BadRequestException('Choisissez les candidatures à refuser.');
    }
    // Checked once, before anyone is refused: a message with contact details
    // must not leave half the candidates refused.
    const message = refusalMessage(dto.message);

    const picked = dto.applicationIds ?? [];
    const pickedExternal = dto.externalIds ?? [];
    const [targets, externalTargets] = await Promise.all([
      dto.remaining || picked.length
        ? this.prisma.application.findMany({
            where: {
              job_offer_id: offer.id,
              status: { in: WAITING },
              ...(dto.remaining ? {} : { id: { in: picked } }),
            },
            select: { id: true },
          })
        : [],
      dto.remaining || pickedExternal.length
        ? this.prisma.externalApplication.findMany({
            where: {
              job_offer_id: offer.id,
              status: ExternalApplicationStatus.PENDING,
              ...(dto.remaining ? {} : { id: { in: pickedExternal } }),
            },
            select: { id: true },
          })
        : [],
    ]);
    let refused = 0;
    for (const { id } of targets) {
      try {
        await this.applications.reject(id, profileId, message ?? undefined);
        refused++;
      } catch {
        // Answered meanwhile (retained, withdrawn): left as it is.
      }
    }
    // Careers-page candidates: the same refusal as from their card (an
    // e-mail with the message), one after the other on the server rather
    // than one request each from the browser.
    for (const { id } of externalTargets) {
      try {
        const done = await this.careers.refuse(
          profileId,
          id,
          message ?? undefined,
        );
        if (done.refused) refused++;
      } catch {
        // Retained meanwhile: left as it is.
      }
    }
    const asked = dto.remaining
      ? targets.length + externalTargets.length
      : picked.length + pickedExternal.length;
    return { refused, skipped: asked - refused };
  }
}
