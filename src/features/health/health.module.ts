import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './presentation/controllers/health.controller';
import { CheckHealthUseCase } from './application/use-cases/check-health.use-case';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [CheckHealthUseCase],
  exports: [CheckHealthUseCase],
})
export class HealthModule {}
