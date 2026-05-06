import { PrismaService } from '../../common/services/prisma/prisma.service';

export const HARD_BLOCK_DAYS = 3;

export async function isWorkerHardBlocked(
  prisma: PrismaService,
  workerId: string,
): Promise<boolean> {
  const threshold = new Date();
  threshold.setDate(threshold.getDate() - HARD_BLOCK_DAYS);

  const count = await prisma.penalty.count({
    where: {
      profile_id: workerId,
      paid_at: null,
      applied_at: { lte: threshold },
    },
  });

  return count > 0;
}
