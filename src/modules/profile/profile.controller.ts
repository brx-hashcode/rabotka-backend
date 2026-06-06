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
import { VerifyWhatsAppDto } from './dto/verify-whatsapp.dto';
import { sendWelcomeEmail } from '../mail/templates';
import { MailService } from '../mail/mail.service';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { WalletService } from '../wallet/wallet.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PayPenaltyDto } from '../wallet/dto/pay-penalty.dto';

@ApiTags('Profile')
@Controller('profile')
export class ProfileController {
  constructor(
    private readonly profileService: ProfileService,
    private readonly mailService: MailService,
    private readonly walletService: WalletService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

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
          description: 'Welcome credit amount granted to the new profile in FCFA',
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
      html: sendWelcomeEmail(createProfileDto.firstName),
    });

    // Sign a JWT and set the auth cookie so the user is logged in immediately
    const cookieName = this.configService.get<string>('AUTH_COOKIE_NAME');
    if (cookieName) {
      const payload = { sub: result.profileId, type: 'profile', jti: randomUUID() };
      const token = this.jwtService.sign(payload);
      const isProduction = this.configService.get('NODE_ENV') === 'production';
      res.cookie(cookieName, token, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        maxAge: 24 * 60 * 60 * 1000,
        path: '/',
      });
    }

    return { message: result.message, creditedBalance: result.creditedBalance };
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
  @ApiOperation({ summary: 'Mark first login as done (called after avatar step)' })
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
    summary: 'Request WhatsApp verification for a profile',
    description:
      'Admin endpoint: Generates a secure verification token and sends it via WhatsApp to the specified profile phone number. The token expires in 30 minutes.',
  })
  @ApiBody({ type: VerifyWhatsAppDto })
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
    @Body() verifyWhatsAppDto: VerifyWhatsAppDto,
  ): Promise<{ success: boolean }> {
    return this.profileService.requestWhatsAppVerification(
      verifyWhatsAppDto.profileId,
    );
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
