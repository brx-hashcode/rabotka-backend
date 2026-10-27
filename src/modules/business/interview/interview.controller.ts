import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';
import { BusinessProfileGuard } from '../../auth/guards/business-profile.guard';
import type { ProfileAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { Public } from '../../auth/decorators/public.decorator';
import { InterviewService } from './interview.service';
import {
  CreateInterviewDto,
  InterviewAnswerDto,
  InterviewSlotDto,
} from './dto/interview.dto';

/** « Entretiens »: the business's interviews with candidates. */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me/interviews')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class InterviewController {
  constructor(private readonly interviews: InterviewService) {}

  @Get()
  @ApiOperation({
    summary: 'Its interviews: upcoming, past, or one candidate’s',
  })
  list(
    @Req() req: ProfileAuthenticatedRequest,
    @Query('scope') scope?: 'upcoming' | 'past',
    @Query('cvResumeId') cvResumeId?: string,
    @Query('applicationId') applicationId?: string,
  ) {
    return this.interviews.list(req.user.profileId, {
      scope: scope === 'upcoming' || scope === 'past' ? scope : undefined,
      cvResumeId,
      applicationId,
    });
  }

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Propose an interview; the candidate is invited by e-mail (and in-app for an applicant)',
  })
  create(
    @Req() req: ProfileAuthenticatedRequest,
    @Body() dto: CreateInterviewDto,
  ) {
    return this.interviews.create(req.user.profileId, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Move an interview; the candidate is invited again',
  })
  reschedule(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InterviewSlotDto,
  ) {
    return this.interviews.reschedule(req.user.profileId, id, dto);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel an interview; the candidate is told' })
  cancel(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.interviews.cancel(req.user.profileId, id);
  }
}

/** The candidate's side: the invitation behind the private link, and the answer. */
@ApiTags('Public')
@Controller('public/interviews')
export class PublicInterviewController {
  constructor(private readonly interviews: InterviewService) {}

  @Public()
  @Get(':token')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'An interview invitation, by its private link' })
  get(@Param('token') token: string) {
    return this.interviews.byToken(token);
  }

  @Public()
  @Post(':token/answer')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Confirm, decline, or ask for another time' })
  answer(@Param('token') token: string, @Body() dto: InterviewAnswerDto) {
    return this.interviews.respond(token, dto.answer, dto.note);
  }
}
