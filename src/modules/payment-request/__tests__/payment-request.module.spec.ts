import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { PaymentRequestModule } from '../payment-request.module';
import { PaymentRequestService } from '../payment-request.service';
import { PaymentRequestController } from '../payment-request.controller';
import { PaymentRequestPublicController } from '../payment-request-public.controller';

describe('PaymentRequestModule', () => {
  it('is defined', () => {
    expect(PaymentRequestModule).toBeDefined();
  });

  it('provides PaymentRequestService', () => {
    const providers: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      PaymentRequestModule,
    );
    expect(providers).toContain(PaymentRequestService);
  });

  it('registers both controllers', () => {
    const controllers: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      PaymentRequestModule,
    );
    expect(controllers).toContain(PaymentRequestController);
    expect(controllers).toContain(PaymentRequestPublicController);
  });

  it('exports PaymentRequestService', () => {
    const exports: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      PaymentRequestModule,
    );
    expect(exports).toContain(PaymentRequestService);
  });
});
