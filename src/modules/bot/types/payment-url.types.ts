import type { PaymentRequestType } from '@prisma/client';

export interface IPaymentUrlService {
  createPaymentUrl(
    profileId: string,
    amount: number,
    description: string,
    requestType: PaymentRequestType,
    options?: {
      contactUnlockAttemptId?: string;
      recommendationWorkerId?: string;
    },
  ): Promise<string>;

  initiateDirectPayment(params: {
    profileId: string;
    amount: number;
    phone: string;
    operator: string;
    description: string;
    requestType: PaymentRequestType;
    options?: { contactUnlockAttemptId?: string; recommendationWorkerId?: string };
  }): Promise<{ success: boolean; gatewayRef?: string; error?: string }>;
}
