import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { QdrantModule } from '../qdrant/qdrant.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { AuthModule } from '../auth/auth.module';
import { MatchingService } from './matching.service';
import { MatchingController } from './matching.controller';

@Module({
  imports: [PrismaModule, QdrantModule, SystemConfigModule, forwardRef(() => AuthModule)],
  controllers: [MatchingController],
  providers: [MatchingService],
  exports: [MatchingService],
})
export class MatchingModule {}
