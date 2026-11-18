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
// come: they can send new documents from the app.
const REJECTED_MESSAGE =
  "Votre vérification d'identité a été refusée. Envoyez de nouveaux documents depuis votre profil, rubrique Vérification d'identité.";

// Signed up without their documents: nothing is being checked, so « en cours
// de vérification » would be false. The same code (clients key on it, and
// read `verificationStatus` for the rest), another message.
const NOT_SUBMITTED_MESSAGE =
  "Envoyez votre pièce d'identité et un selfie depuis votre profil, rubrique Vérification d'identité, pour commencer à utiliser Rabotka.";

function messageFor(status: VerificationStatus | null | undefined): string {
  switch (status) {
    case VerificationStatus.REJECTED:
      return REJECTED_MESSAGE;
    case VerificationStatus.NOT_SUBMITTED:
      return NOT_SUBMITTED_MESSAGE;
    default:
      return PENDING_MESSAGE;
  }
}

export class KycNotVerifiedException extends ForbiddenException {
  constructor(status: VerificationStatus) {
    super({
      statusCode: 403,
      message: messageFor(status),
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
