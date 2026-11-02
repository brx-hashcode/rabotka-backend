import {
  ApplicationStatus,
  ExternalApplicationStatus,
  Prisma,
} from '@prisma/client';

/**
 * Posts of an offer taken right now, by Rabotka candidates and outside ones.
 * Call it with the offer's row locked, or two hires can take the last post.
 */
export async function takenSeats(
  tx: Prisma.TransactionClient,
  jobOfferId: string,
): Promise<number> {
  const [rabotka, outside] = await Promise.all([
    tx.application.count({
      where: {
        job_offer_id: jobOfferId,
        status: {
          in: [
            ApplicationStatus.ACCEPTED,
            ApplicationStatus.WAITING_PAYMENT,
            ApplicationStatus.STARTED,
          ],
        },
      },
    }),
    tx.externalApplication.count({
      where: {
        job_offer_id: jobOfferId,
        status: ExternalApplicationStatus.RETAINED,
      },
    }),
  ]);
  return rabotka + outside;
}
