import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ProfileModule } from '../profile.module';
import { ProfileService } from '../profile.service';
import { ProfileController } from '../profile.controller';
import { AdminProfileController } from '../admin-profile.controller';

describe('ProfileModule', () => {
  it('is defined', () => {
    expect(ProfileModule).toBeDefined();
  });

  it('provides ProfileService', () => {
    const providers: unknown[] = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ProfileModule);
    expect(providers).toContain(ProfileService);
  });

  it('registers both controllers', () => {
    const controllers: unknown[] = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ProfileModule);
    expect(controllers).toContain(ProfileController);
    expect(controllers).toContain(AdminProfileController);
  });

  it('exports ProfileService', () => {
    const exports: unknown[] = Reflect.getMetadata(MODULE_METADATA.EXPORTS, ProfileModule);
    expect(exports).toContain(ProfileService);
  });
});
