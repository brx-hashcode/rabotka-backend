import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ContactRecordOrigin } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { CONTACTABLE_WORKER } from '../recommendation/contactable-worker';
import { BusinessSubscriptionService } from './subscription/business-subscription.service';

/**
 * The workers whose contact a business unlocked, with the details that unlock
 * paid for. A business gets no WhatsApp, so this list is where it reads them —
 * the same name, phone and email the WhatsApp delivery carries to others.
 * Only its own unlocks (contact_records is the ledger of who paid for whom).
 */
@Injectable()
export class BusinessContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: BusinessSubscriptionService,
  ) {}

  async list(profileId: string, workerId?: string) {
    const records = await this.prisma.contactRecord.findMany({
      where: {
        employer_id: profileId,
        ...(workerId ? { worker_id: workerId } : {}),
      },
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

  /**
   * Reveals a worker found in the business's search, on its plan's contact
   * quota — no fee, no WhatsApp: the details come back here. A worker already
   * unlocked by this business comes back as is, without spending a unit.
   * Only an active, verified worker (the rule every paid unlock follows).
   */
  async unlock(profileId: string, workerId: string) {
    const [existing] = await this.list(profileId, workerId);
    if (existing) return { contact: existing, spent: false };
    // The search it comes from is a plan feature; so is reaching out from it.
    await this.subscriptions.assertFeature(profileId, 'preselection');

    const worker = await this.prisma.profile.findFirst({
      where: { id: workerId, ...CONTACTABLE_WORKER },
      select: { id: true },
    });
    if (!worker) {
      throw new NotFoundException("Ce profil n'est plus actif ou vérifié.");
    }

    await this.prisma.$transaction(async (tx) => {
      const recordId = randomUUID();
      // The record first: the usage row points at it.
      await tx.contactRecord.create({
        data: {
          id: recordId,
          employer_id: profileId,
          worker_id: workerId,
          origin: ContactRecordOrigin.DIRECT,
          amount: 0,
          unlocked_at: new Date(),
        },
      });
      const covered = await this.subscriptions.consumeDirectUnlock(
        profileId,
        recordId,
        tx,
      );
      // Rolls the record back with it.
      if (!covered) {
        throw new ForbiddenException(
          'Vous avez utilisé tous les contacts inclus dans votre formule. Passez à une formule supérieure depuis « Abonnement ».',
        );
      }
    });

    const [contact] = await this.list(profileId, workerId);
    return { contact, spent: true };
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
