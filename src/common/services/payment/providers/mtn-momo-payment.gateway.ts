import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { IPaymentGateway } from '../interfaces/payment-gateway.interface';
import {
  InitiatePaymentParams,
  InitiatePaymentResult,
  PaymentStatusResult,
  WebhookHandleResult,
} from '../types/payment-gateway.types';
import { fetchWithTimeout } from '../../../utils/fetch-with-timeout.util';

type CachedToken = { value: string; expiresAt: number };

@Injectable()
export class MtnMomoPaymentGateway implements IPaymentGateway {
  private readonly logger = new Logger(MtnMomoPaymentGateway.name);
  private cachedToken: CachedToken | null = null;

  constructor(private readonly configService: ConfigService) {}

  private get baseUrl(): string {
    return this.configService.get<string>('MTN_MOMO_BASE_URL', '');
  }

  private get collectionApiUser(): string {
    return this.configService.get<string>('MTN_MOMO_COLLECTION_API_USER', '');
  }

  private get collectionApiKey(): string {
    return this.configService.get<string>('MTN_MOMO_COLLECTION_API_KEY', '');
  }

  private get primaryKey(): string {
    return this.configService.get<string>(
      'MTN_MOMO_COLLECTION_PRIMARY_KEY',
      '',
    );
  }

  private get environment(): string {
    return this.configService.get<string>('MTN_MOMO_ENVIRONMENT', 'sandbox');
  }

  private get callbackUrl(): string {
    return this.configService.get<string>('MTN_MOMO_CALLBACK_URL', '');
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now) {
      return this.cachedToken.value;
    }

    const credentials = Buffer.from(
      `${this.collectionApiUser}:${this.collectionApiKey}`,
    ).toString('base64');

    const response = await fetchWithTimeout(`${this.baseUrl}/collection/token/`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Ocp-Apim-Subscription-Key': this.primaryKey,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `MTN MoMo token fetch failed: ${response.status} — ${text}`,
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };

    // Cache with a 60s safety buffer before actual expiry
    this.cachedToken = {
      value: data.access_token,
      expiresAt: now + (data.expires_in - 60) * 1000,
    };

    return data.access_token;
  }

  async initiatePayment(
    params: InitiatePaymentParams,
  ): Promise<InitiatePaymentResult> {
    const token = await this.getAccessToken();
    const referenceId = randomUUID();

    const body = {
      amount: String(params.amount),
      currency: params.currency,
      externalId: params.externalId,
      payer: { partyIdType: 'MSISDN', partyId: params.phone },
      payerMessage: params.description ?? 'Payment',
      payeeNote: params.description ?? 'Payment',
    };

    const response = await fetchWithTimeout(
      `${this.baseUrl}/collection/v1_0/requesttopay`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Reference-Id': referenceId,
          'X-Target-Environment': this.environment,
          'Ocp-Apim-Subscription-Key': this.primaryKey,
          'X-Callback-Url': this.callbackUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    if (response.status !== 202) {
      const text = await response.text();
      throw new Error(
        `MTN MoMo requesttopay failed: ${response.status} — ${text}`,
      );
    }

    this.logger.log(`MTN MoMo payment initiated: referenceId=${referenceId}`);
    return { gatewayRef: referenceId, status: 'PENDING' };
  }

  async checkPaymentStatus(gatewayRef: string): Promise<PaymentStatusResult> {
    try {
      const token = await this.getAccessToken();

      const response = await fetchWithTimeout(
        `${this.baseUrl}/collection/v1_0/requesttopay/${gatewayRef}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Target-Environment': this.environment,
            'Ocp-Apim-Subscription-Key': this.primaryKey,
          },
        },
      );

      if (!response.ok) {
        this.logger.warn(
          `MTN MoMo checkPaymentStatus ${response.status} for ${gatewayRef}`,
        );
        return { gatewayRef, status: 'PENDING' };
      }

      const data = (await response.json()) as Record<string, unknown>;
      const status = data['status'] as string;

      switch (status) {
        case 'SUCCESSFUL':
          return {
            gatewayRef,
            status: 'COMPLETED',
            transactionId: data['financialTransactionId'] as string | undefined,
            paidAt: new Date(),
          };
        case 'FAILED':
          return {
            gatewayRef,
            status: 'FAILED',
            failureReason: data['reason'] as string | undefined,
          };
        default:
          return { gatewayRef, status: 'PENDING' };
      }
    } catch (err) {
      this.logger.warn(
        `MTN MoMo checkPaymentStatus error for ${gatewayRef}`,
        err,
      );
      return { gatewayRef, status: 'PENDING' };
    }
  }

  async handleWebhookPayload(payload: unknown): Promise<WebhookHandleResult> {
    const body = payload as Record<string, unknown>;
    const gatewayRef =
      (body['externalId'] as string) ?? (body['referenceId'] as string) ?? '';

    // Re-verify via API — don't trust webhook body alone
    const verified = await this.checkPaymentStatus(gatewayRef);

    return {
      gatewayRef,
      status: verified.status === 'PENDING' ? 'PENDING' : verified.status,
      transactionId: verified.transactionId,
      rawPayload: payload,
    };
  }
}
