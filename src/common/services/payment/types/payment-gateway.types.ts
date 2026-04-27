export enum PaymentGatewayDriver {
  MONETBIL = 'MONETBIL',
  MTN_MOMO = 'MTN_MOMO',
}

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
