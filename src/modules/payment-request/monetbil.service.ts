import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';

export type MonetbilInitiateResult = {
  success: boolean;
  paymentRef?: string;
  message: string;
};

@Injectable()
export class MonetbilService {
  private readonly logger = new Logger(MonetbilService.name);

  async initiatePayment(params: {
    serviceId: string;
    serviceSecret: string;
    amount: number;
    phone: string;
    operator: string;
    paymentRef: string;
    notifyUrl: string;
    apiUrl: string;
  }): Promise<MonetbilInitiateResult> {
    const body = new URLSearchParams({
      service: params.serviceId,
      amount: String(params.amount),
      phone: params.phone,
      operator: params.operator,
      payment_ref: params.paymentRef,
      notify_url: params.notifyUrl,
    });

    try {
      const response = await fetch(params.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      const data = (await response.json()) as Record<string, unknown>;

      if (!response.ok || data['success'] === false) {
        const message = String(data['message'] ?? 'Monetbil request failed');
        this.logger.warn(`Monetbil initiate failed: ${message}`);
        return { success: false, message };
      }

      return {
        success: true,
        paymentRef: params.paymentRef,
        message: 'USSD push initiated',
      };
    } catch (err) {
      this.logger.error('Monetbil API call error', err);
      return { success: false, message: 'Erreur de communication avec Monetbil' };
    }
  }

  /**
   * Verifies the HMAC-SHA256 signature sent by Monetbil in the webhook payload.
   * Monetbil signs with the service secret: HMAC-SHA256(payment_ref + amount + phone, serviceSecret)
   */
  verifyWebhookSignature(
    payload: Record<string, string>,
    serviceSecret: string,
  ): boolean {
    const { payment_ref, amount, phone, signature } = payload;
    if (!signature) return false;
    const expected = createHmac('sha256', serviceSecret)
      .update(`${payment_ref}${amount}${phone}`)
      .digest('hex');
    return expected === signature;
  }
}
