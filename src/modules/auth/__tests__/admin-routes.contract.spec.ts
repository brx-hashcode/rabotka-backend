import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { globSync } from 'glob';

/**
 * The invariants that were violated in production rather than in theory.
 *
 * Two admin endpoints shipped with no `@UseGuards` at all — `kyc/:id/approve`
 * and the whole `dev/advertisements` controller — and because this app
 * registers no global auth guard, both were reachable by anyone on the
 * internet. Nothing failed; there was simply no test that asked.
 *
 * This reads the controller SOURCES rather than booting the app: `AppModule`
 * pulls in `@arcjet/nest`, which is ESM and outside jest's transform, so a
 * `Test.createTestingModule` version cannot run here. Reading the decorators is
 * enough for these three questions, it costs milliseconds, and it is the same
 * static-lint approach `corpus.spec.ts` already takes.
 */

const SRC = path.join(__dirname, '..', '..', '..');

/**
 * Prefixes deliberately reachable without an admin session. Each entry is a
 * decision, so adding one should feel like a decision: say why.
 */
const PUBLIC_PREFIXES = new Set([
  '', // AppController — root/health
  'auth', // login, OTP, QR pairing; guarded per handler where it matters
  'health',
  'csrf',
  'metrics',
  's', // one-tap short links
  'r', // ad click tracking
  'webhooks',
  'whatsapp', // Meta webhook — verified by signature, not by session
  'public',
  'public/config',
  'public/documents',
  'job-categories', // the public taxonomy the client renders
  'job-offers',
  'ads',
  'file',
  'conversation',
  // Profile-guarded rather than admin-guarded: these carry ProfileAuthGuard.
  'profile',
  'profiles',
  'contracts',
  'invoices',
  'claims',
  'applications',
  'payments',
  'wallet',
  'notifications',
]);

/**
 * Everything under `profile/` belongs to the app's own users and carries
 * `ProfileAuthGuard`, not `AdminAuthGuard`. A rule rather than a list, so a new
 * profile-facing controller does not have to be added here to stay green — and
 * so that nothing admin-facing can be waved through by naming it `profile/x`.
 */
const PROFILE_PREFIX = /^profile(\/|$)/;

/**
 * Namespaces that are public all the way down. `webhooks/*` authenticate by
 * provider signature rather than by session, and `public/*` is public by name.
 */
const PUBLIC_NAMESPACE = /^(public|webhooks)(\/|$)/;

/**
 * Admin controllers that authorize by hand instead of by decorator, with the
 * reason. Exempt from the `@Roles` rule only — they still need both guards.
 */
const INLINE_AUTHORIZED = new Map([
  [
    'admin/wallet',
    'Checks ALLOWED_WALLET_ROLES per handler: the rule is "ADMIN and above OR ' +
      'FINANCE", which one @Roles cannot express. See the note on the set.',
  ],
]);

type ControllerSource = {
  file: string;
  prefix: string;
  /** Decorator text between @Controller and `export class`. */
  head: string;
  body: string;
};

function loadControllers(): ControllerSource[] {
  const files = globSync('**/*.controller.ts', { cwd: SRC, absolute: true });
  const out: ControllerSource[] = [];

  for (const file of files) {
    if (file.includes('__tests__')) continue;
    const text = readFileSync(file, 'utf8');

    // One file may hold several controllers (claims does).
    const re = /@Controller\(\s*'([^']*)'\s*\)/g;
    let match: RegExpExecArray | null;
    const starts: { prefix: string; at: number }[] = [];
    while ((match = re.exec(text))) {
      starts.push({
        prefix: match[1].replace(/^\/+|\/+$/g, ''),
        at: match.index,
      });
    }

    starts.forEach(({ prefix, at }, i) => {
      const end = i + 1 < starts.length ? starts[i + 1].at : text.length;
      // Widen backwards: @UseGuards and @Roles are often written ABOVE
      // @Controller, which would otherwise land in the previous section.
      const from = i === 0 ? 0 : Math.max(starts[i - 1].at, at - 400);
      const section = text.slice(from, end);
      const classAt = section.indexOf('export class');
      out.push({
        file: path.relative(SRC, file),
        prefix,
        head: classAt === -1 ? section : section.slice(0, classAt),
        body: classAt === -1 ? '' : section.slice(classAt),
      });
    });
  }

  return out;
}

/** Each HTTP handler with the decorator block that precedes its method name. */
function handlersOf(body: string): { verb: string; decorators: string }[] {
  const re =
    /@(Get|Post|Patch|Put|Delete)\([^)]*\)((?:\s*@[A-Za-z]+\([\s\S]*?\)|\s*@[A-Za-z]+)*)/g;
  const out: { verb: string; decorators: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.push({ verb: m[1], decorators: m[2] ?? '' });
  return out;
}

describe('admin route contract', () => {
  const controllers = loadControllers();
  const admin = controllers.filter(
    (c) =>
      !PUBLIC_PREFIXES.has(c.prefix) &&
      !PROFILE_PREFIX.test(c.prefix) &&
      !PUBLIC_NAMESPACE.test(c.prefix),
  );

  it('finds the controllers (guards against a silent no-op)', () => {
    expect(controllers.length).toBeGreaterThan(25);
    expect(admin.length).toBeGreaterThan(15);
  });

  it('guards every admin controller with AdminAuthGuard and RolesGuard', () => {
    const unguarded = admin
      .filter((c) => {
        // Either placement counts: `log` mounts both on the handler.
        const text = c.head + c.body;
        return !(
          /@UseGuards\([^)]*AdminAuthGuard[^)]*\)/s.test(text) &&
          /@UseGuards\([^)]*RolesGuard[^)]*\)/s.test(text)
        );
      })
      .map((c) => `${c.prefix} (${c.file})`);

    expect(unguarded).toEqual([]);
  });

  it('declares a role on every admin handler', () => {
    const undeclared: string[] = [];

    for (const c of admin) {
      if (INLINE_AUTHORIZED.has(c.prefix)) continue;
      const classRoles = /@Roles\(/.test(c.head);
      for (const h of handlersOf(c.body)) {
        if (!classRoles && !/@Roles\(/.test(h.decorators)) {
          undeclared.push(`${c.prefix} ${h.verb} (${c.file})`);
        }
      }
    }

    expect(undeclared).toEqual([]);
  });

  /**
   * `requiredLevel` filters lateral roles out before taking a minimum, so a
   * handler declaring ONLY lateral roles resolves to Infinity and denies
   * everyone — SUPER_ADMIN included. Fail-closed, but never what anyone means.
   */
  it('never names a lateral role in @Roles', () => {
    const offenders = controllers
      .filter((c) =>
        /@Roles\([^)]*(FINANCE|SUPPORT)[^)]*\)/.test(c.head + c.body),
      )
      .map((c) => `${c.prefix} (${c.file})`);

    expect(offenders).toEqual([]);
  });
});
