import { Module } from '@nestjs/common';
import { AppController } from './presentation/controllers/app.controller';
import { GetHelloUseCase } from './application/use-cases/get-hello.use-case';

@Module({
  controllers: [AppController],
  providers: [GetHelloUseCase],
  exports: [GetHelloUseCase],
})
export class AppFeatureModule {}
