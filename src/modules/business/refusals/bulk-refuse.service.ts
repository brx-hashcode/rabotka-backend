import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ApplicationStatus } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import {
  ApplicationService,
  refusalMessage,
} from '../../application/application.service';
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
  ) {}

  async refuse(profileId: string, offerId: string, dto: BulkRefuseDto) {
    const offer = await this.prisma.jobOffer.findFirst({
      where: { id: offerId, employer_id: profileId, deleted_at: null },
      select: { id: true },
    });
    if (!offer) throw new NotFoundException('Offre introuvable.');
    if (!dto.remaining && !dto.applicationIds?.length) {
      throw new BadRequestException('Choisissez les candidatures à refuser.');
    }
    // Checked once, before anyone is refused: a message with contact details
    // must not leave half the candidates refused.
    const message = refusalMessage(dto.message);

    const targets = await this.prisma.application.findMany({
      where: {
        job_offer_id: offer.id,
        status: { in: WAITING },
        ...(dto.remaining ? {} : { id: { in: dto.applicationIds } }),
      },
      select: { id: true },
    });
    let refused = 0;
    for (const { id } of targets) {
      try {
        await this.applications.reject(id, profileId, message ?? undefined);
        refused++;
      } catch {
        // Answered meanwhile (retained, withdrawn): left as it is.
      }
    }
    const asked = dto.remaining ? targets.length : dto.applicationIds!.length;
    return { refused, skipped: asked - refused };
  }
}
