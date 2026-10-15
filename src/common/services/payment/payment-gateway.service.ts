import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PaymentGatewayFactory } from './payment-gateway.factory';
import {
  IPaymentGateway,
  supportsBalances,
  supportsPayouts,
} from './interfaces/payment-gateway.interface';
import { listPaymentGatewayMetadata } from './payment-gateway.registry';
import {
  GatewayBalance,
  GatewayCountry,
  InitiatePaymentParams,
  InitiatePaymentResult,
  InitiatePayoutParams,
  PayoutResult,
  PayoutStatusResult,
  PaymentGatewayMetadata,
  PaymentStatusResult,
  WebhookHandleResult,
} from './types/payment-gateway.types';

@Injectable()
export class PaymentGatewayService implements OnModuleInit {
  private readonly logger = new Logger(PaymentGatewayService.name);
  private gateway: IPaymentGateway | null = null;
  /** Why no gateway could be built, when that happened at boot. */
  private unavailable: string | null = null;

  constructor(
    @Inject(PaymentGatewayFactory)
    private readonly factory: PaymentGatewayFactory,
  ) {}

  /**
   * Builds the configured gateway. A missing or retired driver (e.g. a deploy
   * still set to MONETBIL) disables payments instead of crashing the API: the
   * rest of the application has nothing to do with it, and a boot failure
   * would take every route down with the payment page.
   */
  onModuleInit(): void {
    try {
      this.gateway = this.factory.create();
      this.unavailable = null;
      this.logger.log('Payment gateway service initialized');
    } catch (err) {
      this.gateway = null;
      this.unavailable = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Payments disabled — no usable gateway: ${this.unavailable}`,
      );
    }
  }

  private ensureGateway(): IPaymentGateway {
    if (this.unavailable !== null) {
      throw new ServiceUnavailableException(
        'Le paiement est momentanément indisponible.',
      );
    }
    if (!this.gateway) {
      throw new Error(
        'PaymentGatewayService not initialized. Ensure PaymentGatewayModule is imported.',
      );
    }
    return this.gateway;
  }

  /** The active gateway, or null when payments are disabled. */
  getActiveMetadataOrNull(): PaymentGatewayMetadata | null {
    return this.gateway?.metadata ?? null;
  }

  /** What the gateway this deployment runs on declares about itself. */
  getActiveMetadata(): PaymentGatewayMetadata {
    return this.ensureGateway().metadata;
  }

  /**
   * Every gateway the application could run on, active or not.
   *
   * The admin lists these to label historical rows: a `payment_requests.gateway`
   * of MTN_MOMO still needs a name after the deployment has moved to pawaPay.
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

  /** Whether the active gateway can report its account balances. */
  supportsBalances(): boolean {
    return this.gateway !== null && supportsBalances(this.gateway);
  }

  /** Whether the active gateway can send money out. */
  supportsPayouts(): boolean {
    return this.gateway !== null && supportsPayouts(this.gateway);
  }

  async getBalances(country: string): Promise<GatewayBalance[]> {
    const gateway = this.ensureGateway();
    if (!supportsBalances(gateway)) {
      throw new Error(`${gateway.metadata.label} does not report balances`);
    }
    return gateway.getBalances(country);
  }

  async listBalanceCountries(): Promise<GatewayCountry[]> {
    const gateway = this.ensureGateway();
    if (!supportsBalances(gateway)) {
      throw new Error(`${gateway.metadata.label} does not report balances`);
    }
    return gateway.listBalanceCountries();
  }

  async initiatePayout(params: InitiatePayoutParams): Promise<PayoutResult> {
    const gateway = this.ensureGateway();
    if (!supportsPayouts(gateway)) {
      throw new Error(`${gateway.metadata.label} cannot send payouts`);
    }
    return gateway.initiatePayout(params);
  }

  async checkPayoutStatus(gatewayRef: string): Promise<PayoutStatusResult> {
    const gateway = this.ensureGateway();
    if (!supportsPayouts(gateway)) {
      throw new Error(`${gateway.metadata.label} cannot send payouts`);
    }
    return gateway.checkPayoutStatus(gatewayRef);
  }
}
