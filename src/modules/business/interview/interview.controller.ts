import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
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
import { InterviewVisioService } from './interview-visio.service';
import { InterviewReportService } from './interview-report.service';
import {
  EditInterviewReportDto,
  InterviewNotesDto,
  SendInterviewReportDto,
} from './dto/interview-report.dto';
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
    private readonly visio: InterviewVisioService,
    private readonly reports: InterviewReportService,
  ) {}

  @Get(':id/report')
  @ApiOperation({
    summary: 'An interview’s « Compte rendu »: notes and report',
  })
  report(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.reports.get(req.user, id);
  }

  @Put(':id/report/notes')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'Save the team’s notes on an interview (autosave)' })
  saveReportNotes(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InterviewNotesDto,
  ) {
    return this.reports.saveNotes(req.user, id, dto.notes);
  }

  @Post(':id/report/write')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Write the report from the notes (AI)' })
  writeReport(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.reports.write(req.user, id);
  }

  @Patch(':id/report')
  @ApiOperation({ summary: 'The team’s changes to the report' })
  editReport(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditInterviewReportDto,
  ) {
    return this.reports.edit(req.user, id, dto.report);
  }

  @Post(':id/report/send')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'E-mail the report to the team' })
  sendReport(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendInterviewReportDto,
  ) {
    return this.reports.send(req.user, id, dto.memberIds);
  }

  @Get('visio/:room')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Join an interview video call, as its host' })
  joinVisio(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('room') room: string,
  ) {
    return this.visio.asHost(req.user.profileId, req.user.memberId, room);
  }

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
    @Query('externalApplicationId') externalApplicationId?: string,
  ) {
    return this.interviews.list(req.user.profileId, {
      scope: scope === 'upcoming' || scope === 'past' ? scope : undefined,
      cvResumeId,
      applicationId,
      externalApplicationId,
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
  constructor(
    private readonly interviews: InterviewService,
    private readonly visio: InterviewVisioService,
  ) {}

  @Public()
  @Get('visio/:room')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Join an interview video call, by its link' })
  joinVisio(@Param('room') room: string) {
    return this.visio.asGuest(room);
  }

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
    return this.interviews.respond(token, dto.answer, dto.note, dto.slotId);
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
