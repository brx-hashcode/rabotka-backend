import { ConfigService } from '@nestjs/config';
import { IPaymentGateway } from './interfaces/payment-gateway.interface';
import {
  PAWAPAY_METADATA,
  PawapayPaymentGateway,
} from './providers/pawapay-payment.gateway';
import {
  MTN_MOMO_METADATA,
  MtnMomoPaymentGateway,
} from './providers/mtn-momo-payment.gateway';
import {
  PaymentGatewayDriver,
  PaymentGatewayMetadata,
} from './types/payment-gateway.types';

type PaymentGatewayRegistration = {
  metadata: PaymentGatewayMetadata;
  build: (config: ConfigService) => IPaymentGateway;
};

/**
 * Every gateway the application can run on.
 *
 * Adding a provider is a new file plus one entry here — the factory, the
 * operator validation and the admin all read this table, so none of them needs
 * to learn the new name. Keys are the values stored in
 * `payment_requests.gateway`, which is why they must never be renamed once a
 * row carries them.
 */
export const PAYMENT_GATEWAY_REGISTRY: Record<
  PaymentGatewayDriver,
  PaymentGatewayRegistration
> = {
  [PaymentGatewayDriver.PAWAPAY]: {
    metadata: PAWAPAY_METADATA,
    build: (config) => new PawapayPaymentGateway(config),
  },
  [PaymentGatewayDriver.MTN_MOMO]: {
    metadata: MTN_MOMO_METADATA,
    build: (config) => new MtnMomoPaymentGateway(config),
  },
};

/** Registry keys, for validation messages and the admin listing. */
export function listPaymentGatewayDrivers(): PaymentGatewayDriver[] {
  return Object.keys(PAYMENT_GATEWAY_REGISTRY) as PaymentGatewayDriver[];
}

/** What every gateway declares about itself — the admin renders this. */
export function listPaymentGatewayMetadata(): PaymentGatewayMetadata[] {
  return listPaymentGatewayDrivers().map(
    (key) => PAYMENT_GATEWAY_REGISTRY[key].metadata,
  );
}

/**
 * Resolves a driver string from config to a registry entry.
 *
 * Returns null rather than throwing so callers can phrase their own error —
 * boot failure in the factory, a 400 in a request path.
 */
export function resolvePaymentGatewayDriver(
  raw: string | undefined | null,
): PaymentGatewayDriver | null {
  const key = (raw ?? '').trim().toUpperCase();
  return key in PAYMENT_GATEWAY_REGISTRY ? (key as PaymentGatewayDriver) : null;
}

/** Metadata for one driver, or null when it is not a registered gateway. */
export function findPaymentGatewayMetadata(
  driver: string | undefined | null,
): PaymentGatewayMetadata | null {
  const key = resolvePaymentGatewayDriver(driver);
  return key ? PAYMENT_GATEWAY_REGISTRY[key].metadata : null;
}
