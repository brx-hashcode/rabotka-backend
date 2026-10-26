import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';

/**
 * The workers whose contact a business unlocked, with the details that unlock
 * paid for. A business gets no WhatsApp, so this list is where it reads them —
 * the same name, phone and email the WhatsApp delivery carries to others.
 * Only its own unlocks (contact_records is the ledger of who paid for whom).
 */
@Injectable()
export class BusinessContactsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(profileId: string) {
    const records = await this.prisma.contactRecord.findMany({
      where: { employer_id: profileId },
      orderBy: { unlocked_at: 'desc' },
      take: 500,
      select: {
        worker_id: true,
        origin: true,
        unlocked_at: true,
        job_offer: { select: { id: true, title: true, deleted_at: true } },
        worker: {
          select: {
            first_name: true,
            last_name: true,
            avatar_url: true,
            phone: true,
            email: true,
            city: true,
            category: { select: { name: true } },
          },
        },
      },
    });

    // One row per worker: the latest unlock, and every offer it came through.
    const byWorker = new Map<string, ReturnType<typeof toContact>>();
    for (const r of records) {
      const seen = byWorker.get(r.worker_id);
      const offer =
        r.job_offer && !r.job_offer.deleted_at
          ? { id: r.job_offer.id, title: r.job_offer.title }
          : null;
      if (!seen) {
        byWorker.set(r.worker_id, toContact(r, offer));
      } else if (offer && !seen.offers.some((o) => o.id === offer.id)) {
        seen.offers.push(offer);
      }
    }
    return [...byWorker.values()];
  }
}

function toContact(
  r: {
    worker_id: string;
    origin: string;
    unlocked_at: Date;
    worker: {
      first_name: string;
      last_name: string;
      avatar_url: string | null;
      phone: string;
      email: string | null;
      city: string | null;
      category: { name: string } | null;
    };
  },
  offer: { id: string; title: string } | null,
) {
  return {
    workerId: r.worker_id,
    firstName: r.worker.first_name,
    lastName: r.worker.last_name,
    avatarUrl: r.worker.avatar_url,
    phone: r.worker.phone,
    email: r.worker.email,
    city: r.worker.city,
    categoryName: r.worker.category?.name ?? null,
    unlockedAt: r.unlocked_at.toISOString(),
    origin: r.origin,
    offers: offer ? [offer] : [],
  };
}
