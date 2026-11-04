import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
  ApiCookieAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import { BusinessProfileGuard } from '../auth/guards/business-profile.guard';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { sendPrivateFile } from '../profile/send-private-file';
import { CvPreferenceDto } from './dto/profile-cv.dto';
import { MAX_PROFILE_CV_BYTES, ProfileCvService } from './profile-cv.service';

/** « Mon CV »: the worker's own CV on their profile. */
@ApiTags('Profile CV')
@ApiCookieAuth()
@ApiBearerAuth()
@Controller('profile/cv')
@UseGuards(ProfileAuthGuard)
export class ProfileCvController {
  constructor(private readonly cvs: ProfileCvService) {}

  @Get()
  @ApiOperation({
    summary: 'My uploaded CV, and which CV my applications carry',
  })
  get(@Req() req: ProfileAuthenticatedRequest) {
    return this.cvs.get(req.user.profileId);
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: 600_000 } })
  @UseInterceptors(
    FileInterceptor('cv', {
      limits: { fileSize: MAX_PROFILE_CV_BYTES, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Add or replace my CV (PDF or Word)' })
  upload(
    @Req() req: ProfileAuthenticatedRequest,
    @UploadedFile() cv: Express.Multer.File | undefined,
  ) {
    return this.cvs.upload(req.user.profileId, cv);
  }

  @Delete()
  @ApiOperation({
    summary: 'Remove my CV: applications go with the Rabotka CV',
  })
  remove(@Req() req: ProfileAuthenticatedRequest) {
    return this.cvs.remove(req.user.profileId);
  }

  @Patch('preference')
  @ApiOperation({ summary: 'Which CV my applications carry by default' })
  preference(
    @Req() req: ProfileAuthenticatedRequest,
    @Body() dto: CvPreferenceDto,
  ) {
    return this.cvs.setPreference(req.user.profileId, dto.preferred);
  }

  @Get('file')
  @ApiOperation({ summary: 'My CV, to read it back' })
  async file(
    @Req() req: ProfileAuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    sendPrivateFile(res, await this.cvs.ownFile(req.user.profileId));
  }
}

/** The CV a worker sent with an application to one of the business's offers. */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me/applications')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class BusinessApplicationCvController {
  constructor(private readonly cvs: ProfileCvService) {}

  @Get(':id/cv')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary:
      "The candidate's own CV, once the contact is unlocked or the application retained",
  })
  async file(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    sendPrivateFile(
      res,
      await this.cvs.fileForEmployer(req.user.profileId, id),
    );
  }
}
