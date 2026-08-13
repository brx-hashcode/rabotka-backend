import {
  ApplicationStatus,
  AssignmentStatus,
  JobOfferStatus,
  Prisma,
  RejectionSource,
} from '@prisma/client';

/**
 * Closes an offer whose recruiting is over and settles everyone standing on it.
 *
 * This is the CDD/CDI/STAGE counterpart to `closeOfferIfAllWorkersDone`. The
 * difference is what "done" means: on those types Rabotka's part is the hiring,
 * so the offer closes once the positions are taken and the employer says the
 * hire stuck. Nobody ever confirms that the *work* finished, because it goes on
 * off-platform and we would never learn when it ended — waiting for that is
 * exactly how these offers used to strand in FILLED with neither side able to
 * rate the other.
 *
 * A free function taking the transaction client rather than a service method:
 * it runs both from the employer's confirmation (API process) and from the
 * grace-period sweep, which lives in a worker process that deliberately does
 * not wire up ApplicationService. Two copies of this transition drifting apart
 * is the failure the `isDatedMission` comment warns about, so there is one.
 *
 * Deliberately does NOT award the completion reliability bonus. That reward
 * means *work delivered*; paying it out for being hired would make the score
 * inflatable by posting a role and filling it.
 *
 * Takes the job-offer row lock, so two confirmations racing cannot both settle
 * the same offer, and is idempotent once the offer is COMPLETED.
 *
 * @returns ids of applicants rejected as a result, for post-commit notification
 */
export async function closeRecruitedOfferTx(
  tx: Prisma.TransactionClient,
  jobOfferId: string,
): Promise<string[]> {
  await tx.$executeRaw`SELECT id FROM "job_offers" WHERE id = ${jobOfferId}::uuid FOR UPDATE`;

  const offer = await tx.jobOffer.findUnique({
    where: { id: jobOfferId },
    select: { status: true },
  });
  if (!offer || offer.status === JobOfferStatus.COMPLETED) return [];

  const hired = await tx.application.findMany({
    where: {
      job_offer_id: jobOfferId,
      status: { in: [ApplicationStatus.ACCEPTED, ApplicationStatus.STARTED] },
    },
    select: { id: true },
  });
  const hiredIds = hired.map((a) => a.id);

  if (hiredIds.length > 0) {
    await tx.application.updateMany({
      where: { id: { in: hiredIds } },
      data: { status: ApplicationStatus.END },
    });
    // Only CONFIRMED assignments move. A NO_SHOW is a record of what happened
    // and must not be overwritten into a completion.
    await tx.assignment.updateMany({
      where: {
        application_id: { in: hiredIds },
        status: AssignmentStatus.CONFIRMED,
      },
      data: { status: AssignmentStatus.COMPLETED, completed_at: new Date() },
    });
  }

  await tx.jobOffer.update({
    where: { id: jobOfferId },
    data: { status: JobOfferStatus.COMPLETED },
  });

  const leftovers = await tx.application.findMany({
    where: {
      job_offer_id: jobOfferId,
      status: {
        in: [
          ApplicationStatus.PENDING,
          ApplicationStatus.VIEWED,
          ApplicationStatus.WAITING_PAYMENT,
        ],
      },
    },
    select: { id: true },
  });
  if (leftovers.length === 0) return [];

  const leftoverIds = leftovers.map((a) => a.id);
  await tx.application.updateMany({
    where: { id: { in: leftoverIds } },
    data: {
      status: ApplicationStatus.REJECTED,
      rejected_at: new Date(),
      // Closed out because the offer is no longer open, not because the
      // employer rejected anyone. Must never count as a negative signal.
      rejection_source: RejectionSource.AUTO_FILL,
    },
  });
  return leftoverIds;
}
