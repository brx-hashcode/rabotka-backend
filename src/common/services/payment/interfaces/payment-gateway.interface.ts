import {
  InitiatePaymentParams,
  InitiatePaymentResult,
  PaymentGatewayMetadata,
  PaymentStatusResult,
  WebhookHandleResult,
} from '../types/payment-gateway.types';

/**
 * The port every payment gateway implements.
 *
 * Wire shapes — Monetbil's form-encoded `service`/`paymentId`, MTN's
 * `X-Reference-Id` and bearer tokens — live inside the provider and must not
 * leak through this interface. Callers deal in the normalized params and
 * results only, which is what lets the active gateway be a config value rather
 * than a code change.
 */
export interface IPaymentGateway {
  /**
   * What this gateway is and what it needs, for the factory, the operator
   * validation and the admin. Static per provider — never derived from a
   * request.
   */
  readonly metadata: PaymentGatewayMetadata;

  initiatePayment(
    params: InitiatePaymentParams,
  ): Promise<InitiatePaymentResult>;
  checkPaymentStatus(gatewayRef: string): Promise<PaymentStatusResult>;
  handleWebhookPayload(payload: unknown): Promise<WebhookHandleResult>;
}
