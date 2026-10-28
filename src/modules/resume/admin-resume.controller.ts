import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiCookieAuth,
  ApiBearerAuth,
  ApiResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ResumeService } from './resume.service';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

/**
 * A candidate's CV as they download it themselves, for the admin profile page.
 * Inline so it opens in the browser's viewer; `no-store` because it carries
 * the candidate's phone and e-mail.
 */
@ApiTags('Admin – Profiles')
@Controller('admin/profiles')
@UseGuards(AdminAuthGuard, RolesGuard)
@ApiBearerAuth()
@ApiCookieAuth()
export class AdminResumeController {
  constructor(private readonly resumeService: ResumeService) {}

  @Get(':id/resume')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: "A profile's CV as a PDF (admin only)" })
  @ApiResponse({ status: 200, description: 'PDF file stream' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async view(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.resumeService.download(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buffer);
  }
}
