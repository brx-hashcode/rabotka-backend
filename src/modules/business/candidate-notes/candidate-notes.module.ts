import { Module } from '@nestjs/common';

import { AuthModule } from '../../auth/auth.module';
import { TeamModule } from '../team/team.module';
import { CandidateNotesController } from './candidate-notes.controller';
import { CandidateNotesService } from './candidate-notes.service';

/** The team's notes, opinions and timeline on a candidate. */
@Module({
  // AuthModule for ProfileAuthGuard's JwtService.
  imports: [AuthModule, TeamModule],
  controllers: [CandidateNotesController],
  providers: [CandidateNotesService],
})
export class CandidateNotesModule {}
