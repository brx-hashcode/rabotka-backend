import {
  Controller,
  Post,
  Get,
  UseInterceptors,
  UseGuards,
  UploadedFiles,
  Body,
  Req,
  BadRequestException,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiConsumes,
  ApiBody,
  ApiResponse,
  ApiBearerAuth,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { I18n, I18nContext } from 'nestjs-i18n';
import { ProfileService, ProfileMeResponse } from './profile.service';
import { CreateProfileDto } from './dto/create-profile.dto';
import { sendWelcomeEmail } from '../mail/templates';
import { MailService } from '../mail/mail.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';

@ApiTags('Profile')
@Controller('profile')
export class ProfileController {
  constructor(
    private readonly profileService: ProfileService,
    private readonly mailService: MailService,
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
    @I18n() i18n: I18nContext,
  ) {
    const kycDocument = files?.kycDocument?.[0];
    const kycSelfie = files?.kycSelfie?.[0];

    if (!kycDocument) {
      throw new BadRequestException(
        i18n.t('profile.errors.kyc.document.required'),
      );
    }

    if (!kycSelfie) {
      throw new BadRequestException(
        i18n.t('profile.errors.kyc.selfie.required'),
      );
    }

    const result = await this.profileService.createProfile(
      createProfileDto,
      kycDocument,
      kycSelfie,
    );

    await this.mailService.sendMail({
      to: createProfileDto.email,
      subject: i18n.t('profile.errors.mail.subject'),
      html: sendWelcomeEmail(createProfileDto.firstName),
    });

    const localizedMessage = i18n.t(result.message, {
      lang: i18n.lang,
    });

    return {
      message: localizedMessage,
    };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
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
          enum: ['PENDING_PAYMENT', 'ACTIVE', 'SUSPENDED', 'BANNED'],
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
  getMe(@Req() req: AuthenticatedRequest): Promise<ProfileMeResponse> {
    return this.profileService.findById(req.user.profileId);
  }
}
