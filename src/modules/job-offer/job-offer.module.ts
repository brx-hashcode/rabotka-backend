import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { JobOfferService } from './job-offer.service';

@Module({
  imports: [PrismaModule],
  providers: [JobOfferService],
  exports: [JobOfferService],
})
export class JobOfferModule {}
