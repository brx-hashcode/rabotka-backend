import {
  Body,
  Controller,
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
import { sendPrivateFile } from '../../profile/send-private-file';
import { CvScreeningService } from './cv-screening.service';
import { CreateCvScreeningDto } from './dto/create-cv-screening.dto';

/**
 * Hard ceilings above any plan: the plan's own limits (CVs per upload, file
 * size) are checked by the service, these only stop an oversized request
 * before it is read into memory.
 */
const MAX_FILES = 100;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** « Tri des CV »: the business's AI screenings. */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me/cv-screenings')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class CvScreeningController {
  constructor(private readonly screenings: CvScreeningService) {}

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

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a screening and its files' })
  async remove(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.screenings.remove(req.user.profileId, id);
  }
}
