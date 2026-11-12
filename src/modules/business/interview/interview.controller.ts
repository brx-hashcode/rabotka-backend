import {
  Body,
  Controller,
  Delete,
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
import { InterviewGuestService } from './interview-guest.service';
import { InterviewTranscriptService } from './interview-transcript.service';
import { InterviewReportService } from './interview-report.service';
import {
  EditInterviewReportDto,
  InterviewNotesDto,
  SendInterviewReportDto,
} from './dto/interview-report.dto';
import {
  CreateInterviewDto,
  InterviewAnswerDto,
  InterviewGuestDto,
  InterviewSlotDto,
  TranscriptionAnswerDto,
  TranscriptionSwitchDto,
  TranscriptLinesDto,
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
    private readonly guests: InterviewGuestService,
    private readonly transcripts: InterviewTranscriptService,
  ) {}

  @Get(':id/report/transcript')
  @ApiOperation({
    summary: 'The interview’s transcription: both sides merged by time',
  })
  transcript(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.transcripts.get(req.user, id);
  }

  @Patch(':id/report/transcription')
  @ApiOperation({ summary: '« Transcrire l’entretien »: on or off' })
  setTranscription(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TranscriptionSwitchDto,
  ) {
    return this.transcripts.setTranscribe(req.user, id, dto.on);
  }

  @Post(':id/report/transcript')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'The organiser’s sentences, as their browser recognised them',
  })
  addTranscript(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TranscriptLinesDto,
  ) {
    return this.transcripts.addHostLines(req.user, id, dto.lines);
  }

  @Get(':id/guests')
  @ApiOperation({ summary: 'Who was invited into the interview’s visio' })
  listGuests(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.guests.list(req.user.profileId, id);
  }

  @Post(':id/guests')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Invite someone into the visio: a personal link by e-mail, no account',
  })
  inviteGuest(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InterviewGuestDto,
  ) {
    return this.guests.invite(req.user.profileId, req.user.memberId, id, dto);
  }

  @Delete(':id/guests/:guestId')
  @ApiOperation({ summary: 'Withdraw an invitation: its link stops working' })
  removeGuest(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('guestId', ParseUUIDPipe) guestId: string,
  ) {
    return this.guests.remove(req.user.profileId, id, guestId);
  }

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

  @Get(':id/report.pdf')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'The « Compte rendu » as a PDF' })
  async reportPdf(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.reports.pdf(req.user, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buffer);
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

  @Post(':id/end')
  @ApiOperation({
    summary: '« Terminer l’entretien »: its link stops opening the call',
  })
  end(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.interviews.end(req.user.profileId, id);
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
    private readonly transcripts: InterviewTranscriptService,
  ) {}

  @Public()
  @Get('visio/:room/transcription')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Whether the call is transcribed' })
  transcription(@Param('room') room: string) {
    return this.transcripts.status(room);
  }

  @Public()
  @Post('visio/:room/transcription')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'The candidate accepts or refuses the transcription',
  })
  answerTranscription(
    @Param('room') room: string,
    @Body() dto: TranscriptionAnswerDto,
    @Query('g') guestToken?: string,
  ) {
    return this.transcripts.answer(
      room,
      dto.accepted,
      guestToken?.slice(0, 100) || undefined,
    );
  }

  @Public()
  @Post('visio/:room/transcript')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'A guest’s sentences, as their own browser recognised them',
  })
  addTranscript(
    @Param('room') room: string,
    @Body() dto: TranscriptLinesDto,
    @Query('g') guestToken?: string,
  ) {
    return this.transcripts.addGuestLines(
      room,
      dto.lines,
      guestToken?.slice(0, 100) || undefined,
    );
  }

  @Public()
  @Get('visio/:room')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Join an interview video call, by its link' })
  joinVisio(@Param('room') room: string, @Query('g') guestToken?: string) {
    return this.visio.asGuest(room, guestToken?.slice(0, 100) || undefined);
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
