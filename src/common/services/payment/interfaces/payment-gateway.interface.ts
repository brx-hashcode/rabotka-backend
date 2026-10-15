import {
  GatewayBalance,
  GatewayCountry,
  InitiatePaymentParams,
  InitiatePaymentResult,
  InitiatePayoutParams,
  PaymentGatewayMetadata,
  PaymentStatusResult,
  PayoutResult,
  PayoutStatusResult,
  WebhookHandleResult,
} from '../types/payment-gateway.types';

/**
 * The port every payment gateway implements.
 *
 * Wire shapes — pawaPay's `depositId` and metadata items, MTN's
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

  // ── Optional capabilities ────────────────────────────────────────────────
  // Not every gateway can send money or report a balance. Callers check with
  // `supportsPayouts` / `supportsBalances` rather than catching a throw.

  initiatePayout?(params: InitiatePayoutParams): Promise<PayoutResult>;
  checkPayoutStatus?(gatewayRef: string): Promise<PayoutStatusResult>;
  /** Balances of the account's wallets in one country (ISO3). */
  getBalances?(country: string): Promise<GatewayBalance[]>;
  /** Countries the account holds wallets in. */
  listBalanceCountries?(): Promise<GatewayCountry[]>;
}

export type PayoutCapableGateway = IPaymentGateway &
  Required<Pick<IPaymentGateway, 'initiatePayout' | 'checkPayoutStatus'>>;

export type BalanceCapableGateway = IPaymentGateway &
  Required<Pick<IPaymentGateway, 'getBalances' | 'listBalanceCountries'>>;

export function supportsPayouts(
  gateway: IPaymentGateway,
): gateway is PayoutCapableGateway {
  return (
    typeof gateway.initiatePayout === 'function' &&
    typeof gateway.checkPayoutStatus === 'function'
  );
}

export function supportsBalances(
  gateway: IPaymentGateway,
): gateway is BalanceCapableGateway {
  return (
    typeof gateway.getBalances === 'function' &&
    typeof gateway.listBalanceCountries === 'function'
  );
}
