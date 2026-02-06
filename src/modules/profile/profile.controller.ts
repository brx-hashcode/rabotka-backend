import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFiles,
  Body,
  BadRequestException,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiConsumes,
  ApiBody,
  ApiResponse,
} from '@nestjs/swagger';
import { I18n, I18nContext } from 'nestjs-i18n';
import { ProfileService } from './profile.service';
import { CreateProfileDto } from './dto/create-profile.dto';

@ApiTags('Profile')
@Controller('profile')
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

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
      throw new BadRequestException('KYC document is required');
    }

    if (!kycSelfie) {
      throw new BadRequestException('KYC selfie is required');
    }

    const result = await this.profileService.createProfile(
      createProfileDto,
      kycDocument,
      kycSelfie,
    );

    const localizedMessage = i18n.t(result.message, {
      lang: i18n.lang,
    });

    return {
      message: localizedMessage,
    };
  }
}
