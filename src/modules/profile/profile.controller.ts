import {
  Controller,
  Post,
  Get,
  Patch,
  UseInterceptors,
  UseGuards,
  UploadedFile,
  Body,
  Req,
  Res,
  Query,
  BadRequestException,
  Param,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiConsumes,
  ApiBody,
  ApiResponse,
  ApiBearerAuth,
  ApiCookieAuth,
} from '@nestjs/swagger';
import {
  ProfileService,
  ProfileMeResponse,
  ProfilePenaltyItem,
  ProfileApplicationsResponse,
} from './profile.service';
import { CreateProfileDto } from './dto/create-profile.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { sendWelcomeEmail, WELCOME_EMAIL_PREVIEW } from '../mail/templates';
import { setAuthCookie } from '../auth/auth-cookie.util';
import { MailService } from '../mail/mail.service';
import { LayoutService } from '../mail/layout.service';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import { ContactedProfilesService } from '../recommendation/contacted-profiles.service';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { WalletService } from '../wallet/wallet.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { ProfileType } from '@prisma/client';
import { WHATSAPP_TEMPLATES } from '../../common/constants/whatsapp-templates';
import { PayPenaltyDto } from '../wallet/dto/pay-penalty.dto';

@ApiTags('Profile')
@Controller('profile')
export class ProfileController {
  private readonly logger = new Logger(ProfileController.name);

  constructor(
    private readonly profileService: ProfileService,
    private readonly mailService: MailService,
    private readonly layoutService: LayoutService,
    private readonly walletService: WalletService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly whatsApp: WhatsAppService,
    private readonly contactedProfiles: ContactedProfilesService,
  ) {}

