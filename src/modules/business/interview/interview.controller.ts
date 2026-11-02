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
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';
import { BusinessProfileGuard } from '../../auth/guards/business-profile.guard';
import type { ProfileAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { Public } from '../../auth/decorators/public.decorator';
import { InterviewService } from './interview.service';
import { InterviewCalendarService } from './interview-calendar.service';
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
  constructor(
    private readonly interviews: InterviewService,
    private readonly calendar: InterviewCalendarService,
  ) {}

  @Get('calendar')
  @ApiOperation({
    summary: 'The private link of the interview calendar (made on first ask)',
  })
  calendarLink(@Req() req: ProfileAuthenticatedRequest) {
    return this.calendar.link(req.user.profileId);
  }

  @Post('calendar/reset')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'A new calendar link; the old one stops working' })
  resetCalendarLink(@Req() req: ProfileAuthenticatedRequest) {
    return this.calendar.reset(req.user.profileId);
  }

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

/** The interview calendar a business subscribed to, by its private link. */
@ApiTags('Public')
@Controller('public/calendar')
export class PublicCalendarController {
  constructor(private readonly calendar: InterviewCalendarService) {}

  @Public()
  @Get(':file')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'A business interview calendar (.ics)' })
  async feed(@Param('file') file: string, @Res() res: Response): Promise<void> {
    const ics = await this.calendar.feed(file.replace(/\.ics$/, ''));
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="entretiens.ics"');
    // Agendas poll it; nothing in between should keep an old copy.
    res.setHeader('Cache-Control', 'private, no-cache');
    res.send(ics);
  }
}
