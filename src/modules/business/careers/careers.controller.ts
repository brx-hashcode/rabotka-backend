import {
  Body,
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
import { sendPrivateFile } from '../../profile/send-private-file';
import { Public } from '../../auth/decorators/public.decorator';
import { BusinessProfileGuard } from '../../auth/guards/business-profile.guard';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';
import { CareersService } from './careers.service';
import {
  AnalyseExternalDto,
  ApplyDto,
  RefuseExternalDto,
} from './dto/apply.dto';

const MAX_CV_BYTES = 10 * 1024 * 1024;

/** The public careers page of a business: no session, no contact details. */
@ApiTags('Public')
@Controller('public/careers')
export class CareersController {
  constructor(private readonly careers: CareersService) {}

  @Public()
  @Get()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Verified businesses with open offers' })
  companies() {
    return this.careers.companies();
  }

  @Public()
  @Get(':slug')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'A business and its open offers' })
  company(@Param('slug') slug: string) {
    return this.careers.company(slug);
  }

  @Public()
  @Get(':slug/offers/:reference')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'One open offer, with the questions it asks' })
  offer(@Param('slug') slug: string, @Param('reference') reference: string) {
    return this.careers.offer(slug, reference);
  }

  @Public()
  @Post(':slug/offers/:reference/apply')
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @UseInterceptors(
    FileInterceptor('cv', { limits: { fileSize: MAX_CV_BYTES, files: 1 } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Apply with a CV, without a Rabotka account' })
  apply(
    @Param('slug') slug: string,
    @Param('reference') reference: string,
    @UploadedFile() cv: Express.Multer.File | undefined,
    @Body() dto: ApplyDto,
  ) {
    return this.careers.apply(slug, reference, cv, dto);
  }
}

/** The business's side: who applied from its public page. */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me/external-applications')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class ExternalApplicationsController {
  constructor(private readonly careers: CareersService) {}

  @Get()
  @ApiOperation({ summary: 'Applications from the public careers page' })
  list(@Req() req: { user: { profileId: string } }) {
    return this.careers.listForBusiness(req.user.profileId);
  }

  @Get(':id/cv')
  @ApiOperation({ summary: 'The CV, until the retention purge' })
  async cv(
    @Req() req: { user: { profileId: string } },
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    sendPrivateFile(res, await this.careers.cvFile(req.user.profileId, id));
  }

  @Post('analyse')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Score these CVs; each uses one of the plan’s « CV inclus »',
  })
  analyse(
    @Req() req: { user: { profileId: string } },
    @Body() dto: AnalyseExternalDto,
  ) {
    return this.careers.analyse(
      req.user.profileId,
      dto.offerId,
      dto.applicationId,
    );
  }

  @Post(':id/retain')
  @ApiOperation({ summary: 'Retain it; the candidate is told by e-mail' })
  retain(
    @Req() req: { user: { profileId: string } },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.careers.retain(req.user.profileId, id);
  }

  @Post(':id/refuse')
  @ApiOperation({ summary: 'Refuse it; the candidate is told by e-mail' })
  refuse(
    @Req() req: { user: { profileId: string } },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RefuseExternalDto,
  ) {
    return this.careers.refuse(req.user.profileId, id, dto.message);
  }
}
