import type { PaymentRequestType } from '@prisma/client';

export interface IPaymentUrlService {
  createPaymentUrl(
    profileId: string,
    amount: number,
    description: string,
    requestTypeOrAttemptId: PaymentRequestType | string,
    options?: {
      contactUnlockAttemptId?: string;
      recommendationWorkerId?: string;
    },
  ): Promise<string>;
}
