import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PaymentGatewayFactory } from './payment-gateway.factory';
import { IPaymentGateway } from './interfaces/payment-gateway.interface';
import {
  InitiatePaymentParams,
  InitiatePaymentResult,
  PaymentStatusResult,
  WebhookHandleResult,
} from './types/payment-gateway.types';

@Injectable()
export class PaymentGatewayService implements OnModuleInit {
  private readonly logger = new Logger(PaymentGatewayService.name);
  private gateway: IPaymentGateway | null = null;

  constructor(
    @Inject(PaymentGatewayFactory)
    private readonly factory: PaymentGatewayFactory,
  ) {}

  async onModuleInit(): Promise<void> {
    this.gateway = await this.factory.create();
    this.logger.log('Payment gateway service initialized');
  }

  private ensureGateway(): IPaymentGateway {
    if (!this.gateway) {
      throw new Error(
        'PaymentGatewayService not initialized. Ensure PaymentGatewayModule is imported.',
      );
    }
    return this.gateway;
  }

  async initiatePayment(
    params: InitiatePaymentParams,
  ): Promise<InitiatePaymentResult> {
    return this.ensureGateway().initiatePayment(params);
  }

  async checkPaymentStatus(gatewayRef: string): Promise<PaymentStatusResult> {
    return this.ensureGateway().checkPaymentStatus(gatewayRef);
  }

  async handleWebhookPayload(payload: unknown): Promise<WebhookHandleResult> {
    return this.ensureGateway().handleWebhookPayload(payload);
  }
}
