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
import { UserRole } from '@prisma/client';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
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

/**
 * The CV on a candidate's profile, from the business's candidate sheet: not
 * tied to an application, so it is the one they would send today.
 */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me/candidates')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class BusinessCandidateCvController {
  constructor(private readonly cvs: ProfileCvService) {}

  @Get(':workerId/cv')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Whether the candidate added a CV, and whether it opens for this business (null when none)',
  })
  async info(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('workerId', ParseUUIDPipe) workerId: string,
  ) {
    return { cv: await this.cvs.forCandidate(req.user.profileId, workerId) };
  }

  @Get(':workerId/cv/file')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary:
      "The candidate's CV, once the contact is obtained or an application retained",
  })
  async file(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('workerId', ParseUUIDPipe) workerId: string,
    @Res() res: Response,
  ): Promise<void> {
    sendPrivateFile(
      res,
      await this.cvs.candidateFile(req.user.profileId, workerId),
    );
  }
}

/** The CV a worker uploaded (« Mon CV »), for the admin profile page. */
@ApiTags('Admin – Profiles')
@Controller('admin/profiles')
@UseGuards(AdminAuthGuard, RolesGuard)
@ApiBearerAuth()
@ApiCookieAuth()
export class AdminProfileCvController {
  constructor(private readonly cvs: ProfileCvService) {}

  @Get(':id/cv')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: "The worker's uploaded CV, if any (null when none)",
  })
  async info(@Param('id', ParseUUIDPipe) id: string) {
    return { cv: await this.cvs.forAdmin(id) };
  }

  @Get(':id/cv/file')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: "The worker's uploaded CV file (admin only)" })
  async file(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    sendPrivateFile(res, await this.cvs.adminFile(id));
  }
}
