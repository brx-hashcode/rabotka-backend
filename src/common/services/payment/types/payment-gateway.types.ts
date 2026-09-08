export enum PaymentGatewayDriver {
  MONETBIL = 'MONETBIL',
  MTN_MOMO = 'MTN_MOMO',
}

/**
 * One mobile-money network a gateway can push a payment to.
 *
 * The codes are the gateway's own wire values, so they belong to the provider
 * that understands them rather than to a shared DTO — `CG_MTNMOBILEMONEY`
 * means nothing to MTN MoMo's own API.
 */
export type PaymentOperatorMetadata = {
  /** Wire value sent to the gateway. */
  code: string;
  /** Human label for the admin and the payment page. */
  label: string;
};

/**
 * What a gateway declares about itself.
 *
 * This is the whole reason adding a provider is a new file rather than an edit
 * to the factory, the DTO and the admin: everything provider-specific that the
 * rest of the app needs to know is stated here, and read from the registry.
 */
export type PaymentGatewayMetadata = {
  /** Registry key, and the value stored in `payment_requests.gateway`. */
  key: PaymentGatewayDriver;
  /** Display name — the admin renders this instead of its own lookup table. */
  label: string;
  /**
   * Whether `initiate` needs an operator code. Monetbil routes by network and
   * cannot infer it; MTN MoMo only ever talks to its own.
   */
  requiresOperator: boolean;
  /** Networks this gateway accepts. Empty when `requiresOperator` is false. */
  operators: PaymentOperatorMetadata[];
};

export type InitiatePaymentParams = {
  amount: number;
  currency: string;
  externalId: string;
  phone: string;
  description?: string;
  metadata?: Record<string, unknown>;
};

export type InitiatePaymentResult = {
  /** Gateway-specific reference stored as gateway_payment_ref */
  gatewayRef: string;
  status: 'PENDING' | 'INITIATED';
};

export type PaymentStatusResult = {
  gatewayRef: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  transactionId?: string;
  failureReason?: string;
  paidAt?: Date;
};

export type WebhookHandleResult = {
  gatewayRef: string;
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'PENDING';
  transactionId?: string;
  rawPayload: unknown;
};
