import { PrismaService } from '../../common/services/prisma/prisma.service';

/**
 * Used only where the configured window genuinely cannot be reached — never as
 * a convenience default. The real value is `fees.penalty_hard_block_days`;
 * every caller here takes it as an argument so the number in the check and the
 * number in the message the user reads can never drift apart.
 */
export const DEFAULT_HARD_BLOCK_DAYS = 3;

export async function isWorkerHardBlocked(
  prisma: PrismaService,
  workerId: string,
  hardBlockDays: number,
): Promise<boolean> {
  const threshold = hardBlockCutoff(hardBlockDays);

  const count = await prisma.penalty.count({
    where: {
      profile_id: workerId,
      paid_at: null,
      applied_at: { lte: threshold },
    },
  });

  return count > 0;
}

/** The instant a penalty must predate to count as hard-blocking. */
export function hardBlockCutoff(hardBlockDays: number): Date {
  const threshold = new Date();
  threshold.setDate(threshold.getDate() - hardBlockDays);
  return threshold;
}

/**
 * The one place the hard-block wording is built. The day count used to be typed
 * into three separate messages as a literal "3 jours", so making the window
 * configurable anywhere else would have left the user reading the old number.
 *
 * Deliberately says nothing about HOW to pay. Every throw site sits in a service
 * reached from the REST API as much as from WhatsApp, and the old wording told
 * everyone to "Tapez PAYER" — an instruction with nothing to type it into on
 * mobile or web. `blockedAction` is what actually differs between the sites.
 */
export function hardBlockMessage(
  hardBlockDays: number,
  blockedAction: string,
): string {
  return `🚨 Votre compte est bloqué : vous avez des pénalités impayées depuis plus de ${hardBlockDays} jour(s). Réglez-les pour ${blockedAction}.`;
}
