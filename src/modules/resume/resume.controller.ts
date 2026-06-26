import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiCookieAuth,
  ApiBearerAuth,
  ApiResponse,
} from '@nestjs/swagger';
import { ResumeService } from './resume.service';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';

@ApiTags('Resume')
@Controller('profile/resume')
@UseGuards(ProfileAuthGuard)
@ApiCookieAuth()
@ApiBearerAuth()
export class ResumeController {
  constructor(private readonly resumeService: ResumeService) {}

  @Get('download')
  @ApiOperation({
    summary: 'Download the authenticated profile CV (PDF)',
  })
  @ApiResponse({ status: 200, description: 'PDF file stream' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async download(
    @Req() req: ProfileAuthenticatedRequest,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.resumeService.download(
      req.user.profileId,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }
}
