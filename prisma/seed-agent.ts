/**
 * One field agent for testing the agent app (rabotka-agent), signed in with
 * email + OTP like a real one.
 *
 *   node_modules/.bin/tsx prisma/seed-agent.ts --email you@example.com
 *   node_modules/.bin/tsx prisma/seed-agent.ts --email you@example.com \
 *     --zones CG:Brazzaville,CG:Pointe-Noire --first Awa --last Test --phone +242061234567
 *
 * Only --email is required: the OTP is emailed there (and, outside
 * production, printed in the API logs as "[AGENT OTP]"). Zones default to
 * Brazzaville and Pointe-Noire — the cities seed-agent-feed.ts fills.
 *
 * Re-running with the same email updates that agent instead of creating a
 * second one: status goes back to ACTIVE, and the names and zones change only
 * when passed. The phone and the identity document are only set on creation.
 *
 * Dev databases only (see seed/dev-database.ts).
 */
import { createHash } from 'node:crypto';
import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  AgentStatus,
  DocumentType,
  PrismaClient,
  UserRole,
} from '@prisma/client';
import { argValue, devDatabaseUrl } from './seed/dev-database';

config({ path: '.env.local' });
config({ path: '.env' });

const DEFAULT_ZONES = 'CG:Brazzaville,CG:Pointe-Noire';

function parseZones(raw: string): { country_code: string; city: string }[] {
  return raw.split(',').map((part) => {
    const [country, ...rest] = part.split(':');
    const city = rest.join(':').trim();
    if (!/^[A-Za-z]{2}$/.test(country?.trim() ?? '') || !city) {
      throw new Error(
        `Bad zone "${part}": expected COUNTRY:City, e.g. CG:Brazzaville.`,
      );
    }
    return { country_code: country.trim().toUpperCase(), city };
  });
}

async function main() {
  const url = devDatabaseUrl();

  const email = argValue('email')?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Pass the login email: --email you@example.com');
  }
  // Only what was passed is changed on a re-run; new agents get the defaults.
  const zonesArg = argValue('zones');
  const firstName = argValue('first');
  const lastName = argValue('last');

  // Stable per email, so re-runs and several test agents never collide on the
  // unique phone and identity-document columns.
  const digest = createHash('sha256').update(email).digest('hex');
  const phone =
    argValue('phone') ??
    `+24206${String(parseInt(digest.slice(0, 10), 16) % 10_000_000).padStart(7, '0')}`;
  if (!/^\+\d{8,15}$/.test(phone)) {
    throw new Error(
      `--phone must be E.164, e.g. +242061234567 (got "${phone}").`,
    );
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });

  try {
    // Agents record the admin who created them.
    const admin =
      (await prisma.user.findFirst({
        where: { role: UserRole.SUPER_ADMIN },
        select: { id: true },
        orderBy: { created_at: 'asc' },
      })) ??
      (await prisma.user.findFirst({
        select: { id: true },
        orderBy: { created_at: 'asc' },
      }));
    if (!admin) {
      throw new Error(
        'No admin user to record as the creator (run the main seed first).',
      );
    }

    const agent = await prisma.$transaction(async (tx) => {
      const existing = await tx.agent.findUnique({
        where: { email },
        select: { id: true },
      });
      const saved = existing
        ? await tx.agent.update({
            where: { id: existing.id },
            data: {
              first_name: firstName,
              last_name: lastName,
              status: AgentStatus.ACTIVE,
              status_reason: null,
            },
          })
        : await tx.agent.create({
            data: {
              first_name: firstName ?? 'Agent',
              last_name: lastName ?? 'Test',
              email,
              phone,
              id_document_type: DocumentType.IDENTITY_CARD,
              id_document_number: `SEED${digest.slice(0, 10).toUpperCase()}`,
              created_by_user_id: admin.id,
            },
          });

      if (!existing || zonesArg !== undefined) {
        const zones = parseZones(zonesArg ?? DEFAULT_ZONES);
        await tx.agentZone.deleteMany({ where: { agent_id: saved.id } });
        await tx.agentZone.createMany({
          data: zones.map((z) => ({ agent_id: saved.id, ...z })),
        });
      }
      const zones = await tx.agentZone.findMany({
        where: { agent_id: saved.id },
        orderBy: { city: 'asc' },
      });
      return { ...saved, zones, created: !existing };
    });

    console.log(
      `[agent seed] ${agent.created ? 'Created' : 'Updated'} ${agent.first_name} ${agent.last_name} <${agent.email}>` +
        ` · ${agent.phone} · zones: ${agent.zones.map((z) => `${z.city} (${z.country_code})`).join(', ')}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
