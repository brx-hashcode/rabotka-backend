import {
  BadRequestException,
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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ALLOWED_IMAGE_MIME_TYPES } from '../../common/constants/image-upload';
import { sniffFileType } from '../../common/utils/file-signature.util';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import { BusinessProfileGuard } from '../auth/guards/business-profile.guard';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { ProfileService } from '../profile/profile.service';
import { sendPrivateFile } from '../profile/send-private-file';
import { UpdateBusinessDto } from './dto/update-business.dto';
import { UploadBusinessDocumentDto } from './dto/upload-business-document.dto';
import { BusinessCheckoutService } from './subscription/business-checkout.service';
import { BusinessSubscriptionService } from './subscription/business-subscription.service';
import { SubscribeDto } from './subscription/dto/business-plan.dto';
import { planView } from './subscription/plan-view';
import { BusinessStatsService } from './business-stats.service';
import { BusinessContactsService } from './business-contacts.service';
import { BusinessTalentService } from './business-talent.service';
import { InviteTalentDto, SaveTalentDto } from './dto/business-talent.dto';
import { STATS_PERIODS } from './business-stats';

/**
 * The business dashboard's own routes. Guarded at class level, so no route
 * can be added here without them: a signed-in profile, and a business one.
 */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class BusinessController {
  constructor(
    private readonly profileService: ProfileService,
    private readonly subscriptions: BusinessSubscriptionService,
    private readonly checkout: BusinessCheckoutService,
    private readonly statsService: BusinessStatsService,
    private readonly contacts: BusinessContactsService,
    private readonly talents: BusinessTalentService,
  ) {}

  @Get('plans')
  @ApiOperation({ summary: 'The plans a business can choose' })
  async plans() {
    return (await this.subscriptions.listPlans(true)).map(planView);
  }

  @Get('me/subscription')
  @ApiOperation({
    summary: 'Current plan, usage, queued periods and history',
  })
  async mySubscription(@Req() req: ProfileAuthenticatedRequest) {
    const businessId = await this.subscriptions.businessOf(req.user.profileId);
    const overview = await this.subscriptions.overview(businessId!);
    return { ...overview, plans: overview.plans.map(planView) };
  }

  @Post('me/subscription')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Buy a period of a plan: returns the token of its payment page',
    description:
      'The period starts when the payment succeeds — after the running one, if any (renewing early loses nothing); a running trial is replaced at once.',
  })
  async subscribe(
    @Req() req: ProfileAuthenticatedRequest,
    @Body() dto: SubscribeDto,
  ) {
    return this.checkout.checkout(
      req.user.profileId,
      dto.planId,
      dto.billingPeriod,
    );
  }

  @Get('me/stats')
  @ApiOperation({
    summary: 'Recruitment figures for the dashboard',
    description:
      'Applications, hires, funnel, delays and outcome over the last `days` (7, 30 or 90; default 30), each with the previous period of the same length.',
  })
  stats(@Req() req: ProfileAuthenticatedRequest, @Query('days') days?: string) {
    const period = STATS_PERIODS.find((d) => String(d) === days) ?? 30;
    return this.statsService.stats(req.user.profileId, period);
  }

  @Get('me/contacts')
  @ApiOperation({
    summary: 'The workers whose contact it unlocked, with their details',
    description:
      'A business gets no WhatsApp: this is where the unlocked name, phone and email are read. One row per worker, latest unlock first.',
  })
  myContacts(@Req() req: ProfileAuthenticatedRequest) {
    return this.contacts.list(req.user.profileId);
  }

  @Post('me/contacts/:workerId')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Reveal a worker from the search, on the plan quota',
    description:
      'No fee and no WhatsApp: the details come back in the response. Free for a worker already unlocked; 403 once the quota is used up.',
  })
  unlockContact(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('workerId', ParseUUIDPipe) workerId: string,
  ) {
    return this.contacts.unlock(req.user.profileId, workerId);
  }

  @Get('me/talents')
  @ApiOperation({
    summary: 'The talent pool: workers kept, then workers already hired',
  })
  myTalents(@Req() req: ProfileAuthenticatedRequest) {
    return this.talents.list(req.user.profileId);
  }

  @Put('me/talents/:workerId')
  @ApiOperation({ summary: 'Keep a worker, or edit the note and tags' })
  saveTalent(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('workerId', ParseUUIDPipe) workerId: string,
    @Body() dto: SaveTalentDto,
  ) {
    return this.talents.save(req.user.profileId, workerId, dto);
  }

  @Delete('me/talents/:workerId')
  @ApiOperation({ summary: 'Stop keeping a worker' })
  removeTalent(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('workerId', ParseUUIDPipe) workerId: string,
  ) {
    return this.talents.remove(req.user.profileId, workerId);
  }

  @Post('me/talents/:workerId/invite')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Invite a worker to apply to one of its open offers',
    description:
      'In-app notification to the worker, once per worker and offer. 409 if they already applied.',
  })
  inviteTalent(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('workerId', ParseUUIDPipe) workerId: string,
    @Body() dto: InviteTalentDto,
  ) {
    return this.talents.invite(req.user.profileId, workerId, dto.offerId);
  }

  @Get('me')
  @ApiOperation({
    summary: 'The signed-in business: its organisation, papers and review',
  })
  @ApiResponse({ status: 403, description: 'Not a business account' })
  getMe(@Req() req: ProfileAuthenticatedRequest) {
    return this.profileService.getBusinessForAdmin(req.user.profileId);
  }

  @Patch('me')
  @ApiOperation({
    summary: 'Edit the organisation',
    description:
      'Changing name, type, legal form, RCCM, NIU or SCIEN sends a refused business back to review, and is refused (403) once it is verified — the team changes it on request; contact details stay editable.',
  })
  async updateMe(
    @Req() req: ProfileAuthenticatedRequest,
    @Body() dto: UpdateBusinessDto,
  ) {
    return this.profileService.updateBusiness(req.user.profileId, dto, 'owner');
  }

  @Post('me/documents')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const allowed: string[] = [
          ...ALLOWED_IMAGE_MIME_TYPES,
          'application/pdf',
        ];
        cb(null, allowed.includes(file.mimetype));
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'documentType'],
      properties: {
        file: { type: 'string', format: 'binary' },
        documentType: { type: 'string' },
        replacesId: { type: 'string', format: 'uuid' },
      },
    },
  })
  @ApiOperation({
    summary: 'Send a paper: a new one, or the replacement of a refused one',
    description:
      'The replaced version is kept as history. A refused business goes back to review.',
  })
  async uploadDocument(
    @Req() req: ProfileAuthenticatedRequest,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadBusinessDocumentDto,
  ) {
    if (!file) {
      throw new BadRequestException(
        'Envoyez une photo (JPG, PNG, WEBP) ou un PDF de 10 Mo au plus.',
      );
    }
    // The declared type is a header anyone can set: the bytes must agree.
    if (sniffFileType(file.buffer) !== file.mimetype) {
      throw new BadRequestException(
        'Fichier non reconnu : envoyez une photo (JPG, PNG, WEBP) ou un PDF.',
      );
    }
    return this.profileService.uploadBusinessDocument(
      req.user.profileId,
      file,
      dto.documentType,
      dto.replacesId,
    );
  }

  @Get('me/documents/:documentId/raw')
  @ApiOperation({ summary: 'One of its own papers, any version' })
  async streamDocument(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Res() res: Response,
  ): Promise<void> {
    sendPrivateFile(
      res,
      await this.profileService.streamBusinessDocument(
        req.user.profileId,
        documentId,
      ),
    );
  }
}
