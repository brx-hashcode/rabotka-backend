import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { ShortlistController } from './shortlist.controller';
import { ShortlistService } from './shortlist.service';

/** « Présélectionnée »: the business's own step before deciding. */
@Module({
  // AuthModule for ProfileAuthGuard's JwtService.
  imports: [AuthModule],
  controllers: [ShortlistController],
  providers: [ShortlistService],
})
export class ShortlistModule {}
