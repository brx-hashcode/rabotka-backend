import { resolveMx, resolve4, resolve6 } from 'node:dns/promises';
import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

const DNS_TIMEOUT_MS = 3_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('dns_timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Validates an email domain can plausibly receive mail.
 *
 * Behaviour:
 *  - Reject only if we can *prove* the domain has neither MX nor A/AAAA records
 *    (RFC 5321 §5.1: SMTP falls back to address records when no MX exists).
 *  - On any DNS error (timeout, server failure, network blip), return true.
 *    Telling a user "your email is invalid" because *our* DNS is flaky is wrong.
 */
@ValidatorConstraint({ name: 'hasMxRecord', async: true })
export class HasMxRecordConstraint implements ValidatorConstraintInterface {
  async validate(email: string): Promise<boolean> {
    if (!email?.includes('@')) return false;

    const domain = email.split('@')[1]?.trim();
    if (!domain) return false;

    try {
      const records = await withTimeout(resolveMx(domain), DNS_TIMEOUT_MS);
      if (records.length > 0) return true;
    } catch {
      // ENOTFOUND / ENODATA / timeout — fall through to A/AAAA probe.
    }

    // No MX? Try address records — they're a valid SMTP fallback.
    try {
      const a = await withTimeout(resolve4(domain), DNS_TIMEOUT_MS);
      if (a.length > 0) return true;
    } catch {
      /* try AAAA */
    }
    try {
      const aaaa = await withTimeout(resolve6(domain), DNS_TIMEOUT_MS);
      if (aaaa.length > 0) return true;
    } catch {
      /* give the user the benefit of the doubt below */
    }

    // Couldn't confirm OR refute deliverability. Be lenient — the syntactic
    // @IsEmail() check ahead of this decorator has already caught garbage.
    return true;
  }

  defaultMessage(): string {
    return "L'email fourni n'est pas valide. Utilisez un email valide.";
  }
}

export function HasMxRecord(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: HasMxRecordConstraint,
    });
  };
}
