import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IPaymentGateway } from '../interfaces/payment-gateway.interface';
import {
  InitiatePaymentParams,
  InitiatePaymentResult,
  PaymentStatusResult,
  WebhookHandleResult,
} from '../types/payment-gateway.types';
import { fetchWithTimeout } from '../../../utils/fetch-with-timeout.util';

const PLACE_PAYMENT_URL = 'https://api.monetbil.com/payment/v1/placePayment';
const CHECK_PAYMENT_URL = 'https://api.monetbil.com/payment/v1/checkPayment';

@Injectable()
export class MonetbilPaymentGateway implements IPaymentGateway {
  private readonly logger = new Logger(MonetbilPaymentGateway.name);

  constructor(private readonly configService: ConfigService) {}

  async initiatePayment(
    params: InitiatePaymentParams,
  ): Promise<InitiatePaymentResult> {
    const serviceKey = this.configService.get<string>(
      'MONETBIL_SERVICE_KEY',
      '',
    );

    const body = new URLSearchParams({
      service: serviceKey,
      amount: String(params.amount),
      phonenumber: params.phone,
      country: 'CG',
      currency: params.currency,
      operator: (params.metadata?.['operator'] as string) ?? '',
      user: (params.metadata?.['userName'] as string) ?? '',
      email: (params.metadata?.['email'] as string) ?? '',
    });

    try {
      const response = await fetchWithTimeout(PLACE_PAYMENT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      const data = (await response.json()) as Record<string, unknown>;

      if (!response.ok || data['status'] === 'REQUEST_FAILED') {
        const message = String(data['message'] ?? 'Monetbil request failed');
        this.logger.warn(`Monetbil initiate failed: ${message}`);
        throw new Error(message);
      }

      const gatewayRef = data['paymentId']
        ? String(data['paymentId'])
        : params.externalId;

      return { gatewayRef, status: 'PENDING' };
    } catch (err) {
      this.logger.error('Monetbil initiatePayment error', err);
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async checkPaymentStatus(gatewayRef: string): Promise<PaymentStatusResult> {
    const body = new URLSearchParams({ paymentId: gatewayRef });

    try {
      const response = await fetchWithTimeout(CHECK_PAYMENT_URL, {
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
          return { gatewayRef, status: 'COMPLETED', transactionId };
        case '0':
          return { gatewayRef, status: 'FAILED', transactionId };
        case '-1':
          return { gatewayRef, status: 'CANCELLED', transactionId };
        default:
          return { gatewayRef, status: 'PENDING' };
      }
    } catch (err) {
      this.logger.warn(
        `Monetbil checkPaymentStatus error for ${gatewayRef}`,
        err,
      );
      return { gatewayRef, status: 'PENDING' };
    }
  }

  async handleWebhookPayload(payload: unknown): Promise<WebhookHandleResult> {
    const body = payload as Record<string, string>;
    const gatewayRef = body['paymentId'] ?? body['payment_ref'] ?? '';
    const transactionId = body['transaction_id'];

    // Re-verify via API — don't trust the body status field
    const verified = await this.checkPaymentStatus(gatewayRef);

    return {
      gatewayRef,
      status: verified.status === 'PENDING' ? 'PENDING' : verified.status,
      transactionId: verified.transactionId ?? transactionId,
      rawPayload: payload,
    };
  }
}
