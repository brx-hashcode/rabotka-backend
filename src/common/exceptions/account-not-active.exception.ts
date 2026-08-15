import { ForbiddenException } from '@nestjs/common';
import { AccountStatus } from '@prisma/client';

/**
 * Machine-readable marker so the client can tell an account block apart from
 * any other 403 and explain it, rather than showing a generic failure.
 *
 * Deliberately not `ACCOUNT_SUSPENDED`: the same block covers BANNED and
 * PENDING_ACTIVATION, and a client branching on the code should not have to
 * learn a new one each time a status is added.
 */
export const ACCOUNT_NOT_ACTIVE = 'ACCOUNT_NOT_ACTIVE';

const SUSPENDED_MESSAGE =
  'Votre compte est suspendu. Vous ne pouvez pas effectuer cette action tant que la situation n’est pas régularisée.';

// A banned account is not coming back, so it must not be told to regularise
// anything — that would promise a path that does not exist.
const BANNED_MESSAGE =
  'Votre compte a été banni. Contactez le support pour plus d’informations.';

const PENDING_MESSAGE =
  'Votre compte n’est pas encore activé. Vous pourrez effectuer cette action dès son activation.';

function messageFor(status: AccountStatus): string {
  if (status === AccountStatus.BANNED) return BANNED_MESSAGE;
  if (status === AccountStatus.SUSPENDED) return SUSPENDED_MESSAGE;
  return PENDING_MESSAGE;
}

export class AccountNotActiveException extends ForbiddenException {
  constructor(status: AccountStatus, reason?: string | null) {
    super({
      statusCode: 403,
      message: messageFor(status),
      code: ACCOUNT_NOT_ACTIVE,
      accountStatus: status,
      // The admin's own words, when there are any. Without it the user is told
      // they are suspended but not what to fix, which is the whole complaint
      // the suspension-reason work set out to answer.
      ...(reason ? { reason } : {}),
    });
  }
}

/**
 * The single account-status decision in the codebase.
 *
 * A pure function rather than logic inside the guard, for the same reason
 * `assertKycVerified` is one: the HTTP guard and the service-level checks
 * (which also cover the WhatsApp bot, where no guard runs) must never be able
 * to disagree about who is blocked or what they are told.
 */
export function assertAccountActive(
  status: AccountStatus,
  reason?: string | null,
): void {
  if (status !== AccountStatus.ACTIVE) {
    throw new AccountNotActiveException(status, reason);
  }
}
