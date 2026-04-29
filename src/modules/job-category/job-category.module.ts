import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { JobCategoryService } from './job-category.service';
import {
  JobCategoryController,
  AdminJobCategoryController,
} from './job-category.controller';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [JobCategoryController, AdminJobCategoryController],
  providers: [JobCategoryService],
  exports: [JobCategoryService],
})
export class JobCategoryModule {}
