import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { UserModule } from '../user.module';
import { UserService } from '../user.service';
import { UserController } from '../user.controller';

describe('UserModule', () => {
  it('is defined', () => {
    expect(UserModule).toBeDefined();
  });

  it('provides UserService', () => {
    const providers: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      UserModule,
    );
    expect(providers).toContain(UserService);
  });

  it('registers UserController', () => {
    const controllers: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      UserModule,
    );
    expect(controllers).toContain(UserController);
  });

  it('exports UserService', () => {
    const exports: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      UserModule,
    );
    expect(exports).toContain(UserService);
  });
});
