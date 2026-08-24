import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PaymentGatewayFactory } from './payment-gateway.factory';
import { IPaymentGateway } from './interfaces/payment-gateway.interface';
import { listPaymentGatewayMetadata } from './payment-gateway.registry';
import {
  InitiatePaymentParams,
  InitiatePaymentResult,
  PaymentGatewayMetadata,
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

  onModuleInit(): void {
    this.gateway = this.factory.create();
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

  /** What the gateway this deployment runs on declares about itself. */
  getActiveMetadata(): PaymentGatewayMetadata {
    return this.ensureGateway().metadata;
  }

  /**
   * Every gateway the application could run on, active or not.
   *
   * The admin lists these to label historical rows: a `payment_requests.gateway`
   * of MONETBIL still needs a name after the deployment has moved to MTN.
   */
  listAvailable(): PaymentGatewayMetadata[] {
    return listPaymentGatewayMetadata();
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
