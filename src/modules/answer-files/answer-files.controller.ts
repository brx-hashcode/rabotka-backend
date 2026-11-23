import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { ActiveProfileGuard } from '../auth/guards/active-profile.guard';
import { BusinessProfileGuard } from '../auth/guards/business-profile.guard';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import { sendPrivateFile } from '../profile/send-private-file';
import {
  AnswerFilesService,
  MAX_ANSWER_FILE_BYTES,
} from './answer-files.service';

/** A worker's file for an offer's FILE question, sent before applying. */
@ApiTags('Mobile — Feed')
@ApiBearerAuth()
@Controller('profile/jobs')
@UseGuards(ProfileAuthGuard)
export class WorkerAnswerFilesController {
  constructor(private readonly files: AnswerFilesService) {}

  @Post(':jobOfferId/answer-files')
  @UseGuards(ActiveProfileGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_ANSWER_FILE_BYTES, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload the file answering one of the offer’s FILE questions',
    description:
      'Multipart `file` (PDF, DOCX, JPG, PNG, WEBP, 10 MB). Returns the `value` to send as that question’s answer when applying; unused, it is deleted after a day.',
  })
  upload(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('jobOfferId', ParseUUIDPipe) jobOfferId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.files.upload(jobOfferId, file, {
      profileId: req.user.profileId,
    });
  }
}

/** The business opens a file a candidate sent with their answers. */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me/answer-files')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class BusinessAnswerFilesController {
  constructor(private readonly files: AnswerFilesService) {}

  @Get(':id')
  @ApiOperation({ summary: 'A file a candidate answered with' })
  async file(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    sendPrivateFile(
      res,
      await this.files.readForEmployer(req.user.profileId, id),
    );
  }
}
