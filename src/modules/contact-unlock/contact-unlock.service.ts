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
  ApplicationStatus,
  AssignmentStatus,
  BillingStatus,
  ContactUnlockAttempt,
  ContactUnlockStatus,
  InvoiceReason,
  JobOfferStatus,
  PaymentMethod,
  PaymentRequestStatus,
  PaymentStatus,
  PaymentType,
  Prisma,
  WalletTransactionType,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { isWorkerHardBlocked } from '../penalty/penalty.utils';
import { SystemConfigService } from '../system-config/system-config.service';
import { WalletService } from '../wallet/wallet.service';
import { InvoiceService } from '../invoice/invoice.service';
import { MatchingService } from '../matching/matching.service';
import { generatePaymentReference } from '../../common/utils/payment-reference';
import { randomUUID } from 'node:crypto';

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
    private readonly invoiceService: InvoiceService,
    private readonly matchingService: MatchingService,
  ) {}

  private shouldReopenOffer(params: {
    scheduledAt: Date;
    currentStatus: JobOfferStatus;
    now: Date;
  }): boolean {
    if (params.scheduledAt <= params.now) return false;
    if (
      params.currentStatus === JobOfferStatus.IN_PROGRESS ||
      params.currentStatus === JobOfferStatus.COMPLETED
    ) {
      return false;
    }
    return true;
  }

  private jobOfferStatusFromRemainingAccepted(
    remainingAccepted: number,
    quantity: number,
  ): JobOfferStatus {
    if (remainingAccepted >= quantity) return JobOfferStatus.FILLED;
    if (remainingAccepted > 0) return JobOfferStatus.PARTIALLY_FILLED;
    return JobOfferStatus.ACTIVE;
  }

  /**
   * Validates attempt state and payer; returns early result when already unlocked.
   */
  private ensurePayUnlockAttemptOrEarlyExit(
    attempt: ContactUnlockAttempt | null,
    attemptId: string,
  ): PayUnlockResult | null {
    if (!attempt) {
      throw new NotFoundException('Tentative de déverrouillage introuvable');
    }
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
    return null;
  }

  private assertPayUnlockParticipant(
    attempt: ContactUnlockAttempt,
    profileId: string,
  ): { isEmployer: boolean; isWorker: boolean } {
    const isEmployer = attempt.employer_id === profileId;
    const isWorker = attempt.worker_id === profileId;
    if (!isEmployer && !isWorker) {
      throw new ForbiddenException(
        "Vous n'êtes pas autorisé à déverrouiller ce contact",
      );
    }
    return { isEmployer, isWorker };
  }

  private async assertPayUnlockAccountAllowsPayment(
    profileId: string,
  ): Promise<void> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { billing_status: true },
    });
    if (profile?.billing_status === BillingStatus.BLOCKED) {
      throw new ForbiddenException(
        'Votre compte est bloqué. Réglez vos pénalités pour continuer.',
      );
    }

    const hardBlocked = await isWorkerHardBlocked(this.prisma, profileId);
    if (hardBlocked) {
      throw new ForbiddenException(
        '🚨 Votre compte est bloqué en raison de pénalités impayées depuis plus de 3 jours. Tapez PAYER pour régulariser votre situation.',
      );
    }
  }

  private assertPayUnlockPartyNotAlreadyPaid(
    attempt: ContactUnlockAttempt,
    isEmployer: boolean,
    isWorker: boolean,
  ): void {
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
  }

  private async commitStandardPerAttemptPayUnlock(params: {
    attemptId: string;
    attempt: ContactUnlockAttempt;
    isEmployer: boolean;
    isWorker: boolean;
    now: Date;
  }): Promise<PayUnlockResult> {
    const { attemptId, attempt, isEmployer, isWorker, now } = params;
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

    // Atomic idempotency guard: only update if the party has not already paid.
    // This prevents a double-charge if two concurrent requests both pass the
    // in-memory assertPayUnlockPartyNotAlreadyPaid check.
    const guardCondition = isEmployer
      ? { employer_paid: false }
      : { worker_paid: false };
    const guardResult = await this.prisma.contactUnlockAttempt.updateMany({
      where: { id: attemptId, ...guardCondition },
      data: updatedData,
    });
    if (guardResult.count === 0) {
      throw new BadRequestException('Ce paiement a déjà été enregistré pour cette partie');
    }
    const updated = await this.prisma.contactUnlockAttempt.findUniqueOrThrow({
      where: { id: attemptId },
    });
    if (newStatus === ContactUnlockStatus.UNLOCKED) {
      await this.markApplicationAcceptedAfterUnlock([updated.application_id]);
    }

    return {
      attemptId: updated.id,
      status: updated.status,
      newlyUnlocked:
        newStatus === ContactUnlockStatus.UNLOCKED ? [attemptId] : [],
    };
  }

  /**
   * Creates a ContactUnlockAttempt when an employer accepts a candidate.
   * Idempotent: returns existing attempt if one already exists.
   *
   * For multi-person jobs (quantity > 1): if the employer has already paid at the
   * job level, the new attempt is created with employer_paid = true immediately.
   */
  async initiateUnlock(
    applicationId: string,
    employerId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? this.prisma;
    const existing = await db.contactUnlockAttempt.findUnique({
      where: { application_id: applicationId },
    });
    if (existing) return existing;

    const app = await db.application.findUnique({
      where: { id: applicationId },
      select: { worker_id: true, job_offer_id: true },
    });
    if (!app) throw new NotFoundException('Candidature introuvable');

    const jobOffer = await db.jobOffer.findUnique({
      where: { id: app.job_offer_id },
      select: { quantity: true, employer_unlock_paid: true },
    });
    if (!jobOffer) throw new NotFoundException('Offre introuvable');

    const fees = await this.systemConfig.getContactUnlockFees();
    const expiresAt = new Date(Date.now() + fees.expiryHours * 60 * 60 * 1000);

    const isMultiPerson = (jobOffer.quantity ?? 1) > 1;
    const employerAlreadyPaid = isMultiPerson && jobOffer.employer_unlock_paid;

    const now = new Date();

    return db.contactUnlockAttempt.create({
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
   * When an unlock attempt expires without UNLOCKED, the application must not
   * stay WAITING_PAYMENT (slot + assignment are released like a failed unlock).
   */
  private async syncWaitingPaymentApplicationAfterUnlockExpiry(params: {
    applicationId: string;
    jobOfferId: string;
    quantity: number;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const app = await tx.application.findUnique({
        where: { id: params.applicationId },
        select: { status: true },
      });
      if (!app || app.status !== ApplicationStatus.WAITING_PAYMENT) return;

      const offer = await tx.jobOffer.findUnique({
        where: { id: params.jobOfferId },
        select: { status: true, scheduled_at: true },
      });
      if (!offer) return;

      const now = new Date();
      await tx.application.update({
        where: { id: params.applicationId },
        data: {
          status: ApplicationStatus.CANCELLED,
          cancelled_at: now,
          cancellation_reason:
            'Délai de paiement pour le déverrouillage expiré (aucune coordonnée échangée)',
        },
      });
      await tx.assignment.updateMany({
        where: { application_id: params.applicationId },
        data: {
          status: AssignmentStatus.CANCELLED_BY_EMPLOYER,
          cancelled_at: now,
        },
      });

      const remainingAccepted = await tx.application.count({
        where: {
          job_offer_id: params.jobOfferId,
          id: { not: params.applicationId },
          status: {
            in: [ApplicationStatus.ACCEPTED, ApplicationStatus.WAITING_PAYMENT],
          },
        },
      });
      const quantity = params.quantity;
      const offerStatus = this.jobOfferStatusFromRemainingAccepted(
        remainingAccepted,
        quantity,
      );
      if (
        this.shouldReopenOffer({
          scheduledAt: offer.scheduled_at,
          currentStatus: offer.status,
          now,
        })
      ) {
        await tx.jobOffer.update({
          where: { id: params.jobOfferId },
          data: { status: offerStatus },
        });
      }
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
    const attemptRow = await this.prisma.contactUnlockAttempt.findUnique({
      where: { id: attemptId },
    });
    const earlyExit = this.ensurePayUnlockAttemptOrEarlyExit(
      attemptRow,
      attemptId,
    );
    if (earlyExit) return earlyExit;

    const attempt = attemptRow!;
    const { isEmployer, isWorker } = this.assertPayUnlockParticipant(
      attempt,
      profileId,
    );
    await this.assertPayUnlockAccountAllowsPayment(profileId);
    this.assertPayUnlockPartyNotAlreadyPaid(attempt, isEmployer, isWorker);

    const amount = isEmployer
      ? Number(attempt.employer_amount)
      : Number(attempt.worker_amount);

    if (useCredit) {
      await this.walletService.debitProfileAndCreditSystem(
        profileId,
        amount,
        WalletTransactionType.CONTACT_UNLOCK_DEBIT,
        WalletTransactionType.CONTACT_UNLOCK_PAYMENT,
        'contact_unlock_attempt',
        attemptId,
      );
      await this.recordWalletUnlockPayment(attemptId, profileId, amount);
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

    return this.commitStandardPerAttemptPayUnlock({
      attemptId,
      attempt,
      isEmployer,
      isWorker,
      now,
    });
  }

  private async recordWalletUnlockPayment(
    attemptId: string,
    profileId: string,
    amount: number,
  ): Promise<void> {
    const paymentReference = generatePaymentReference();
    const token = randomUUID();

    const paymentRequest = await this.prisma.paymentRequest.create({
      data: {
        profile_id: profileId,
        token,
        status: PaymentRequestStatus.APPROVED,
        amount,
        description: 'Déverrouillage de contact (wallet interne)',
        payment_reference: paymentReference,
        contact_unlock_attempt_id: attemptId,
      },
    });

    await this.prisma.payment.create({
      data: {
        type: PaymentType.CONTACT_UNLOCK,
        profile_id: profileId,
        amount,
        payment_method: PaymentMethod.WALLET,
        transaction_id: paymentReference,
        status: PaymentStatus.COMPLETED,
        paid_at: new Date(),
        description: 'Déverrouillage de contact (wallet interne)',
      },
    });

    await this.invoiceService.create({
      profileId,
      paymentRequestId: paymentRequest.id,
      amount,
      reason: InvoiceReason.CONTACT_UNLOCK,
      relatedEntityType: 'contact_unlock_attempt',
      relatedEntityId: attemptId,
    });
  }

  private async markApplicationAcceptedAfterUnlock(
    applicationIds: string[],
  ): Promise<void> {
    if (applicationIds.length === 0) return;
    const apps = await this.prisma.application.findMany({
      where: { id: { in: applicationIds } },
      select: { worker_id: true },
    });
    await this.prisma.application.updateMany({
      where: {
        id: { in: applicationIds },
        status: 'WAITING_PAYMENT' as ApplicationStatus,
      },
      data: { status: ApplicationStatus.ACCEPTED },
    });
    for (const app of apps) {
      this.matchingService
        .indexWorkerProfile(app.worker_id)
        .catch((err) => console.warn(`Failed to re-index worker after unlock:`, err));
    }
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
    const unlockedApplicationIds: string[] = [];

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
      if (willUnlock) unlockedApplicationIds.push(a.application_id);
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
    if (triggerAttempt.worker_paid) {
      const trigger = await this.prisma.contactUnlockAttempt.findUnique({
        where: { id: triggerAttempt.id },
        select: { application_id: true },
      });
      if (trigger?.application_id)
        unlockedApplicationIds.push(trigger.application_id);
    }

    await this.markApplicationAcceptedAfterUnlock([
      ...new Set(unlockedApplicationIds),
    ]);

    return {
      attemptId: triggerAttempt.id,
      status: triggerStatus,
      newlyUnlocked,
    };
  }

  async rejectPendingAttemptByApplication(
    applicationId: string,
    profileId: string,
  ): Promise<{
    currentPartyMessage: string;
    otherPartyMessage: string;
    otherPhone: string;
  }> {
    const attempt = await this.prisma.contactUnlockAttempt.findUnique({
      where: { application_id: applicationId },
      include: {
        worker: {
          select: { id: true, phone: true, first_name: true, last_name: true },
        },
        employer: {
          select: { id: true, phone: true, first_name: true, last_name: true },
        },
        job_offer: {
          select: {
            id: true,
            title: true,
            quantity: true,
            status: true,
            scheduled_at: true,
          },
        },
      },
    });
    if (!attempt) {
      throw new NotFoundException('Tentative de déverrouillage introuvable');
    }
    const isEmployer = attempt.employer_id === profileId;
    const isWorker = attempt.worker_id === profileId;
    if (!isEmployer && !isWorker) {
      throw new ForbiddenException('Action non autorisée pour cette tentative');
    }
    if (
      attempt.status !== ContactUnlockStatus.PENDING_BOTH &&
      attempt.status !== ContactUnlockStatus.PENDING_EMPLOYER &&
      attempt.status !== ContactUnlockStatus.PENDING_WORKER
    ) {
      throw new BadRequestException(
        'Cette tentative ne peut plus être rejetée',
      );
    }

    const now = new Date();
    const rejectedByLabel = isEmployer ? 'employeur' : 'travailleur';
    const assignmentStatus = isEmployer
      ? AssignmentStatus.CANCELLED_BY_EMPLOYER
      : AssignmentStatus.CANCELLED_BY_WORKER;

    await this.prisma.$transaction(async (tx) => {
      if (attempt.employer_paid) {
        await this.walletService.creditProfileWallet(
          attempt.employer_id,
          Number(attempt.employer_amount),
          WalletTransactionType.CONTACT_UNLOCK_CREDIT_CONVERSION,
          'contact_unlock_attempt',
          attempt.id,
        );
      }
      if (attempt.worker_paid) {
        await this.walletService.creditProfileWallet(
          attempt.worker_id,
          Number(attempt.worker_amount),
          WalletTransactionType.CONTACT_UNLOCK_CREDIT_CONVERSION,
          'contact_unlock_attempt',
          attempt.id,
        );
      }

      await tx.contactUnlockAttempt.update({
        where: { id: attempt.id },
        data: {
          status: ContactUnlockStatus.CONVERTED_TO_CREDIT,
          converted_at: now,
        },
      });
      await tx.application.update({
        where: { id: applicationId },
        data: {
          status: ApplicationStatus.REJECTED,
          cancelled_at: now,
          cancellation_reason: `Déverrouillage rejeté par ${rejectedByLabel}`,
        },
      });
      await tx.assignment.updateMany({
        where: { application_id: applicationId },
        data: { status: assignmentStatus, cancelled_at: now },
      });

      const remainingAccepted = await tx.application.count({
        where: {
          job_offer_id: attempt.job_offer_id,
          id: { not: applicationId },
          status: {
            in: [
              ApplicationStatus.ACCEPTED,
              'WAITING_PAYMENT' as ApplicationStatus,
            ],
          },
        },
      });
      const quantity = attempt.job_offer.quantity ?? 1;
      const offerStatus = this.jobOfferStatusFromRemainingAccepted(
        remainingAccepted,
        quantity,
      );
      if (
        this.shouldReopenOffer({
          scheduledAt: attempt.job_offer.scheduled_at,
          currentStatus: attempt.job_offer.status,
          now,
        })
      ) {
        await tx.jobOffer.update({
          where: { id: attempt.job_offer_id },
          data: { status: offerStatus },
        });
      }
    });

    const currentName = isEmployer
      ? `${attempt.employer.first_name} ${attempt.employer.last_name}`.trim()
      : `${attempt.worker.first_name} ${attempt.worker.last_name}`.trim();
    const otherPhone = isEmployer
      ? attempt.worker.phone
      : attempt.employer.phone;

    const refundLines: string[] = [];
    if (attempt.employer_paid || attempt.worker_paid) {
      refundLines.push(
        'Le remboursement du paiement déjà effectué a été reversé immédiatement vers le wallet interne.',
      );
    }

    return {
      currentPartyMessage: [
        '*Demande rejetée.*',
        '',
        `La mise en relation pour "${attempt.job_offer.title}" a été annulée.`,
        ...refundLines,
        '',
        "Tapez 'Menu' pour revenir.",
      ].join('\n'),
      otherPartyMessage: [
        '*Demande de paiement annulée*',
        '',
        `${currentName} a rejeté la mise en relation pour "${attempt.job_offer.title}".`,
        ...refundLines,
        '',
        "Tapez 'Menu' pour revenir.",
      ].join('\n'),
      otherPhone,
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

        if (
          attempt.worker_paid &&
          (employerPaidAtJobLevel || !attempt.employer_paid)
        ) {
          // Multi-person: employer paid at job level — refund worker only.
          // Standard: worker paid, employer did not — refund worker.
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
        } else if (
          !employerPaidAtJobLevel &&
          attempt.employer_paid &&
          !attempt.worker_paid
        ) {
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
        }

        await this.prisma.contactUnlockAttempt.update({
          where: { id: attempt.id },
          data: { status: newStatus, converted_at: now },
        });

        await this.syncWaitingPaymentApplicationAfterUnlockExpiry({
          applicationId: attempt.application_id,
          jobOfferId: attempt.job_offer_id,
          quantity: attempt.job_offer.quantity ?? 1,
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
