import { Injectable, Logger } from '@nestjs/common';

const MONETBIL_PLACE_PAYMENT_URL =
  'https://api.monetbil.com/payment/v1/placePayment';
const MONETBIL_CHECK_PAYMENT_URL =
  'https://api.monetbil.com/payment/v1/checkPayment';

export type MonetbilInitiateResult = {
  success: boolean;
  paymentId?: string;
  message: string;
};

/** Status returned by checkPayment */
export type MonetbilPaymentStatus =
  | 'SUCCESS' // transaction.status === "1"
  | 'FAILED' // transaction.status === "0"
  | 'CANCELLED' // transaction.status === "-1"
  | 'PENDING'; // no conclusive status yet

export type MonetbilCheckResult = {
  status: MonetbilPaymentStatus;
  transactionId?: string;
};

@Injectable()
export class MonetbilService {
  private readonly logger = new Logger(MonetbilService.name);

  async initiatePayment(params: {
    serviceKey: string;
    amount: number;
    phonenumber: string;
    operator: string;
    user: string;
    email: string;
  }): Promise<MonetbilInitiateResult> {
    const body = new URLSearchParams({
      service: params.serviceKey,
      amount: String(params.amount),
      phonenumber: params.phonenumber,
      country: 'CG',
      currency: 'XAF',
      operator: params.operator,
      user: params.user,
      email: params.email,
    });

    try {
      const response = await fetch(MONETBIL_PLACE_PAYMENT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      const data = (await response.json()) as Record<string, unknown>;

      if (!response.ok || data['status'] === 'REQUEST_FAILED') {
        const message = String(data['message'] ?? 'Monetbil request failed');
        this.logger.warn(`Monetbil initiate failed: ${message}`);
        return { success: false, message };
      }

      const paymentId = data['paymentId']
        ? String(data['paymentId'])
        : undefined;
      return { success: true, paymentId, message: 'USSD push initiated' };
    } catch (err) {
      this.logger.error('Monetbil API call error', err);
      return {
        success: false,
        message: 'Erreur de communication avec Monetbil',
      };
    }
  }

  async checkPayment(paymentId: string): Promise<MonetbilCheckResult> {
    const body = new URLSearchParams({ paymentId });

    try {
      const response = await fetch(MONETBIL_CHECK_PAYMENT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      const data = (await response.json()) as Record<string, unknown>;
      const tx = data['transaction'] as Record<string, unknown> | undefined;
      const txStatus = tx?.['status'];
      const transactionId = tx?.['transaction_id']
        ? String(tx['transaction_id'])
        : undefined;

      switch (txStatus) {
        case '1':
          return { status: 'SUCCESS', transactionId };
        case '0':
          return { status: 'FAILED', transactionId };
        case '-1':
          return { status: 'CANCELLED', transactionId };
        default:
          return { status: 'PENDING' };
      }
    } catch (err) {
      this.logger.warn(`Monetbil checkPayment error for ${paymentId}`, err);
      return { status: 'PENDING' };
    }
  }
}
