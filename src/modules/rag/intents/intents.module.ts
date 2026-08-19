import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../../common/services/prisma/prisma.module';
import { JobCategoryRegistry } from './job-category.registry';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [JobCategoryRegistry],
  exports: [JobCategoryRegistry],
})
export class IntentsModule {}
