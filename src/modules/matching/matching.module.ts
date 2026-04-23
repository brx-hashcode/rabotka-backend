import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { QdrantModule } from '../qdrant/qdrant.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { AuthModule } from '../auth/auth.module';
import { MatchingService } from './matching.service';
import { MatchingController } from './matching.controller';
import { VectorIndexProcessor } from './vector-index.processor';

@Module({
  imports: [PrismaModule, QdrantModule, SystemConfigModule, forwardRef(() => AuthModule)],
  controllers: [MatchingController],
  providers: [MatchingService, VectorIndexProcessor],
  exports: [MatchingService, VectorIndexProcessor],
})
export class MatchingModule {}
