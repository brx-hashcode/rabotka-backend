export enum PaymentGatewayDriver {
  PAWAPAY = 'PAWAPAY',
  MTN_MOMO = 'MTN_MOMO',
}

/**
 * One mobile-money network a gateway can push a payment to.
 *
 * The codes are the gateway's own wire values, so they belong to the provider
 * that understands them rather than to a shared DTO — `MTN_MOMO_COG` means
 * nothing to MTN MoMo's own API.
 */
export type PaymentOperatorMetadata = {
  /** Wire value sent to the gateway. */
  code: string;
  /** Human label for the admin and the payment page. */
  label: string;
  /**
   * ISO 3166-1 alpha-3 country the network serves, for gateways that cover
   * several. The payment page offers a payer only their own country's.
   */
  country?: string;
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
   * Whether `initiate` needs an operator code. pawaPay routes by network and
   * cannot infer it; MTN MoMo only ever talks to its own.
   */
  requiresOperator: boolean;
  /** Networks this gateway accepts. Empty when `requiresOperator` is false. */
  operators: PaymentOperatorMetadata[];
};

/**
 * Who is paying, for the gateway's own records (dashboard, statements,
 * callbacks). Gateways that have nowhere to put it ignore it.
 */
export type PaymentPayer = {
  profileId: string;
  /** First and last name. */
  name: string;
  email?: string | null;
  profileType?: string | null;
};

export type InitiatePaymentParams = {
  amount: number;
  currency: string;
  /** Our payment request id. */
  externalId: string;
  phone: string;
  /** Network code, for gateways that route by operator. */
  operator?: string;
  description?: string;
  /** What is being paid for (`PaymentRequestType`). */
  requestType?: string | null;
  payer?: PaymentPayer;
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
  /**
   * What the gateway says was actually paid, when it reports it. Compared
   * with the request before approving, so a settled amount or currency that
   * differs from what was asked is never taken as payment in full.
   */
  amount?: number;
  currency?: string;
};

export type WebhookHandleResult = {
  gatewayRef: string;
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'PENDING';
  transactionId?: string;
  /** As in `PaymentStatusResult`: what was actually paid, when known. */
  amount?: number;
  currency?: string;
  rawPayload: unknown;
};

/** A transfer from our account to someone's mobile-money wallet. */
export type InitiatePayoutParams = {
  amount: number;
  currency: string;
  /** Our own reference for the payout, kept on the gateway's record. */
  externalId: string;
  phone: string;
  operator: string;
  description?: string;
};

export type PayoutResult = {
  /** Gateway-specific reference, needed to check the payout later. */
  gatewayRef: string;
  status: 'PENDING' | 'INITIATED';
};

export type PayoutStatusResult = {
  gatewayRef: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  transactionId?: string;
  failureReason?: string;
};

/** One wallet on the gateway account. */
export type GatewayBalance = {
  /** ISO 3166-1 alpha-3 country code. */
  country: string;
  currency: string;
  /** Kept as the gateway sends it — a decimal string, never a float. */
  balance: string;
  /** The single operator using this wallet, when there is one. */
  operator?: string;
};

/** A country the gateway account holds a wallet in. */
export type GatewayCountry = {
  /** ISO 3166-1 alpha-3 code, e.g. `COG`. */
  code: string;
  name: string;
};
