/**
 * Manual test: render the WhatsApp bot's "Offres recommandées" list with the
 * REAL renderer the bot uses (buildPagedListReply from recommended-jobs.flow)
 * and send it to a test number via the Twilio API — no database, no Redis, no
 * Nest boot, same direct-fetch style as the root test-send-whatsapp.js.
 *
 * Job recommendations must NEVER go out as a carousel / card Content template
 * (templates remain only for the employer-side recommended profiles), so the
 * script fails loudly if the renderer returns a `[TPL:...]` template send.
 *
 * ONE page per run, on purpose: the bot is paginated — the worker only gets
 * the next page after replying "S" — so sending several pages in a row would
 * not be what production does. Use --page to preview a later page on its own.
 *
 * Usage:
 *   pnpm wa:test-reco-jobs                    # page 1 → +242069917686
 *   pnpm wa:test-reco-jobs --page 2           # the page an "S" reply returns
 *   pnpm wa:test-reco-jobs --dry-run          # render + assert, send nothing
 *   TEST_WHATSAPP_TO=+2426... pnpm wa:test-reco-jobs
 *
 * Plain text is session-only: the recipient must have messaged the bot within
 * the last 24h, otherwise Twilio rejects with 63016.
 */

import { config } from 'dotenv';
import { buildPagedListReply } from '../src/modules/bot/flows/recommended-jobs.flow';
import type { OfferListItem } from '../src/modules/bot/messages/offers.messages';

config({ path: '.env.local' });
config({ path: '.env' });

const TEST_NUMBER = process.env.TEST_WHATSAPP_TO ?? '+242069917686';
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
// Production WhatsApp sender for this account ("Rabotka" business profile),
// same as the root test-send-whatsapp.js — not the Twilio sandbox number.
const WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM ?? '+16182786934';

const DRY_RUN = process.argv.includes('--dry-run');
const pageArgIdx = process.argv.indexOf('--page');
const PAGE =
  pageArgIdx !== -1 && process.argv[pageArgIdx + 1]
    ? Math.max(1, Number.parseInt(process.argv[pageArgIdx + 1], 10)) - 1
    : 0;

function inDays(days: number, hour: number): Date {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setHours(hour, 0, 0, 0);
  return d;
}

// 6 offers → 2 pages at PAGE_SIZE = 5, so pagination is exercised too.
const OFFERS: OfferListItem[] = [
  {
    id: 'offer-1',
    title: 'Réparation fuite d’eau salle de bain',
    description:
      "Réparation urgente d'une fuite sous l'évier, plus vérification de la robinetterie de la cuisine.",
    scheduled_at: inDays(3, 8),
    amount: 8000,
    payment_flow: 'HOURLY',
    address: 'Bacongo, Brazzaville',
    note: null,
    quantity: 2,
    acceptedCount: 0,
    status: 'ACTIVE',
    employerScore: 92,
  },
  {
    id: 'offer-2',
    title: 'Installation chauffe-eau',
    description:
      "Installation d'un chauffe-eau électrique dans une villa, raccordement et test de fonctionnement.",
    scheduled_at: inDays(4, 9),
    amount: 15000,
    payment_flow: 'DAILY',
    address: 'Poto-Poto, Brazzaville',
    note: null,
    quantity: 1,
    acceptedCount: 0,
    status: 'ACTIVE',
    employerScore: 80,
  },
  {
    id: 'offer-3',
    title: 'Mise aux normes tableau électrique',
    description:
      "Remise aux normes d'un tableau électrique vétuste, remplacement de disjoncteurs.",
    scheduled_at: inDays(5, 8),
    amount: 20000,
    payment_flow: 'DAILY',
    address: 'Moungali, Brazzaville',
    note: null,
    quantity: 3,
    acceptedCount: 1,
    status: 'ACTIVE',
    employerScore: null,
  },
  {
    id: 'offer-4',
    title: 'Dépannage électrique urgent',
    description:
      'Coupure de courant générale dans un pavillon, diagnostic et réparation du circuit.',
    scheduled_at: inDays(2, 14),
    amount: 10000,
    payment_flow: 'HOURLY',
    address: 'Talangaï, Brazzaville',
    note: null,
    quantity: 1,
    acceptedCount: 1,
    status: 'PARTIALLY_FILLED',
    employerScore: 75,
  },
  {
    id: 'offer-5',
    title: 'Débouchage canalisation cuisine',
    description:
      'Canalisation bouchée dans un restaurant, débouchage et nettoyage du siphon.',
    scheduled_at: inDays(6, 7),
    amount: 12000,
    payment_flow: 'HOURLY',
    address: 'Ouenzé, Brazzaville',
    note: null,
    quantity: 2,
    acceptedCount: 0,
    status: 'ACTIVE',
    employerScore: 60,
  },
  {
    id: 'offer-6',
    title: 'Installation éclairage extérieur',
    description:
      "Pose de projecteurs LED et d'un détecteur de mouvement sur la façade d'une maison.",
    scheduled_at: inDays(7, 10),
    amount: 18000,
    payment_flow: 'DAILY',
    address: 'Makélékélé, Brazzaville',
    note: null,
    quantity: 1,
    acceptedCount: 0,
    status: 'ACTIVE',
    employerScore: 88,
  },
];

async function sendText(body: string): Promise<void> {
  if (!ACCOUNT_SID || !AUTH_TOKEN) {
    throw new Error(
      'Twilio credentials missing (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN in .env.local).',
    );
  }
  const from = WHATSAPP_FROM.startsWith('whatsapp:')
    ? WHATSAPP_FROM
    : `whatsapp:${WHATSAPP_FROM}`;
  const to = TEST_NUMBER.startsWith('whatsapp:')
    ? TEST_NUMBER
    : `whatsapp:${TEST_NUMBER}`;

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: from, To: to, Body: body }),
    },
  );
  const json = (await res.json()) as {
    sid?: string;
    status?: string;
    code?: number;
    message?: string;
  };
  if (!res.ok) {
    console.error(`✗  Failed: [${json.code ?? res.status}] ${json.message}`);
    if (json.code === 63016) {
      console.error(
        '   No open 24h session — message the bot from this number, then re-run.',
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log(`✔  Sent. SID: ${json.sid} | status: ${json.status}`);
}

async function main(): Promise<void> {
  const totalPages = Math.ceil(OFFERS.length / 5);
  const { reply: rendered, page } = buildPagedListReply(OFFERS, PAGE);
  console.log(
    `--- page ${page + 1}/${totalPages}: ${rendered.length} message(s) ---`,
  );
  rendered.forEach((r) => console.log(`\n${r}\n`));

  const templated = rendered.filter((r) => r.startsWith('[TPL:'));
  if (templated.length > 0) {
    console.error(
      `\n✗ ${templated.length} message(s) rendered as a Content template — job recommendations must be plain text.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log('✔ Plain text only (no [TPL:] template send).');

  if (DRY_RUN) {
    console.log('--dry-run: nothing sent.');
    return;
  }

  console.log(`\nFrom: ${WHATSAPP_FROM}  To: ${TEST_NUMBER}\n`);
  for (const [i, body] of rendered.entries()) {
    console.log(`▶  Sending message ${i + 1}/${rendered.length}…`);
    await sendText(body);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
