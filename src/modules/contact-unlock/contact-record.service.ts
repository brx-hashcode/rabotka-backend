import { Injectable, Logger } from '@nestjs/common';
import { ContactRecordOrigin } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { AdminCacheService } from '../../common/services/cache/admin-cache.service';

export type RecordContactInput = {
  employerId: string;
  workerId: string;
  origin: ContactRecordOrigin;
  /** What the employer paid, in FCFA. */
  amount: number;
  unlockedAt: Date;
  /** MISSION only. */
  jobOfferId?: string;
  applicationId?: string;
  contactUnlockAttemptId?: string;
  /** Whichever settled the money. */
  paymentId?: string;
  paymentRequestId?: string;
};

/**
 * Writes the contact ledger — one row per payment an employer made to reach a
 * worker, from either unlock path.
 *
 * Deliberately the only writer. Both paths call `record()` rather than touching
 * `contactRecord` directly, so "what counts as a paid contact" has one
 * definition instead of drifting into two, the way the read-side reconstruction
 * in `contacted-profiles.service.ts` and `paid-contacts.sql.ts` already warns
 * about.
 */
@Injectable()
export class ContactRecordService {
  private readonly logger = new Logger(ContactRecordService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: AdminCacheService,
  ) {}

  /**
   * Records one paid contact. Never throws.
   *
   * The money has already moved by the time this runs, and the contact details
   * have been or are about to be delivered. A ledger write that failed loudly
   * here would roll back a paid unlock — turning a bookkeeping gap into a
   * customer-facing failure, which is strictly worse. Same discipline as the
   * neighbouring `recordUnlockSignal` and `interactionEvents.record` calls.
   */
  async record(input: RecordContactInput): Promise<void> {
    try {
      if (input.contactUnlockAttemptId) {
        // Keyed on the attempt so a retried `payUnlock` or the multi-seat
        // cascade cannot write the same unlock twice. `update` carries no
        // fields: re-running must not move `unlocked_at` or the amount, only
        // prove the row is there.
        await this.prisma.contactRecord.upsert({
          where: { contact_unlock_attempt_id: input.contactUnlockAttemptId },
          create: this.toCreateData(input),
          update: {},
        });
      } else {
        // DIRECT unlocks have no natural key: paying twice for the same worker
        // is charged twice, so it is two rows. See the model comment.
        await this.prisma.contactRecord.create({
          data: this.toCreateData(input),
        });
      }

      await this.cache.invalidate('contact-records');
    } catch (err) {
      this.logger.error(
        `[contact-record] failed to record ${input.origin} contact employer=${input.employerId} worker=${input.workerId}`,
        err,
      );
    }
  }

  private toCreateData(input: RecordContactInput) {
    return {
      employer_id: input.employerId,
      worker_id: input.workerId,
      origin: input.origin,
      amount: input.amount,
      unlocked_at: input.unlockedAt,
      job_offer_id: input.jobOfferId ?? null,
      application_id: input.applicationId ?? null,
      contact_unlock_attempt_id: input.contactUnlockAttemptId ?? null,
      payment_id: input.paymentId ?? null,
      payment_request_id: input.paymentRequestId ?? null,
    };
  }
}
