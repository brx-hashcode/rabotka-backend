/* Seeds the Jean / Emil / Jeanne parrainage scenario and LEAVES IT IN PLACE so
 * it can be browsed in the admin UI.
 *
 * Run again to reset: it removes its own previous run first (matched on the
 * @scenario.rabotka.test email domain) so repeated runs never pile up.
 * Everything it creates is confined to that domain — nothing else is touched.
 *
 *   node prisma/seed-referral-scenario.js            seed (default)
 *   node prisma/seed-referral-scenario.js --clean    remove and exit
 */
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env.local') });
const {
  PrismaService,
} = require('../dist/src/common/services/prisma/prisma.service');
const {
  ReferralService,
} = require('../dist/src/modules/referral/referral.service');

const MARKER = '@scenario.rabotka.test';
const L = (m) => console.log(`   ${m}`);
const S = (m) => console.log(`\n-- ${m}`);

async function wipe(prisma) {
  const victims = await prisma.profile.findMany({
    where: { email: { endsWith: MARKER } },
    select: { id: true },
  });
  if (victims.length === 0) return 0;
  const ids = victims.map((v) => v.id);

  await prisma.contactUnlockAttempt.deleteMany({
    where: { OR: [{ worker_id: { in: ids } }, { employer_id: { in: ids } }] },
  });
  await prisma.application.deleteMany({ where: { worker_id: { in: ids } } });
  await prisma.jobOffer.deleteMany({ where: { employer_id: { in: ids } } });
  await prisma.paymentRequest.deleteMany({ where: { profile_id: { in: ids } } });
  await prisma.referral.deleteMany({
    where: { OR: [{ referrer_id: { in: ids } }, { referee_id: { in: ids } }] },
  });
  const ws = await prisma.wallet.findMany({
    where: { profile_id: { in: ids } },
    select: { id: true },
  });
  await prisma.walletTransaction.deleteMany({
    where: { wallet_id: { in: ws.map((w) => w.id) } },
  });
  await prisma.wallet.deleteMany({ where: { profile_id: { in: ids } } });
  await prisma.profile.deleteMany({ where: { id: { in: ids } } });
  return ids.length;
}

