import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { JobPagesController } from './job-pages.controller';
import { JobPagesService } from './job-pages.service';

/** Public job pages (`/emplois` on the candidate site): offers, listings, sitemap. */
@Module({
  imports: [PrismaModule],
  controllers: [JobPagesController],
  providers: [JobPagesService],
  exports: [JobPagesService],
})
export class JobPagesModule {}
