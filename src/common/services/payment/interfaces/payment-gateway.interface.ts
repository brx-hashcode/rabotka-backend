import {
  InitiatePaymentParams,
  InitiatePaymentResult,
  PaymentStatusResult,
  WebhookHandleResult,
} from '../types/payment-gateway.types';

export interface IPaymentGateway {
  initiatePayment(
    params: InitiatePaymentParams,
  ): Promise<InitiatePaymentResult>;
  checkPaymentStatus(gatewayRef: string): Promise<PaymentStatusResult>;
  handleWebhookPayload(payload: unknown): Promise<WebhookHandleResult>;
}