  @Get('contacts')
  @UseGuards(ProfileAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Profiles this employer has paid to contact',
    description:
      'Every worker the employer unlocked, through a recommendation or a ' +
      'mission, with the phone and email they paid for. Employers only.',
  })
  @ApiResponse({ status: 200, description: 'Contacted profiles returned' })
  @ApiResponse({ status: 403, description: 'Not an employer' })
  listContacts(@Req() req: ProfileAuthenticatedRequest) {
    return this.contactedProfiles.listContacts(req.user.profileId);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a new profile with pre-uploaded KYC documents',
    description:
      'Creates a new profile with personal information and KYC document descriptors. The KYC files must already be uploaded via POST /profile/kyc-upload; only their descriptors (url + storage metadata) are sent here as JSON.',
  })
  @ApiConsumes('application/json')
  @ApiBody({ type: CreateProfileDto })
  @ApiResponse({
    status: 201,
    description: 'Profile created successfully',
    schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          example: 'Profile created successfully',
        },
        creditedBalance: {
          type: 'number',
          example: 1000,
          description:
            'Welcome credit amount granted to the new profile in FCFA',
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - validation error',
  })
  @ApiResponse({
    status: 409,
    description: 'Conflict - email or phone already exists',
  })
  async createProfile(
    @Body() createProfileDto: CreateProfileDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.profileService.createProfile(createProfileDto);

    await this.mailService.sendMail({
      to: createProfileDto.email,
      subject: 'Bienvenue sur Rabotka',
      html: await this.layoutService.wrap(
        sendWelcomeEmail(createProfileDto.firstName, {
          appUrl: this.frontendUrl(),
          creditedBalance: result.creditedBalance,
        }),
        { previewText: WELCOME_EMAIL_PREVIEW },
      ),
    });

    // Tell the user on WhatsApp that their profile is created and under
    // review. Onboarding is a web form, so there is no open 24h session —
    // this must be a template, not a free-form text. Fire-and-forget: a
    // WhatsApp failure must never fail signup.
    // Role decides the closing line: workers are pointed at offers that match
    // them, employers at profiles that match them. Both land on /home, which is
    // already role-aware.
    const profileCreatedTpl =
      createProfileDto.profileType === ProfileType.EMPLOYER
        ? WHATSAPP_TEMPLATES.profileCreatedEmployer
        : WHATSAPP_TEMPLATES.profileCreatedWorker;
    void this.whatsApp
      .sendTemplateMessage(
        createProfileDto.phone,
        profileCreatedTpl.contentSid,
        profileCreatedTpl.variables(createProfileDto.firstName),
      )
      .catch((err: unknown) =>
        this.logger.warn(
          `Failed to send profile_created WhatsApp template to ${createProfileDto.phone}`,
          err,
        ),
      );

    // Sign a JWT and set the auth cookie so the user is logged in immediately.
    // Through `setAuthCookie` rather than an inline `res.cookie`: it is the one
    // definition of the session cookie, and hand-rolling it here had quietly
    // given everyone who signed up a 24h session while every other login path
    // issued 30 days.
    const payload = {
      sub: result.profileId,
      type: 'profile',
      jti: randomUUID(),
    };
    setAuthCookie(res, this.configService, this.jwtService.sign(payload));

    return { message: result.message, creditedBalance: result.creditedBalance };
  }

  private frontendUrl(): string {
    return (
      this.configService.get<string>('FRONTEND_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
  }

  @Get('me')
  @UseGuards(ProfileAuthGuard)
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Get current authenticated profile',
    description:
      'Returns the profile of the currently authenticated user. Requires valid JWT in cookie or Authorization header.',
  })
  @ApiResponse({
    status: 200,
    description: 'Profile retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        email: { type: 'string', format: 'email' },
        phone: { type: 'string' },
        address: { type: 'string' },
        description: { type: 'string' },
        profileType: { type: 'string', enum: ['WORKER', 'EMPLOYER'] },
        status: {
          type: 'string',
          enum: ['PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'BANNED'],
        },
        verificationStatus: {
          type: 'string',
          enum: ['PENDING', 'VERIFIED', 'REJECTED'],
        },
        reliabilityScore: { type: 'number', nullable: true },
        whatsappConnected: { type: 'boolean' },
        avatarUrl: { type: 'string', nullable: true },
        firstLogin: { type: 'boolean' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - no valid token' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  getMe(@Req() req: ProfileAuthenticatedRequest): Promise<ProfileMeResponse> {
    return this.profileService.findById(req.user.profileId);
  }

  @Patch('me/first-login-done')
  @UseGuards(ProfileAuthGuard)
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Mark first login as done (called after avatar step)',
  })
  @ApiResponse({ status: 200, description: 'first_login set to false' })
  async markFirstLoginDone(
    @Req() req: ProfileAuthenticatedRequest,
  ): Promise<{ success: boolean }> {
    await this.profileService.markFirstLoginDone(req.user.profileId);
    return { success: true };
  }

  @Get('penalties')
  @UseGuards(ProfileAuthGuard)
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Get penalties for current profile',
    description:
      'Returns all penalties for the authenticated worker. Requires valid JWT.',
  })
  @ApiResponse({
    status: 200,
    description: 'List of penalties',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          amount: { type: 'number' },
          reason: { type: 'string', nullable: true },
          appliedAt: { type: 'string', format: 'date-time' },
          applicationId: { type: 'string', format: 'uuid' },
          jobOfferTitle: { type: 'string' },
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - no valid token' })
  getPenalties(
    @Req() req: ProfileAuthenticatedRequest,
  ): Promise<ProfilePenaltyItem[]> {
    return this.profileService.getPenaltiesByProfileId(req.user.profileId);
  }

  @Patch('penalties/:id/pay')
  @UseGuards(ProfileAuthGuard)
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Pay a penalty for the current profile',
    description:
      'Records the penalty payment, credits the system wallet, and marks the penalty as paid. Returns the generated RBK reference (e.g. RBK-2025-20250304-abc123).',
  })
  @ApiBody({ type: PayPenaltyDto })
  @ApiResponse({
    status: 200,
    description: 'Penalty paid successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        reference: { type: 'string', example: 'RBK-2025-20250304-a1b2c3d4' },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Penalty already paid' })
  @ApiResponse({ status: 401, description: 'Unauthorized - no valid token' })
  @ApiResponse({ status: 404, description: 'Penalty not found' })
  async payPenalty(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: PayPenaltyDto,
  ): Promise<{ success: boolean; reference: string }> {
    const { reference } = await this.walletService.recordPenaltyPayment(
      id,
      req.user.profileId,
      body,
    );
    return { success: true, reference };
  }

  @Get('applications')
  @UseGuards(ProfileAuthGuard)
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Get applications for current profile (paginated)',
    description:
      'Returns paginated applications for the authenticated worker. Default: 10 per page.',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of applications',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              status: { type: 'string' },
              createdAt: { type: 'string', format: 'date-time' },
              jobOffer: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  title: { type: 'string' },
                  scheduledAt: { type: 'string', format: 'date-time' },
                  amount: { type: 'number' },
                  address: { type: 'string' },
                  status: { type: 'string' },
                },
              },
            },
          },
        },
        total: { type: 'number' },
        page: { type: 'number' },
        limit: { type: 'number' },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - no valid token' })
  getApplications(
    @Req() req: ProfileAuthenticatedRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<ProfileApplicationsResponse> {
    const pageNum = Math.max(1, Number.parseInt(String(page || '1'), 10) || 1);
    const limitNum = Math.min(
      100,
      Math.max(1, Number.parseInt(String(limit || '10'), 10) || 10),
    );
    return this.profileService.getApplicationsByProfileId(
      req.user.profileId,
      pageNum,
      limitNum,
    );
  }

  @Patch()
  @UseGuards(ProfileAuthGuard)
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Update profile information',
    description:
      'Updates the profile information (firstName, lastName, description) for the authenticated user.',
  })
  @ApiBody({ type: UpdateProfileDto })
  @ApiResponse({
    status: 200,
    description: 'Profile updated successfully',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        email: { type: 'string', format: 'email' },
        phone: { type: 'string' },
        address: { type: 'string' },
        description: { type: 'string' },
        profileType: { type: 'string', enum: ['WORKER', 'EMPLOYER'] },
        status: {
          type: 'string',
          enum: ['PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'BANNED'],
        },
        verificationStatus: {
          type: 'string',
          enum: ['PENDING', 'VERIFIED', 'REJECTED'],
        },
        reliabilityScore: { type: 'number', nullable: true },
        whatsappConnected: { type: 'boolean' },
        avatarUrl: { type: 'string', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - no valid token' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  updateProfile(
    @Req() req: ProfileAuthenticatedRequest,
    @Body() updateProfileDto: UpdateProfileDto,
  ): Promise<ProfileMeResponse> {
    return this.profileService.updateProfile(
      req.user.profileId,
      updateProfileDto,
    );
  }

  @Post('avatar')
  @UseGuards(ProfileAuthGuard)
  @UseInterceptors(
    FileInterceptor('avatar', {
      limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
      fileFilter: (_req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp'];
        cb(null, allowed.includes(file.mimetype));
      },
    }),
  )
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Upload profile avatar',
    description:
      'Uploads a new avatar image for the authenticated user. The image is stored and the avatar_url is updated.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['avatar'],
      properties: {
        avatar: {
          type: 'string',
          format: 'binary',
          description: 'Avatar image file (PNG, JPG up to 5MB)',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Avatar uploaded successfully',
    schema: {
      type: 'object',
      properties: {
        avatarUrl: {
          type: 'string',
          description: 'URL of the uploaded avatar',
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - missing file or invalid format',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - no valid token' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async uploadAvatar(
    @Req() req: ProfileAuthenticatedRequest,
    @UploadedFile() avatar: Express.Multer.File,
  ): Promise<{ avatarUrl: string }> {
    if (!avatar) {
      throw new BadRequestException('La photo de profil est requise');
    }

    return this.profileService.updateAvatar(req.user.profileId, avatar);
  }

  @Post('kyc-upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
      fileFilter: (_req, file, cb) => {
        const allowed = [
          'image/jpeg',
          'image/png',
          'image/webp',
          'application/pdf',
        ];
        cb(null, allowed.includes(file.mimetype));
      },
    }),
  )
  @ApiOperation({
    summary: 'Pre-upload a KYC file during onboarding',
    description:
      'Uploads a single KYC file (identity document or selfie) to storage and returns its descriptor. The descriptor is later sent in the JSON body of POST /profile, so no file bytes travel in the profile-creation request. Callable before a profile exists (no auth).',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'KYC file (JPG, PNG, WEBP, or PDF up to 10MB)',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'File uploaded successfully',
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Public URL of the uploaded file' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - missing file or invalid format',
  })
  async uploadKyc(
    @UploadedFile() file: Express.Multer.File,
  ): Promise<{ url: string }> {
    if (!file) {
      throw new BadRequestException('Le fichier KYC est requis');
    }

    return this.profileService.uploadKycFile(file);
  }

  @Post('verify-whatsapp')
  @UseGuards(ProfileAuthGuard)
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Request WhatsApp verification for the authenticated profile',
    description:
      'Generates a secure verification token and sends it via WhatsApp to the authenticated profile phone number. The token expires in 30 minutes.',
  })
  @ApiResponse({
    status: 200,
    description: 'Verification token sent successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - no valid token' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  @ApiResponse({
    status: 503,
    description: 'WhatsApp service unavailable or message send failed',
  })
  async requestWhatsAppVerification(
    @Req() req: ProfileAuthenticatedRequest,
  ): Promise<{ success: boolean }> {
    return this.profileService.requestWhatsAppVerification(req.user.profileId);
  }

  @Get('agreement/download')
  @UseGuards(ProfileAuthGuard)
  @ApiOperation({
    summary: 'Download the platform agreement prefilled with profile data',
  })
  @ApiCookieAuth()
  @ApiBearerAuth()
  @ApiResponse({ status: 200, description: 'PDF file stream' })
  @ApiResponse({ status: 404, description: 'No agreement template found' })
  async downloadAgreement(
    @Req() req: ProfileAuthenticatedRequest,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.profileService.downloadAgreement(
      req.user.profileId,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }
}
