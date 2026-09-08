import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../../common/services/prisma/prisma.module';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { JobCategoryRegistry } from './job-category.registry';

@Module({
  imports: [ConfigModule, PrismaModule, RetrievalModule],
  providers: [JobCategoryRegistry],
  exports: [JobCategoryRegistry],
})
export class IntentsModule {}
