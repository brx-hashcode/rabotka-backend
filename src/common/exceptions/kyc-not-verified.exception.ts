import { ForbiddenException } from '@nestjs/common';
import { VerificationStatus } from '@prisma/client';

/**
 * Machine-readable marker so the client can tell a KYC block apart from any
 * other 403 and react to it (explain, refresh the profile) instead of showing a
 * generic failure.
 */
export const KYC_NOT_VERIFIED = 'KYC_NOT_VERIFIED';

const PENDING_MESSAGE =
  "Votre profil est en cours de vérification. Vous recevrez une notification dès qu'elle sera terminée.";

// A refused user must not be told to wait for a notification that will never
// come — only an admin can change the decision, so point them at support.
const REJECTED_MESSAGE =
  "Votre vérification d'identité a été refusée. Contactez le support pour régulariser votre situation.";

export class KycNotVerifiedException extends ForbiddenException {
  constructor(status: VerificationStatus) {
    super({
      statusCode: 403,
      message:
        status === VerificationStatus.REJECTED
          ? REJECTED_MESSAGE
          : PENDING_MESSAGE,
      code: KYC_NOT_VERIFIED,
      verificationStatus: status,
    });
  }
}

/**
 * The single KYC decision in the codebase.
 *
 * Deliberately a pure function rather than logic inside the guard: the HTTP
 * guard and the service-level checks (which also cover the WhatsApp bot, where
 * no guard runs) must never be able to disagree about who is blocked or what
 * they are told.
 */
export function assertKycVerified(status: VerificationStatus): void {
  if (status !== VerificationStatus.VERIFIED) {
    throw new KycNotVerifiedException(status);
  }
}
