import type { PrismaClient } from '@prisma/client';
import { ClaimStatus } from '@prisma/client';

const SEED_MARKER_TITLE = '[SEED] Payment not received after job completion';

export async function seedClaims(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.claim.findFirst({
    where: { title: SEED_MARKER_TITLE },
  });

  if (existing) {
    console.log('[Claims seed] Skipped (seed claims already exist).');
    return;
  }

  // Grab any 2 profiles and 1 admin user to reference
  const profiles = await prisma.profile.findMany({ take: 3, orderBy: { created_at: 'asc' } });
  const adminUser = await prisma.user.findFirst({ orderBy: { created_at: 'asc' } });

  if (profiles.length === 0) {
    console.log('[Claims seed] Skipped (no profiles found — run profile seed first).');
    return;
  }

  const p0 = profiles[0];
  const p1 = profiles[1] ?? profiles[0];
  const p2 = profiles[2] ?? profiles[0];

  const claimsData: {
    title: string;
    description: string;
    status: ClaimStatus;
    profile_id: string;
    assigned_user_id?: string;
    created_by_user_id?: string;
  }[] = [
    {
      title: SEED_MARKER_TITLE,
      description:
        'The worker completed the assignment on March 10th but has not received payment from the employer. The employer is unresponsive. Please investigate and resolve.',
      status: ClaimStatus.CREATED,
      profile_id: p0.id,
      created_by_user_id: adminUser?.id,
    },
    {
      title: '[SEED] Profile verification documents rejected incorrectly',
      description:
        'The employer submitted all required KYC documents (identity card + selfie) but the system rejected them with no clear reason. The documents are valid and high-quality.',
      status: ClaimStatus.IN_PROGRESS,
      profile_id: p1.id,
      assigned_user_id: adminUser?.id,
      created_by_user_id: adminUser?.id,
    },
    {
      title: '[SEED] Penalty applied in error — worker was not notified',
      description:
        'A penalty of 5,000 FCFA was applied to the worker account for a no-show, but the worker claims they never received the job confirmation notification. This needs to be reviewed.',
      status: ClaimStatus.IN_PROGRESS,
      profile_id: p0.id,
      assigned_user_id: adminUser?.id,
      created_by_user_id: adminUser?.id,
    },
    {
      title: '[SEED] Duplicate registration payment charged',
      description:
        'The profile was charged twice for registration (2 × 2,500 FCFA) due to a network timeout during the payment flow. Requesting a refund for the duplicate charge.',
      status: ClaimStatus.COMPLETED,
      profile_id: p2.id,
      created_by_user_id: adminUser?.id,
    },
    {
      title: '[SEED] Job offer cancelled without notice — employer refused to pay',
      description:
        'The employer cancelled the job offer 2 hours before the scheduled start time without notifying workers. Two assigned workers lost income. Requesting compensation.',
      status: ClaimStatus.REJECTED,
      profile_id: p1.id,
      created_by_user_id: adminUser?.id,
    },
  ];

  for (const data of claimsData) {
    await prisma.claim.create({ data });
  }

  console.log(`[Claims seed] Created ${claimsData.length} claims.`);
}
