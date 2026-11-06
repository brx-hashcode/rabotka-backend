/**
 * Why the operator refused a payment, said to the payer: what happened and
 * what to do. Keyed by the gateways' own failure codes — pawaPay's
 * `failureReason.failureCode` (v2, with the v1 names still seen) and MTN
 * MoMo's `reason`. A code missing here (UNSPECIFIED_FAILURE, UNKNOWN_ERROR…)
 * has nothing more useful to say than the generic message: null.
 */
const MESSAGES: Record<string, string> = {
  // Not validated: PIN not typed in time, wrong PIN, or refused on the phone.
  PAYMENT_NOT_APPROVED:
    "La demande n'a pas été validée sur le téléphone : code secret non saisi à temps, erroné, ou demande refusée.",
  APPROVAL_REJECTED:
    'La demande a été refusée sur le téléphone, ou le code secret saisi était erroné.',
  NO_AUTHORISATION:
    "La demande n'a pas été validée sur le téléphone : code secret non saisi à temps, erroné, ou demande refusée.",
  EXPIRED: "La demande a expiré avant d'être validée sur le téléphone.",
  TIMEOUT: "La demande a expiré avant d'être validée sur le téléphone.",

  INSUFFICIENT_BALANCE:
    'Solde mobile money insuffisant. Rechargez votre compte, puis réessayez.',
  NOT_ENOUGH_FUNDS:
    'Solde mobile money insuffisant. Rechargez votre compte, puis réessayez.',

  PAYMENT_IN_PROGRESS:
    'Une autre demande de paiement est encore ouverte sur ce numéro. Attendez quelques minutes, puis réessayez.',
  TRANSACTION_ALREADY_IN_PROCESS:
    'Une autre demande de paiement est encore ouverte sur ce numéro. Attendez quelques minutes, puis réessayez.',

  PAYER_NOT_FOUND:
    "Ce numéro n'a pas de compte mobile money chez cet opérateur. Vérifiez le numéro et l'opérateur choisi.",

  WALLET_LIMIT_REACHED:
    'Votre compte mobile money a atteint son plafond de transactions. Réessayez plus tard, ou avec un autre numéro.',
  PAYER_LIMIT_REACHED:
    'Votre compte mobile money a atteint son plafond de transactions. Réessayez plus tard, ou avec un autre numéro.',
};

export function paymentFailureMessage(
  code: string | null | undefined,
): string | null {
  return (code && MESSAGES[code]) || null;
}
