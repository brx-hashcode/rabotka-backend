import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { LogModule } from '../log/log.module';
import { JobCategoryService } from './job-category.service';
import {
  JobCategoryController,
  AdminJobCategoryController,
} from './job-category.controller';

@Module({
  imports: [PrismaModule, AuthModule, LogModule],
  controllers: [JobCategoryController, AdminJobCategoryController],
  providers: [JobCategoryService],
  exports: [JobCategoryService],
})
export class JobCategoryModule {}
