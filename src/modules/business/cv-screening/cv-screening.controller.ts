import {
  Body,
  Controller,
  InternalServerErrorException,
  Logger,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';
import { BusinessProfileGuard } from '../../auth/guards/business-profile.guard';
import type { ProfileAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { htmlToPdf } from '../../../common/utils/puppeteer';
import { sendPrivateFile } from '../../profile/send-private-file';
import {
  buildChatReportFilename,
  buildChatReportHtml,
  type ChatReportInput,
} from './cv-chat-report';
import { CvScreeningService } from './cv-screening.service';
import { CvChatService, OffTopicError } from './cv-chat.service';
import {
  CvCompareService,
  MAX_COMPARED,
  MIN_COMPARED,
} from './cv-compare.service';
import {
  CreateCvScreeningDto,
  CvChatQuestionDto,
  CvCompareDto,
} from './dto/create-cv-screening.dto';

/**
 * Hard ceilings above any plan: the plan's own limits (CVs per upload, file
 * size) are checked by the service, these only stop an oversized request
 * before it is read into memory.
 */
const MAX_FILES = 100;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** « Analyse de CV »: the business's AI screenings. */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me/cv-screenings')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class CvScreeningController {
  private readonly logger = new Logger(CvScreeningController.name);

  constructor(
    private readonly screenings: CvScreeningService,
    private readonly chat: CvChatService,
    private readonly compare: CvCompareService,
  ) {}

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(
    FilesInterceptor('files', MAX_FILES, {
      limits: { fileSize: MAX_FILE_BYTES },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload CVs for one job; the AI reads and ranks them',
    description:
      'Multipart: `files` (PDF, DOCX, JPG, PNG, WEBP), plus `offerId` or `jobTitle` and `jobText`. Takes the CVs from the plan’s « CV inclus » at once; the ones that cannot be read are given back.',
  })
  create(
    @Req() req: ProfileAuthenticatedRequest,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() dto: CreateCvScreeningDto,
  ) {
    return this.screenings.create(req.user.profileId, files ?? [], dto);
  }

  @Get()
  @ApiOperation({ summary: 'Its screenings, newest first' })
  list(
    @Req() req: ProfileAuthenticatedRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.screenings.list(
      req.user.profileId,
      Math.max(0, Number.parseInt(page ?? '0', 10) || 0),
      Math.min(50, Math.max(1, Number.parseInt(limit ?? '20', 10) || 20)),
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'One screening, its CVs best first' })
  get(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.screenings.get(req.user.profileId, id);
  }

  @Get(':id/resumes/:resumeId/file')
  @ApiOperation({ summary: 'One CV’s file, until the retention purge' })
  async file(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('resumeId', ParseUUIDPipe) resumeId: string,
    @Res() res: Response,
  ): Promise<void> {
    sendPrivateFile(
      res,
      await this.screenings.file(req.user.profileId, id, resumeId),
    );
  }

  @Get(':id/resumes/:resumeId/chat')
  @ApiOperation({
    summary: 'The conversation about one CV, and the questions left',
  })
  chatHistory(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('resumeId', ParseUUIDPipe) resumeId: string,
  ) {
    return this.chat.history(req.user.profileId, id, resumeId);
  }

  @Get(':id/resumes/:resumeId/chat.pdf')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'The conversation about one CV, as a PDF (no contact details)',
  })
  async chatPdf(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('resumeId', ParseUUIDPipe) resumeId: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.sendReport(
      res,
      await this.chat.report(req.user.profileId, id, resumeId),
    );
  }

  @Post(':id/resumes/:resumeId/chat')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Ask about one CV; the answer streams back',
    description:
      'Server-sent events: `delta` ({ text }) as the answer is written, then `done` ({ remaining }) or `error` ({ message }). Refusals (no plan, questions used up, CV purged) are plain HTTP errors before the stream starts.',
  })
  async ask(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('resumeId', ParseUUIDPipe) resumeId: string,
    @Body() dto: CvChatQuestionDto,
    @Res() res: Response,
  ): Promise<void> {
    const turn = await this.chat.prepare(
      req.user.profileId,
      id,
      resumeId,
      dto.question,
    );
    await streamAnswer(
      res,
      (signal) => this.chat.answer(turn, signal),
      turn.remaining,
    );
  }

  @Post(':id/comparisons')
  @ApiOperation({
    summary: 'Open (or reopen) the conversation comparing some of its CVs',
    description: `${MIN_COMPARED} to ${MAX_COMPARED} scored CVs; the same selection reopens the same conversation.`,
  })
  openComparison(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CvCompareDto,
  ) {
    return this.compare.open(req.user.profileId, id, dto.resumeIds);
  }

  @Get(':id/comparisons/:comparisonId/chat.pdf')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'The comparison’s conversation, as a PDF (no contact details)',
  })
  async comparisonPdf(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('comparisonId', ParseUUIDPipe) comparisonId: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.sendReport(
      res,
      await this.compare.report(req.user.profileId, id, comparisonId),
    );
  }

  @Post(':id/comparisons/:comparisonId/chat')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Ask about the compared CVs; the answer streams back',
    description: 'Same events as the one-CV chat: `delta`, `done`, `error`.',
  })
  async askComparison(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('comparisonId', ParseUUIDPipe) comparisonId: string,
    @Body() dto: CvChatQuestionDto,
    @Res() res: Response,
  ): Promise<void> {
    const turn = await this.compare.prepare(
      req.user.profileId,
      id,
      comparisonId,
      dto.question,
    );
    await streamAnswer(
      res,
      (signal) => this.compare.answer(turn, signal),
      turn.remaining,
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a screening and its files' })
  async remove(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.screenings.remove(req.user.profileId, id);
  }

  private async sendReport(res: Response, input: ChatReportInput) {
    let pdf: Buffer;
    try {
      pdf = await htmlToPdf(buildChatReportHtml(input), 'Analyse de CV');
    } catch (err) {
      // The business sees only the generic message: keep the real cause.
      this.logger.error(
        'CV chat PDF generation failed',
        err instanceof Error ? err.stack : String(err),
      );
      throw new InternalServerErrorException(
        'Le PDF n’a pas pu être créé. Réessayez dans un instant.',
      );
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${buildChatReportFilename(input)}"`,
    );
    res.send(pdf);
  }
}

/**
 * An answer as server-sent events: `delta` as it is written, then `done`
 * (questions left) or `error`. The reader leaving stops the model.
 */
async function streamAnswer(
  res: Response,
  answer: (signal: AbortSignal) => AsyncGenerator<string>,
  remaining: number,
): Promise<void> {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  // No proxy on the way may hold the answer back to compress or buffer it.
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const reader = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) reader.abort();
  });
  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    for await (const text of answer(reader.signal)) send('delta', { text });
    if (!reader.signal.aborted) send('done', { remaining });
  } catch (err) {
    send('error', {
      message:
        err instanceof OffTopicError
          ? err.message
          : 'La réponse n’a pas pu être rédigée. Réessayez dans un instant : cette question n’est pas décomptée.',
    });
  }
  res.end();
}
