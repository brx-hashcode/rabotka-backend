import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString } from 'class-validator';
import type { Response } from 'express';

import { BusinessProfileGuard } from '../../auth/guards/business-profile.guard';
import type { ProfileAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';
import { imageMulterOptions } from '../../../common/utils/image-upload.util';
import { CareersPageService, MAX_BENEFITS } from './careers-page.service';

class BenefitsDto {
  @IsArray()
  @ArrayMaxSize(MAX_BENEFITS)
  @IsString({ each: true })
  benefits!: string[];
}

const IMAGE = FileInterceptor('image', imageMulterOptions(8 * 1024 * 1024));

/** The business's side of its careers page, and an offer's poster. */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class CareersPageController {
  constructor(private readonly pages: CareersPageService) {}

  @Get('careers-page')
  @ApiOperation({ summary: 'Cover, photos and benefits of the careers page' })
  get(@Req() req: ProfileAuthenticatedRequest) {
    return this.pages.page(req.user.profileId);
  }

  @Patch('careers-page')
  @ApiOperation({ summary: 'Set the benefits shown on the careers page' })
  benefits(@Req() req: ProfileAuthenticatedRequest, @Body() dto: BenefitsDto) {
    return this.pages.setBenefits(req.user.profileId, dto.benefits);
  }

  @Post('careers-page/cover')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(IMAGE)
  @ApiOperation({ summary: 'Replace the careers page cover photo' })
  cover(
    @Req() req: ProfileAuthenticatedRequest,
    @UploadedFile() image: Express.Multer.File | undefined,
  ) {
    if (!image) throw new BadRequestException('Ajoutez une photo.');
    return this.pages.setCover(req.user.profileId, image);
  }

  @Delete('careers-page/cover')
  @ApiOperation({ summary: 'Remove the careers page cover photo' })
  removeCover(@Req() req: ProfileAuthenticatedRequest) {
    return this.pages.setCover(req.user.profileId, null);
  }

  @Post('careers-page/photos')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(IMAGE)
  @ApiOperation({ summary: 'Add a photo to the careers page' })
  addPhoto(
    @Req() req: ProfileAuthenticatedRequest,
    @UploadedFile() image: Express.Multer.File | undefined,
  ) {
    if (!image) throw new BadRequestException('Ajoutez une photo.');
    return this.pages.addPhoto(req.user.profileId, image);
  }

  @Delete('careers-page/photos/:index')
  @ApiOperation({ summary: 'Remove one photo of the careers page' })
  removePhoto(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('index', ParseIntPipe) index: number,
  ) {
    return this.pages.removePhoto(req.user.profileId, index);
  }

  @Get('job-offers/:id/poster.pdf')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'A printable A4 poster of an open offer, with a QR code',
  })
  async poster(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.pages.poster(
      req.user.profileId,
      id,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.send(buffer);
  }
}
