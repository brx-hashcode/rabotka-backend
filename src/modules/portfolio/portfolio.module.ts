import { Module } from '@nestjs/common';
import { FileModule } from '../file/file.module';
import { MatchingModule } from '../matching/matching.module';
import { AuthModule } from '../auth/auth.module';
import { PortfolioService } from './portfolio.service';
import { PortfolioController } from './portfolio.controller';
import { PublicPortfolioController } from './public-portfolio.controller';

@Module({
  imports: [FileModule, MatchingModule, AuthModule],
  controllers: [PortfolioController, PublicPortfolioController],
  providers: [PortfolioService],
  exports: [PortfolioService],
})
export class PortfolioModule {}
