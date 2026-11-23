import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import {
  BusinessAnswerFilesController,
  WorkerAnswerFilesController,
} from './answer-files.controller';
import { AnswerFilesService } from './answer-files.service';

/** Files candidates send as answers to an offer's FILE questions. */
@Module({
  // AuthModule for ProfileAuthGuard's JwtService.
  imports: [ConfigModule, forwardRef(() => AuthModule)],
  controllers: [WorkerAnswerFilesController, BusinessAnswerFilesController],
  providers: [AnswerFilesService],
  exports: [AnswerFilesService],
})
export class AnswerFilesModule {}
