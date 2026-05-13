import { Module, forwardRef } from '@nestjs/common';
import { QdrantModule } from '../qdrant/qdrant.module';
import { MatchingModule } from '../matching/matching.module';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { InterestSignalService } from './interest-signal.service';
import { InterestClusterService } from './interest-cluster.service';
import { InterestRecommendationService } from './interest-recommendation.service';
import { AdminInterestGraphController } from './admin-interest-graph.controller';

@Module({
  imports: [QdrantModule, MatchingModule, PrismaModule, forwardRef(() => AuthModule)],
  controllers: [AdminInterestGraphController],
  providers: [
    InterestSignalService,
    InterestClusterService,
    InterestRecommendationService,
  ],
  exports: [
    InterestSignalService,
    InterestClusterService,
    InterestRecommendationService,
  ],
})
export class InterestGraphModule {}
