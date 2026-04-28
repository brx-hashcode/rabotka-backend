import { Module } from '@nestjs/common';
import { QdrantModule } from '../qdrant/qdrant.module';
import { MatchingModule } from '../matching/matching.module';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { InterestSignalService } from './interest-signal.service';
import { InterestClusterService } from './interest-cluster.service';
import { InterestRecommendationService } from './interest-recommendation.service';

@Module({
  imports: [QdrantModule, MatchingModule, PrismaModule],
  providers: [InterestSignalService, InterestClusterService, InterestRecommendationService],
  exports: [InterestSignalService, InterestClusterService, InterestRecommendationService],
})
export class InterestGraphModule {}
