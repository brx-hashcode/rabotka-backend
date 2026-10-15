import {
  PAYMENT_GATEWAY_REGISTRY,
  findPaymentGatewayMetadata,
  listPaymentGatewayDrivers,
  listPaymentGatewayMetadata,
  resolvePaymentGatewayDriver,
} from '../payment-gateway.registry';
import { PaymentGatewayDriver } from '../types/payment-gateway.types';

describe('payment gateway registry', () => {
  it('registers every driver in the enum', () => {
    // A driver added to the enum but not the registry would pass typecheck at
    // the call sites and fail only at boot, on the deploy that switched to it.
    expect(listPaymentGatewayDrivers().sort()).toEqual(
      Object.values(PaymentGatewayDriver).sort(),
    );
  });

  it('keys each entry to the driver it is filed under', () => {
    // The key doubles as the value stored in payment_requests.gateway, so a
    // mismatch here would silently mislabel rows.
    for (const driver of listPaymentGatewayDrivers()) {
      expect(PAYMENT_GATEWAY_REGISTRY[driver].metadata.key).toBe(driver);
    }
  });

  it('gives every gateway a label and only lists operators when it needs them', () => {
    for (const gateway of listPaymentGatewayMetadata()) {
      expect(gateway.label).not.toBe('');
      expect(gateway.operators.length > 0).toBe(gateway.requiresOperator);
    }
  });

  it('never reuses an operator code across gateways', () => {
    // Codes are the DTO's accepted set; a duplicate would make the runtime
    // gateway check the only thing standing between a code and the wrong API.
    const codes = listPaymentGatewayMetadata().flatMap((g) =>
      g.operators.map((o) => o.code),
    );
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('resolves loosely typed driver values', () => {
    expect(resolvePaymentGatewayDriver('pawapay')).toBe('PAWAPAY');
    expect(resolvePaymentGatewayDriver(' MTN_MOMO ')).toBe('MTN_MOMO');
    expect(resolvePaymentGatewayDriver('stripe')).toBeNull();
    expect(resolvePaymentGatewayDriver(undefined)).toBeNull();
    expect(resolvePaymentGatewayDriver(null)).toBeNull();
  });

  it('looks metadata up by driver, and returns null for a retired one', () => {
    expect(findPaymentGatewayMetadata('PAWAPAY')?.label).toBe('pawaPay');
    // Monetbil was removed: its historical rows have no metadata any more.
    expect(findPaymentGatewayMetadata('MONETBIL')).toBeNull();
    // A row written by a build that shipped a gateway this one does not.
    expect(findPaymentGatewayMetadata('ORANGE_MONEY')).toBeNull();
  });
});
