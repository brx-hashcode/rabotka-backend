/**
 * Does every template the app can SEND actually exist in the WABA?
 *
 * The check nothing else here performs. `author.ts` compares the payload to the
 * registry, `translate.spec.ts` compares the definitions to the registry, and
 * `assertTemplateBindings` compares the registry to itself at boot — three
 * guards that all pass while comparing the repo to the repo. None of them can
 * see that a template was never submitted.
 *
 * That is exactly how `rabotka_kyc_pending_v4` reached production: the
 * definition was written, the registry was pointed at it, and `create.ts` was
 * never run. Every user under KYC review got `132001 Template name does not
 * exist in fr` — silence, on the one message they were waiting for.
 *
 * The difference from `status.ts` is the single thing that matters: names come
 * from the REGISTRY (`templateCloudName`, which honours the `TPL_CLOUD_*`
 * overrides), not from `out/payloads/`. That directory is gitignored and its
 * copy of `kycPendingMenu` still named v3, so `status.ts` reported the old
 * template APPROVED while the app asked for one that did not exist.
 *
 * READ-ONLY. Talks to Meta with GET only; `create.ts --commit` remains the sole
 * writer here.
 *
 * Not wired into boot on purpose: a Graph call on the startup path makes an
 * expired token block every deploy. This is a pre-deploy gate and an ops
 * command — it exits non-zero when something is unsendable.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/whatsapp-templates/verify.ts
 */
import { config } from 'dotenv';
import {
  WHATSAPP_TEMPLATES,
  templateCloudName,
  templateLanguage,
  type WhatsAppTemplateName,
} from '../../src/common/constants/whatsapp-templates';
import { listTemplates, type MetaTemplateSummary } from './meta-client';

config({ path: '.env.local' });
config({ path: '.env' });

type Problem =
  | { kind: 'missing' }
  | { kind: 'language'; available: string[] }
  | { kind: 'status'; status: string; reason?: string };

interface Row {
  key: WhatsAppTemplateName;
  name: string;
  language: string;
  problem?: Problem;
  /** Meta reclassified the category. Reported, but never fatal — see below. */
  drift?: { intended: string; actual: string };
}

function describe(p: Problem): string {
  switch (p.kind) {
    case 'missing':
      return 'MISSING from the WABA';
    case 'language':
      return `not published in this language (found: ${p.available.join(', ') || 'none'})`;
    case 'status':
      return p.reason && p.reason !== 'NONE'
        ? `${p.status} (${p.reason})`
        : p.status;
  }
}

function inspect(live: MetaTemplateSummary[]): Row[] {
  // Keyed by name AND language: Meta stores one row per translation, and a
  // template published only in en_US is not sendable by a `fr` binding. That
  // distinction is the whole reason `templateLanguage` is read here — the 132001
  // message itself ends in "does not exist in fr".
  const byName = new Map<string, MetaTemplateSummary[]>();
  for (const t of live) {
    const bucket = byName.get(t.name);
    if (bucket) bucket.push(t);
    else byName.set(t.name, [t]);
  }

  return (Object.keys(WHATSAPP_TEMPLATES) as WhatsAppTemplateName[]).map(
    (key) => {
      const name = templateCloudName(key);
      const language = templateLanguage(key);
      const row: Row = { key, name, language };

      const candidates = byName.get(name);
      if (!candidates) {
        row.problem = { kind: 'missing' };
        return row;
      }

      const match = candidates.find((t) => t.language === language);
      if (!match) {
        row.problem = {
          kind: 'language',
          available: candidates.map((t) => t.language ?? '?'),
        };
        return row;
      }

      if (match.status !== 'APPROVED') {
        row.problem = {
          kind: 'status',
          status: match.status,
          reason: match.rejected_reason,
        };
      }

      // Meta reclassifies on submission without warning, and a UTILITY template
      // approved as MARKETING is priced differently and can be dropped by a
      // user's marketing opt-out. Worth surfacing — but it is still SENDABLE,
      // so it must not fail the gate and block a deploy.
      const intended = WHATSAPP_TEMPLATES[key].category;
      if (match.category && match.category !== intended) {
        row.drift = { intended, actual: match.category };
      }
      return row;
    },
  );
}

function main(rows: Row[], live: MetaTemplateSummary[]): boolean {
  const broken = rows.filter((r) => r.problem);

  console.log('\n  REGISTRY -> WABA\n');
  for (const r of rows) {
    const verdict = r.problem ? describe(r.problem) : 'ok';
    console.log(
      `  ${(r.problem ? 'FAIL' : 'ok').padEnd(6)} ${r.key.padEnd(30)} ${r.name.padEnd(44)} ${r.language.padEnd(6)} ${r.problem ? verdict : ''}`,
    );
  }

  const drifted = rows.filter((r) => r.drift);
  if (drifted.length) {
    console.log('\n  CATEGORY DRIFT (sendable, but check the pricing)\n');
    for (const r of drifted) {
      console.log(
        `         ${r.key.padEnd(30)} ${r.name.padEnd(44)} ${r.drift?.intended} -> ${r.drift?.actual}`,
      );
    }
  }

  // Old versions the registry no longer names. Harmless to leave — a template
  // nobody asks for costs nothing — but they are what makes the WABA hard to
  // read, and one of them (`rabotka_kyc_pending_menu_v3`) is the near-miss that
  // looks like a rollback and is not: its shape no longer matches the registry
  // entry, so pinning it trades 132001 for 132012.
  //
  // Listed, never deleted. A delete is irreversible and needs a human who knows
  // what is still in flight.
  const known = new Set(rows.map((r) => r.name));
  const orphans = live.filter((t) => !known.has(t.name));
  if (orphans.length) {
    console.log('\n  IN THE WABA, NOT IN THE REGISTRY (nothing deleted)\n');
    for (const t of orphans) {
      console.log(
        `         ${(t.status ?? '?').padEnd(12)} ${(t.language ?? '?').padEnd(6)} ${t.name}`,
      );
    }
  }

  console.log(
    `\n  ${rows.length - broken.length}/${rows.length} sendable` +
      (broken.length ? `   ${broken.length} BROKEN` : '') +
      (drifted.length ? `   ${drifted.length} category drift` : '') +
      (orphans.length ? `   ${orphans.length} orphan(s)` : '') +
      '\n',
  );

  if (broken.length) {
    console.log(
      '  A broken binding is a send that fails in production, not at build time.\n' +
        '  Fix with: author.ts (or generate.ts) --only <key>, then create.ts --only <key> --commit\n',
    );
  }
  return broken.length === 0;
}

listTemplates()
  .then((live) => {
    if (!main(inspect(live), live)) process.exit(1);
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