(async () => {
  const prisma = new PrismaService(null);
  await prisma.$connect();

  try {
    S('resetting any previous run');
    L(`removed ${await wipe(prisma)} profile(s)`);
    if (process.argv.includes('--clean')) {
      console.log('\nclean only — nothing seeded.');
      return;
    }

    const rows = await prisma.systemConfig.findMany({
      where: { key: { startsWith: 'fees.' } },
      select: { key: true, value: true },
    });
    const cfg = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
    const WORKER_FEE = cfg['fees.contact_unlock_fee_worker'];
    const EMPLOYER_FEE = cfg['fees.contact_unlock_fee_employer'];
    const REFERRER = cfg['fees.referral_credit_referrer'];
    const REFEREE = cfg['fees.referral_credit_referee'];

    S('live config');
    L(`unlock: worker ${WORKER_FEE} / employer ${EMPLOYER_FEE} FCFA`);
    L(`parrainage: ${REFERRER} + ${REFEREE} = floor ${REFERRER + REFEREE} FCFA`);

    const systemConfig = {
      getReferralCredits: async () => ({
        referrerCreditFcfa: REFERRER,
        refereeCreditFcfa: REFEREE,
        maxRewardedPerReferrer:
          cfg['fees.referral_max_rewarded_per_referrer'] ?? 10,
      }),
    };
    const wallet = {
      getOrCreateProfileWallet: async (profileId) => {
        const w = await prisma.wallet.upsert({
          where: {
            idx_wallet_owner_profile: {
              owner_type: 'PROFILE',
              profile_id: profileId,
            },
          },
          update: {},
          create: { owner_type: 'PROFILE', profile_id: profileId, balance: 0 },
        });
        return { id: w.id, balance: Number(w.balance) };
      },
    };
    const referral = new ReferralService(
      prisma,
      wallet,
      systemConfig,
      { invalidate: async () => {} },
      { sendMail: async () => {} },
      { wrap: async (h) => h },
      { get: () => 'https://rabotka.work' },
    );

    const mk = (first, last, type, phone) =>
      prisma.profile.create({
        data: {
          first_name: first,
          last_name: last,
          email: `${first.toLowerCase()}${MARKER}`,
          phone,
          address: 'Avenue de la Paix, Brazzaville',
          city: 'Brazzaville',
          country_code: 'CG',
          country_name: 'Congo-Brazzaville',
          description:
            'Profil de démonstration pour le scénario de parrainage. ' +
            'Créé par seed-referral-scenario.js.',
          profile_type: type,
          status: 'ACTIVE',
          verification_status: 'VERIFIED',
          read_and_approved_policies: true,
          activated_at: new Date(),
        },
        select: { id: true, first_name: true, last_name: true },
      });

    S('cast');
    const jean = await mk('Jean', 'Mabiala', 'WORKER', '+242069900001');
    const emil = await mk('Emil', 'Loubaki', 'WORKER', '+242069900002');
    const jeanne = await mk('Jeanne', 'Okemba', 'EMPLOYER', '+242069900003');
    L(`Jean Mabiala   (worker, parrain)  ${jean.id}`);
    L(`Emil Loubaki   (worker, filleul)  ${emil.id}`);
    L(`Jeanne Okemba  (employer)         ${jeanne.id}`);

    S('Jean gets a code, Emil signs up with it');
    const code = await referral.ensureReferralCode(jean.id);
    const refId = await referral.recordReferral({
      refereeId: emil.id,
      code,
      source: 'LINK',
    });
    L(`code ${code} -> referral ${refId} (PENDING)`);

    S('Jeanne posts a job, Emil applies, Jeanne accepts');
    const job = await prisma.jobOffer.create({
      data: {
        employer_id: jeanne.id,
        reference: `PARRAIN-${Date.now().toString().slice(-6)}`,
        title: 'Peinture appartement 2 pièces',
        description:
          'Deux pièces à repeindre, peinture fournie. Travail sur deux jours.',
        employment_type: 'MISSION',
        scheduled_at: new Date(Date.now() + 7 * 864e5),
        amount: 25000,
        address: 'Avenue de la Paix, Brazzaville',
        city: 'Brazzaville',
        country_code: 'CG',
        country_name: 'Congo-Brazzaville',
        status: 'ACTIVE',
      },
      select: { id: true, reference: true },
    });
    const application = await prisma.application.create({
      data: {
        job_offer_id: job.id,
        worker_id: emil.id,
        status: 'WAITING_PAYMENT',
      },
      select: { id: true },
    });
    const attempt = await prisma.contactUnlockAttempt.create({
      data: {
        application_id: application.id,
        job_offer_id: job.id,
        worker_id: emil.id,
        employer_id: jeanne.id,
        status: 'PENDING_BOTH',
        employer_amount: EMPLOYER_FEE,
        worker_amount: WORKER_FEE,
        expires_at: new Date(Date.now() + 48 * 36e5),
      },
      select: { id: true },
    });
    L(`job ${job.reference} -> unlock attempt PENDING_BOTH`);

    S('both sides pay by mobile money');
    await prisma.paymentRequest.create({
      data: {
        profile_id: jeanne.id,
        token: `parrain-emp-${Date.now()}`,
        status: 'APPROVED',
        request_type: 'CONTACT_UNLOCK',
        contact_unlock_attempt_id: attempt.id,
        amount: EMPLOYER_FEE,
        description: `Déverrouillage contact — ${job.reference}`,
        gateway: 'PAWAPAY',
        operator: 'MTN_MOMO_COG',
      },
    });
    await prisma.paymentRequest.create({
      data: {
        profile_id: emil.id,
        token: `parrain-wrk-${Date.now()}`,
        status: 'APPROVED',
        request_type: 'CONTACT_UNLOCK',
        contact_unlock_attempt_id: attempt.id,
        amount: WORKER_FEE,
        description: `Déverrouillage contact — ${job.reference}`,
        gateway: 'PAWAPAY',
        operator: 'MTN_MOMO_COG',
      },
    });
    await prisma.contactUnlockAttempt.update({
      where: { id: attempt.id },
      data: {
        employer_paid: true,
        employer_paid_at: new Date(),
        worker_paid: true,
        worker_paid_at: new Date(),
        status: 'UNLOCKED',
        unlocked_at: new Date(),
      },
    });
    L(`Jeanne ${EMPLOYER_FEE} FCFA · Emil ${WORKER_FEE} FCFA — contact UNLOCKED`);

    S('parrainage settles');
    await referral.settleForReferee(emil.id);
    const r = await prisma.referral.findUnique({
      where: { id: refId },
      select: { status: true, referrer_amount: true, referee_amount: true, settlement_note: true },
    });
    const bal = async (id) => {
      const w = await prisma.wallet.findFirst({
        where: { owner_type: 'PROFILE', profile_id: id },
        select: { balance: true },
      });
      return Number(w?.balance ?? 0);
    };
    L(`status ${r.status}${r.settlement_note ? ` — ${r.settlement_note}` : ''}`);
    L(`Jean's wallet: ${await bal(jean.id)} FCFA`);
    L(`Emil's wallet: ${await bal(emil.id)} FCFA`);

    S('a second, still-pending parrainage so the list is not all one status');
    const paul = await mk('Paul', 'Ngoma', 'WORKER', '+242069900004');
    await referral.recordReferral({ refereeId: paul.id, code, source: 'MANUAL_CODE' });
    L('Paul Ngoma signed up with Jean\'s code but has not paid yet (PENDING)');

    console.log('\n=========== WHERE TO LOOK ===========');
    L('Admin > Parrainage        - both referrals, statuses, payouts');
    L(`Admin > Profiles > Jean Mabiala > Parrainage tab`);
    L('    -> "Referrals made": Emil (REWARDED) + Paul (PENDING)');
    L(`Admin > Profiles > Emil Loubaki`);
    L('    -> General tab: "Referred by" row shows Jean');
    L('    -> Parrainage tab: "Referred by" card');
    L('    -> Payments tab: the REFERRAL_CREDIT ledger row');
    L(`Jean's code for the client app: ${code}  (/?ref=${code})`);
    console.log('=====================================');
    console.log('\nremove with: node prisma/seed-referral-scenario.js --clean');
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error('\nFAILED:', e.stack || e.message);
  process.exit(1);
});
