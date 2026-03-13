import {
  Controller,
  Post,
  Get,
  Patch,
  UseInterceptors,
  UseGuards,
  UploadedFiles,
  UploadedFile,
  Body,
  Req,
  Query,
  BadRequestException,
  Param,
} from '@nestjs/common';
import {
  FileFieldsInterceptor,
  FileInterceptor,
} from '@nestjs/platform-express';
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
import { PayPenaltyDto } from '../wallet/dto/pay-penalty.dto';

@ApiTags('Profile')
@Controller('profile')
export class ProfileController {
  constructor(
    private readonly profileService: ProfileService,
    private readonly mailService: MailService,
    private readonly walletService: WalletService,
  ) {}

  @Post()
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'kycDocument', maxCount: 1 },
      { name: 'kycSelfie', maxCount: 1 },
    ]),
  )
  @ApiOperation({
    summary: 'Create a new profile with KYC documents',
    description:
      'Creates a new profile with personal information and KYC documents (identity document and selfie). Files are uploaded to storage and URLs are stored in the database.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: [
        'firstName',
        'lastName',
        'email',
        'phone',
        'address',
        'profileType',
        'kycDocument',
        'kycSelfie',
      ],
      properties: {
        firstName: {
          type: 'string',
          description: 'First name of the profile',
        },
        lastName: {
          type: 'string',
          description: 'Last name of the profile',
        },
        email: {
          type: 'string',
          format: 'email',
          description: 'Email address (must be unique)',
        },
        phone: {
          type: 'string',
          description: 'Phone number (must be unique)',
        },
        address: {
          type: 'string',
          description: 'Physical address',
        },
        description: {
          type: 'string',
          description: 'Profile description (optional)',
        },
        profileType: {
          type: 'string',
          enum: ['WORKER', 'EMPLOYER'],
          description: 'Profile type',
        },
        documentType: {
          type: 'string',
          enum: ['IDENTITY_CARD', 'PASSPORT', 'DRIVER_LICENSE', 'OTHER'],
          description: 'Document type',
        },
        kycDocument: {
          type: 'string',
          format: 'binary',
          description: 'KYC identity document (image file)',
        },
        kycSelfie: {
          type: 'string',
          format: 'binary',
          description: 'KYC selfie photo (image file)',
        },
      },
    },
  })
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
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - validation error or missing files',
  })
  @ApiResponse({
    status: 409,
    description: 'Conflict - email or phone already exists',
  })
  async createProfile(
    @Body() createProfileDto: CreateProfileDto,
    @UploadedFiles()
    files: {
      kycDocument?: Express.Multer.File[];
      kycSelfie?: Express.Multer.File[];
    },
  ) {
    const kycDocument = files?.kycDocument?.[0];
    const kycSelfie = files?.kycSelfie?.[0];

    if (!kycDocument) {
      throw new BadRequestException('Le document KYC est requis');
    }

    if (!kycSelfie) {
      throw new BadRequestException('La photo KYC est requise');
    }

    const result = await this.profileService.createProfile(
      createProfileDto,
      kycDocument,
      kycSelfie,
    );

    await this.mailService.sendMail({
      to: createProfileDto.email,
      subject: 'Bienvenue sur Rabotka',
      html: sendWelcomeEmail(createProfileDto.firstName),
    });

    return {
      message: result.message,
    };
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
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - no valid token' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  getMe(@Req() req: ProfileAuthenticatedRequest): Promise<ProfileMeResponse> {
    return this.profileService.findById(req.user.profileId);
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
  @UseInterceptors(FileInterceptor('avatar'))
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
}
