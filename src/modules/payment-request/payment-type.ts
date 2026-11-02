import { PaymentRequestType, PaymentType } from '@prisma/client';

/**
 * What kind of payment a request produces — the single source of truth.
 *
 * It lives in its own file rather than in `payment-request.service.ts` because
 * both writers of a Payment row need it and the processor cannot import the
 * service: `poll-payment-status.processor.ts` already keeps a hand-written
 * `IProcessApprovedPayment` interface specifically to break that cycle.
 *
 * **This existing as a shared function is the fix**, not an incidental tidy-up.
 * There were two places that turned a request into a payment type — the
 * service's failure path, which called a helper, and the poll processor, which
 * open-coded `isContactType ? CONTACT_UNLOCK : PENALTY`. When `WALLET_TOP_UP`
 * was added the helper learned about it and the ternary did not, so a wallet
 * recharge that failed during gateway polling was filed as a PENALTY — visible
 * to admins as an orange "Penalty" badge against a customer who had simply
 * tried to add credit.
 *
 * The `switch` is exhaustive on purpose. Adding a member to
 * `PaymentRequestType` now fails the build here instead of silently landing in
 * the fallback, which is exactly how the bug above happened.
 */
export function resolvePaymentType(
  requestType: PaymentRequestType | null | undefined,
  isContactUnlock: boolean,
  isRecommendationContact: boolean,
): PaymentType {
  // Checked before the request type: a contact unlock is identified by the
  // attempt attached to the request, which older rows carry without a matching
  // `request_type`.
  if (isContactUnlock || isRecommendationContact) {
    return PaymentType.CONTACT_UNLOCK;
  }

  switch (requestType) {
    case PaymentRequestType.WALLET_TOP_UP:
      return PaymentType.WALLET_TOP_UP;

    case PaymentRequestType.BUSINESS_SUBSCRIPTION:
      return PaymentType.BUSINESS_SUBSCRIPTION;

    case PaymentRequestType.CONTACT_UNLOCK:
    case PaymentRequestType.RECOMMENDATION_CONTACT:
      return PaymentType.CONTACT_UNLOCK;

    case PaymentRequestType.PENALTY_BATCH:
    case PaymentRequestType.PENALTY_RESOLUTION:
      return PaymentType.PENALTY;

    default: {
      // `requestType` is nullable on the model, and requests predating the
      // column carry null — those really were penalties, which is why the
      // fallback is what it is rather than a throw. A FAILED payment row that
      // cannot be written at all is worse than one with a stale type.
      //
      // A NEW enum member reaches here with a non-null value, and this
      // assignment is what turns that into a compile error.
      if (requestType != null) {
        const unhandled: never = requestType;
        void unhandled;
      }
      return PaymentType.PENALTY;
    }
  }
}
