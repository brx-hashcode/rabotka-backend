import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  forwardRef,
  Inject,
} from '@nestjs/common';
import {
  BillingStatus,
  ContactUnlockStatus,
  WalletTransactionType,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { WalletService } from '../wallet/wallet.service';

export type ContactDetails = {
  name: string;
  phone: string;
  email: string;
};

export type ExpiredConversionEvent = {
  profileId: string;
  amount: number;
};

/** Returned by payUnlock — includes all attempts that transitioned to UNLOCKED */
export type PayUnlockResult = {
  attemptId: string;
  status: ContactUnlockStatus;
  /** Attempts that became UNLOCKED as a side-effect (multi-person job bulk update) */
  newlyUnlocked: string[];
};

@Injectable()
export class ContactUnlockService {
  private readonly logger = new Logger(ContactUnlockService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfig: SystemConfigService,
    @Inject(forwardRef(() => WalletService))
    private readonly walletService: WalletService,
  ) {}

  /**
   * Creates a ContactUnlockAttempt when an employer accepts a candidate.
   * Idempotent: returns existing attempt if one already exists.
   *
   * For multi-person jobs (quantity > 1): if the employer has already paid at the
   * job level, the new attempt is created with employer_paid = true immediately.
   */
  async initiateUnlock(applicationId: string, employerId: string) {
    const existing = await this.prisma.contactUnlockAttempt.findUnique({
      where: { application_id: applicationId },
    });
    if (existing) return existing;

    const app = await this.prisma.application.findUnique({
      where: { id: applicationId },
      select: { worker_id: true, job_offer_id: true },
    });
    if (!app) throw new NotFoundException('Candidature introuvable');

    const jobOffer = await this.prisma.jobOffer.findUnique({
      where: { id: app.job_offer_id },
      select: { quantity: true, employer_unlock_paid: true },
    });
    if (!jobOffer) throw new NotFoundException('Offre introuvable');

    const fees = await this.systemConfig.getContactUnlockFees();
    const expiresAt = new Date(Date.now() + fees.expiryHours * 60 * 60 * 1000);

    const isMultiPerson = (jobOffer.quantity ?? 1) > 1;
    const employerAlreadyPaid = isMultiPerson && jobOffer.employer_unlock_paid;

    const now = new Date();

    return this.prisma.contactUnlockAttempt.create({
      data: {
        application_id: applicationId,
        job_offer_id: app.job_offer_id,
        worker_id: app.worker_id,
        employer_id: employerId,
        status: employerAlreadyPaid
          ? ContactUnlockStatus.PENDING_WORKER
          : ContactUnlockStatus.PENDING_BOTH,
        employer_paid: employerAlreadyPaid,
        employer_paid_at: employerAlreadyPaid ? now : null,
        employer_amount: fees.employerFeeFcfa,
        worker_amount: fees.workerFeeFcfa,
        expires_at: expiresAt,
      },
    });
  }

  /**
   * Records a payment/credit deduction for one party of an unlock attempt.
   *
   * For multi-person jobs (quantity > 1) when the employer pays:
   *  - Sets job_offer.employer_unlock_paid = true
   *  - Marks employer_paid = true on ALL existing attempts for that job offer
   *  - Returns the list of attempt IDs that became UNLOCKED as a side-effect
   */
  async payUnlock(
    attemptId: string,
    profileId: string,
    useCredit: boolean,
  ): Promise<PayUnlockResult> {
    const attempt = await this.prisma.contactUnlockAttempt.findUnique({
      where: { id: attemptId },
    });
    if (!attempt)
      throw new NotFoundException('Tentative de déverrouillage introuvable');
    if (attempt.status === ContactUnlockStatus.UNLOCKED) {
      return {
        attemptId,
        status: ContactUnlockStatus.UNLOCKED,
        newlyUnlocked: [],
      };
    }
    if (
      attempt.status === ContactUnlockStatus.EXPIRED ||
      attempt.status === ContactUnlockStatus.CONVERTED_TO_CREDIT
    ) {
      throw new BadRequestException(
        'Cette tentative de déverrouillage a expiré',
      );
    }

    const isEmployer = attempt.employer_id === profileId;
    const isWorker = attempt.worker_id === profileId;
    if (!isEmployer && !isWorker) {
      throw new ForbiddenException(
        "Vous n'êtes pas autorisé à déverrouiller ce contact",
      );
    }

    // Check billing status
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { billing_status: true },
    });
    if (profile?.billing_status === BillingStatus.BLOCKED) {
      throw new ForbiddenException(
        'Votre compte est bloqué. Réglez vos pénalités pour continuer.',
      );
    }

    // Check if already paid by this party
    if (isEmployer && attempt.employer_paid) {
      throw new BadRequestException(
        'Vous avez déjà payé pour ce déverrouillage',
      );
    }
    if (isWorker && attempt.worker_paid) {
      throw new BadRequestException(
        'Vous avez déjà payé pour ce déverrouillage',
      );
    }

    const amount = isEmployer
      ? Number(attempt.employer_amount)
      : Number(attempt.worker_amount);

    if (useCredit) {
      await this.walletService.debitProfileWallet(
        profileId,
        amount,
        WalletTransactionType.CONTACT_UNLOCK_DEBIT,
        'contact_unlock_attempt',
        attemptId,
      );
    }
    // Cash payment path: payment record creation is handled externally

    const now = new Date();

    // --- Multi-person job: employer pays once for the whole job ---
    if (isEmployer) {
      const jobOffer = await this.prisma.jobOffer.findUnique({
        where: { id: attempt.job_offer_id },
        select: { quantity: true, employer_unlock_paid: true },
      });

      if ((jobOffer?.quantity ?? 1) > 1) {
        return this._handleMultiPersonEmployerPay(attempt, now);
      }
    }

    // --- Standard per-attempt logic (quantity = 1 or worker paying) ---
    const updatedData: Record<string, unknown> = isEmployer
      ? { employer_paid: true, employer_paid_at: now }
      : { worker_paid: true, worker_paid_at: now };

    const updatedEmployerPaid = isEmployer ? true : attempt.employer_paid;
    const updatedWorkerPaid = isWorker ? true : attempt.worker_paid;

    let newStatus: ContactUnlockStatus;
    if (updatedEmployerPaid && updatedWorkerPaid) {
      newStatus = ContactUnlockStatus.UNLOCKED;
      updatedData['unlocked_at'] = now;
    } else if (updatedEmployerPaid && !updatedWorkerPaid) {
      newStatus = ContactUnlockStatus.PENDING_WORKER;
    } else {
      newStatus = ContactUnlockStatus.PENDING_EMPLOYER;
    }
    updatedData['status'] = newStatus;

    const updated = await this.prisma.contactUnlockAttempt.update({
      where: { id: attemptId },
      data: updatedData,
    });

    return {
      attemptId: updated.id,
      status: updated.status,
      newlyUnlocked:
        newStatus === ContactUnlockStatus.UNLOCKED ? [attemptId] : [],
    };
  }

  /**
   * Handles the employer paying for a multi-person job (quantity > 1).
   * Sets employer_unlock_paid = true on the job offer and marks employer_paid = true
   * on ALL existing attempts for that job, cascading to UNLOCKED where worker already paid.
   */
  private async _handleMultiPersonEmployerPay(
    triggerAttempt: { id: string; job_offer_id: string; worker_paid: boolean },
    now: Date,
  ): Promise<PayUnlockResult> {
    // Mark job-level employer payment
    await this.prisma.jobOffer.update({
      where: { id: triggerAttempt.job_offer_id },
      data: { employer_unlock_paid: true, employer_unlock_paid_at: now },
    });

    // Get all pending attempts for this job where employer hasn't paid yet
    const pendingAttempts = await this.prisma.contactUnlockAttempt.findMany({
      where: {
        job_offer_id: triggerAttempt.job_offer_id,
        employer_paid: false,
        status: {
          in: [
            ContactUnlockStatus.PENDING_BOTH,
            ContactUnlockStatus.PENDING_EMPLOYER,
          ],
        },
      },
    });

    const newlyUnlocked: string[] = [];

    for (const a of pendingAttempts) {
      const willUnlock = a.worker_paid;
      await this.prisma.contactUnlockAttempt.update({
        where: { id: a.id },
        data: {
          employer_paid: true,
          employer_paid_at: now,
          status: willUnlock
            ? ContactUnlockStatus.UNLOCKED
            : ContactUnlockStatus.PENDING_WORKER,
          ...(willUnlock ? { unlocked_at: now } : {}),
        },
      });
      if (willUnlock) newlyUnlocked.push(a.id);
    }

    // Also update PENDING_WORKER attempts for this job that didn't need employer pay
    // (they were already employer_paid=true from initiateUnlock, nothing to do)

    const triggerStatus = triggerAttempt.worker_paid
      ? ContactUnlockStatus.UNLOCKED
      : ContactUnlockStatus.PENDING_WORKER;

    if (
      triggerAttempt.worker_paid &&
      !newlyUnlocked.includes(triggerAttempt.id)
    ) {
      newlyUnlocked.push(triggerAttempt.id);
    }

    return {
      attemptId: triggerAttempt.id,
      status: triggerStatus,
      newlyUnlocked,
    };
  }

  /**
   * Returns the contact details of the other party if the attempt is UNLOCKED.
   */
  async getContactsIfUnlocked(
    attemptId: string,
    requestingProfileId: string,
  ): Promise<ContactDetails | null> {
    const attempt = await this.prisma.contactUnlockAttempt.findUnique({
      where: { id: attemptId },
    });
    if (!attempt || attempt.status !== ContactUnlockStatus.UNLOCKED)
      return null;

    const isEmployer = attempt.employer_id === requestingProfileId;
    const isWorker = attempt.worker_id === requestingProfileId;
    if (!isEmployer && !isWorker) return null;

    const otherPartyId = isEmployer ? attempt.worker_id : attempt.employer_id;
    const other = await this.prisma.profile.findUnique({
      where: { id: otherPartyId },
      select: { first_name: true, last_name: true, phone: true, email: true },
    });
    if (!other) return null;

    return {
      name: `${other.first_name} ${other.last_name}`.trim(),
      phone: other.phone,
      email: other.email,
    };
  }

  /**
   * Finds the most recent pending unlock attempt for a given profile (worker or employer).
   */
  async findPendingAttemptForProfile(profileId: string) {
    return await this.prisma.contactUnlockAttempt.findFirst({
      where: {
        OR: [{ worker_id: profileId }, { employer_id: profileId }],
        status: {
          in: [
            ContactUnlockStatus.PENDING_BOTH,
            ContactUnlockStatus.PENDING_EMPLOYER,
            ContactUnlockStatus.PENDING_WORKER,
          ],
        },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  /**
   * Gets an unlock attempt by application ID.
   */
  async getByApplicationId(applicationId: string) {
    return await this.prisma.contactUnlockAttempt.findUnique({
      where: { application_id: applicationId },
    });
  }

  /**
   * Processes expired unlock attempts.
   *
   * Multi-person jobs (quantity > 1): if the employer already paid at job level
   * (employer_unlock_paid = true), the employer is NOT refunded on expiry —
   * their single payment covers all candidates. Only the worker is refunded if they paid.
   *
   * Standard jobs (quantity = 1): original CONVERTED_TO_CREDIT logic applies.
   */
  async processExpiredAttempts(): Promise<ExpiredConversionEvent[]> {
    const expired = await this.prisma.contactUnlockAttempt.findMany({
      where: {
        status: {
          in: [
            ContactUnlockStatus.PENDING_BOTH,
            ContactUnlockStatus.PENDING_EMPLOYER,
            ContactUnlockStatus.PENDING_WORKER,
          ],
        },
        expires_at: { lt: new Date() },
      },
      include: {
        job_offer: { select: { quantity: true, employer_unlock_paid: true } },
      },
    });

    const conversions: ExpiredConversionEvent[] = [];

    for (const attempt of expired) {
      try {
        const now = new Date();
        let newStatus: ContactUnlockStatus = ContactUnlockStatus.EXPIRED;

        const isMultiPerson = (attempt.job_offer.quantity ?? 1) > 1;
        const employerPaidAtJobLevel =
          isMultiPerson && attempt.job_offer.employer_unlock_paid;

        if (employerPaidAtJobLevel) {
          // Employer paid once for the whole job — do not refund employer.
          // Only refund worker if they paid for this specific attempt.
          if (attempt.worker_paid) {
            const amount = Number(attempt.worker_amount);
            await this.walletService.creditProfileWallet(
              attempt.worker_id,
              amount,
              WalletTransactionType.CONTACT_UNLOCK_CREDIT_CONVERSION,
              'contact_unlock_attempt',
              attempt.id,
            );
            newStatus = ContactUnlockStatus.CONVERTED_TO_CREDIT;
            conversions.push({ profileId: attempt.worker_id, amount });
          }
          // Employer is NOT refunded — EXPIRED, not CONVERTED_TO_CREDIT
        } else {
          // Standard per-attempt refund logic
          if (attempt.employer_paid && !attempt.worker_paid) {
            const amount = Number(attempt.employer_amount);
            await this.walletService.creditProfileWallet(
              attempt.employer_id,
              amount,
              WalletTransactionType.CONTACT_UNLOCK_CREDIT_CONVERSION,
              'contact_unlock_attempt',
              attempt.id,
            );
            newStatus = ContactUnlockStatus.CONVERTED_TO_CREDIT;
            conversions.push({ profileId: attempt.employer_id, amount });
          } else if (attempt.worker_paid && !attempt.employer_paid) {
            const amount = Number(attempt.worker_amount);
            await this.walletService.creditProfileWallet(
              attempt.worker_id,
              amount,
              WalletTransactionType.CONTACT_UNLOCK_CREDIT_CONVERSION,
              'contact_unlock_attempt',
              attempt.id,
            );
            newStatus = ContactUnlockStatus.CONVERTED_TO_CREDIT;
            conversions.push({ profileId: attempt.worker_id, amount });
          }
        }

        await this.prisma.contactUnlockAttempt.update({
          where: { id: attempt.id },
          data: { status: newStatus, converted_at: now },
        });

        this.logger.log(
          `Unlock attempt ${attempt.id} expired → status=${newStatus}`,
        );
      } catch (err) {
        this.logger.error(
          `Failed to process expired unlock attempt ${attempt.id}`,
          err,
        );
      }
    }

    return conversions;
  }
}
