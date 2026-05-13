import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { JobOfferModule } from '../job-offer.module';
import { JobOfferService } from '../job-offer.service';
import { AdminJobOfferController } from '../admin-job-offer.controller';

describe('JobOfferModule', () => {
  it('is defined', () => {
    expect(JobOfferModule).toBeDefined();
  });

  it('provides JobOfferService', () => {
    const providers: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      JobOfferModule,
    );
    expect(providers).toContain(JobOfferService);
  });

  it('registers AdminJobOfferController', () => {
    const controllers: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      JobOfferModule,
    );
    expect(controllers).toContain(AdminJobOfferController);
  });

  it('exports JobOfferService', () => {
    const exports: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      JobOfferModule,
    );
    expect(exports).toContain(JobOfferService);
  });
});
