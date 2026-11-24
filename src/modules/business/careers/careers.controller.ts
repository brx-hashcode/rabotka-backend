import {
  Query,
  Header,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  FileFieldsInterceptor,
  FilesInterceptor,
} from '@nestjs/platform-express';
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
import { KycVerifiedGuard } from '../../auth/guards/kyc-verified.guard';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';
import { CareersService } from './careers.service';
import { MailboxService } from '../mailbox/mailbox.service';
import {
  AnalyseExternalDto,
  ApplyDto,
  DeleteImportedDto,
  ImportCvsDto,
  RefuseExternalDto,
} from './dto/apply.dto';

const MAX_CV_BYTES = 10 * 1024 * 1024;
/** Per request: the site sends a batch in chunks, the plan's own limit is the service's. */
const MAX_IMPORTED_FILES = 20;

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
  @Get('feed.xml')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=900')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Open offers as an XML feed for job aggregators' })
  feed(@Query('for') site?: string) {
    return this.careers.feed(site ?? 'feed');
  }

  // Before `:slug`, which would take it otherwise; « sitemap » is never a slug.
  @Public()
  @Get('sitemap')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Pages search engines may list' })
  sitemap() {
    return this.careers.sitemap();
  }

  // Before `:slug`: « pool » is a reserved slug.
  @Public()
  @Post('pool/withdraw/:token')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: '« Retirer ma candidature de la liste », from the e-mail link',
    description:
      'Ends the consent to be kept for other posts: the business no longer keeps or finds the candidate; the CV goes as the offer closes.',
  })
  withdrawFromPool(@Param('token') token: string) {
    return this.careers.withdrawFromPool(token);
  }

  // Before `:slug` too; « partners » is a reserved slug.
  @Public()
  @Get('partners')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '« Ils recrutent avec Rabotka »: partners staff picked',
  })
  partners() {
    return this.careers.partners();
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
    FileFieldsInterceptor(
      [
        { name: 'cv', maxCount: 1 },
        // « Fichier » answers: an answer `file:<i>` is the i-th of these.
        { name: 'answerFiles', maxCount: 5 },
      ],
      { limits: { fileSize: MAX_CV_BYTES, files: 6 } },
    ),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Apply with a CV, without a Rabotka account' })
  apply(
    @Param('slug') slug: string,
    @Param('reference') reference: string,
    @UploadedFiles()
    files: { cv?: Express.Multer.File[]; answerFiles?: Express.Multer.File[] },
    @Body() dto: ApplyDto,
  ) {
    return this.careers.apply(
      slug,
      reference,
      files?.cv?.[0],
      dto,
      files?.answerFiles ?? [],
    );
  }
}

/** The business's side: who applied from its public page. */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me/external-applications')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class ExternalApplicationsController {
  constructor(
    private readonly careers: CareersService,
    private readonly mailboxes: MailboxService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Applications from the public careers page' })
  list(
    @Req() req: { user: { profileId: string } },
    @Query('offerId', new ParseUUIDPipe({ optional: true })) offerId?: string,
  ) {
    return this.careers.listForBusiness(req.user.profileId, offerId);
  }

  @Get(':id/cv')
  @ApiOperation({ summary: 'The CV, until it is deleted' })
  async cv(
    @Req() req: { user: { profileId: string } },
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    sendPrivateFile(res, await this.careers.cvFile(req.user.profileId, id));
  }

  @Post('analyse')
  // Reaches candidates or uses the plan: only once the organisation is approved.
  @UseGuards(KycVerifiedGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Score these CVs; each uses one of the plan’s « CV inclus »',
  })
  analyse(
    @Req() req: { user: { profileId: string } },
    @Body() dto: AnalyseExternalDto,
  ) {
    return this.careers.analyseRequested(
      req.user.profileId,
      dto.offerId,
      dto.applicationId,
      // Failed before now: the one on screen, without the automatic retry's wait.
      dto.retry ? new Date() : undefined,
    );
  }

  @Post('import')
  // Uses the plan: only once the organisation is approved.
  @UseGuards(KycVerifiedGuard)
  // A large batch arrives in several requests.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseInterceptors(
    FilesInterceptor('files', MAX_IMPORTED_FILES, {
      limits: { fileSize: MAX_CV_BYTES },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Import CVs into an offer: they are read and ranked with its candidates',
    description:
      'Multipart: `offerId`, `files` (PDF, DOCX, JPG, PNG, WEBP) and/or `mailAttachments` (CVs ticked in a connected mailbox). Each uses one of the plan’s « CV inclus »; nobody is e-mailed on import.',
  })
  async import(
    @Req() req: { user: { profileId: string } },
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() dto: ImportCvsDto,
  ) {
    const fromMail = await this.mailboxes.download(
      req.user.profileId,
      dto.mailAttachments ?? [],
    );
    return this.careers.importCvs(req.user.profileId, dto.offerId, [
      ...(files ?? []).map((f) => ({
        ...f,
        source: 'import-device' as const,
      })),
      ...fromMail.map((f) => ({ ...f, source: 'import-gmail' as const })),
    ]);
  }

  @Post('delete')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Delete imported CVs (never an application): the candidate, its analysis and files',
  })
  deleteImported(
    @Req() req: { user: { profileId: string } },
    @Body() dto: DeleteImportedDto,
  ) {
    return this.careers.deleteImported(req.user.profileId, dto.ids);
  }

  @Post(':id/retain')
  @ApiOperation({ summary: 'Retain it; the candidate is told by e-mail' })
  retain(
    @Req() req: { user: { profileId: string } },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.careers.retain(req.user.profileId, id);
  }

  @Post(':id/unretain')
  @ApiOperation({
    summary:
      'Take a retention back: the candidate waits again and is told by e-mail',
  })
  unretain(
    @Req() req: { user: { profileId: string } },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.careers.unretain(req.user.profileId, id);
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
