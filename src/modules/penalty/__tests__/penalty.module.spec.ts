import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { PenaltyModule } from '../penalty.module';
import { PenaltyService } from '../penalty.service';
import { AdminPenaltyController } from '../admin-penalty.controller';

describe('PenaltyModule', () => {
  it('is defined', () => {
    expect(PenaltyModule).toBeDefined();
  });

  it('provides PenaltyService', () => {
    const providers: unknown[] = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, PenaltyModule);
    expect(providers).toContain(PenaltyService);
  });

  it('registers AdminPenaltyController', () => {
    const controllers: unknown[] = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, PenaltyModule);
    expect(controllers).toContain(AdminPenaltyController);
  });

  it('exports PenaltyService', () => {
    const exports: unknown[] = Reflect.getMetadata(MODULE_METADATA.EXPORTS, PenaltyModule);
    expect(exports).toContain(PenaltyService);
  });
});
