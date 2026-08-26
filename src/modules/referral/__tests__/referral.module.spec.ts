import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ReferralModule } from '../referral.module';
import { ReferralService } from '../referral.service';
import { ReferralController } from '../referral.controller';
import { AdminReferralController } from '../admin-referral.controller';

describe('ReferralModule', () => {
  it('is defined', () => {
    expect(ReferralModule).toBeDefined();
  });

  it('provides ReferralService', () => {
    const providers: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      ReferralModule,
    );
    expect(providers).toContain(ReferralService);
  });

  it('registers the user and admin controllers', () => {
    const controllers: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      ReferralModule,
    );
    expect(controllers).toContain(ReferralController);
    expect(controllers).toContain(AdminReferralController);
  });

  it('exports ReferralService', () => {
    // ProfileModule and PaymentRequestModule both inject it; an unexported
    // provider fails at runtime, not at compile time.
    const exports: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      ReferralModule,
    );
    expect(exports).toContain(ReferralService);
  });
});
