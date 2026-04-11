import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { QdrantModule } from '../qdrant/qdrant.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { MatchingService } from './matching.service';

@Module({
  imports: [PrismaModule, QdrantModule, SystemConfigModule],
  providers: [MatchingService],
  exports: [MatchingService],
})
export class MatchingModule {}
