import { Module, forwardRef } from '@nestjs/common';
import { FileModule } from '../file/file.module';
import { MatchingModule } from '../matching/matching.module';
import { AuthModule } from '../auth/auth.module';
import { PortfolioService } from './portfolio.service';
import { PortfolioController } from './portfolio.controller';
import { PublicPortfolioController } from './public-portfolio.controller';

@Module({
  // AuthModule is behind forwardRef: BotModule now imports this module, which
  // puts PortfolioModule inside the Bot ↔ WhatsApp ↔ Auth import cycle, and a
  // direct reference resolves to `undefined` at module-evaluation time.
  imports: [FileModule, MatchingModule, forwardRef(() => AuthModule)],
  controllers: [PortfolioController, PublicPortfolioController],
  providers: [PortfolioService],
  exports: [PortfolioService],
})
export class PortfolioModule {}
