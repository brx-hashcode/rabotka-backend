import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { FileService } from '../file/file.service';
import { CreateProfileDto } from './dto/create-profile.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fileService: FileService,
  ) {}

  async createProfile(
    createProfileDto: CreateProfileDto,
    kycDocument: Express.Multer.File,
    kycSelfie: Express.Multer.File,
  ): Promise<{ message: string }> {
    if (!kycDocument) {
      throw new BadRequestException('KYC document is required');
    }

    if (!kycSelfie) {
      throw new BadRequestException('KYC selfie is required');
    }

    try {
      const [documentUploadResult, selfieUploadResult] = await Promise.all([
        this.fileService.uploadToStorage(kycDocument, {
          folder: 'kyc-documents',
        }),
        this.fileService.uploadToStorage(kycSelfie, {
          folder: 'kyc-documents',
        }),
      ]);

      const profile = await this.prisma.$transaction(async (tx) => {
        const createdProfile = await tx.profile.create({
          data: {
            first_name: createProfileDto.firstName,
            last_name: createProfileDto.lastName,
            email: createProfileDto.email,
            phone: createProfileDto.phone,
            address: createProfileDto.address,
            description: createProfileDto.description || '',
            profile_type: createProfileDto.profileType,
            status: 'PENDING_PAYMENT',
            verification_status: 'PENDING',
            reliability_score: 100,
          },
        });

        await Promise.all([
          tx.file.create({
            data: {
              filename: documentUploadResult.key,
              original_filename: documentUploadResult.originalFilename,
              mime_type: documentUploadResult.mimeType,
              size: documentUploadResult.size,
              storage_provider: documentUploadResult.provider,
              storage_key: documentUploadResult.key,
              bucket: documentUploadResult.bucket,
              profile_id: createdProfile.id,
            },
          }),
          tx.file.create({
            data: {
              filename: selfieUploadResult.key,
              original_filename: selfieUploadResult.originalFilename,
              mime_type: selfieUploadResult.mimeType,
              size: selfieUploadResult.size,
              storage_provider: selfieUploadResult.provider,
              storage_key: selfieUploadResult.key,
              bucket: selfieUploadResult.bucket,
              profile_id: createdProfile.id,
            },
          }),
        ]);

        await tx.kycDocument.create({
          data: {
            profile_id: createdProfile.id,
            document_type: createProfileDto.documentType,
            document_url: documentUploadResult.url,
            selfie_url: selfieUploadResult.url,
            verification_status: 'PENDING',
          },
        });

        return createdProfile;
      });

      this.logger.log(`Profile created successfully: ${profile.id}`);

      return { message: 'profile.created.success' };
    } catch (error: any) {
      this.logger.error(
        `Failed to create profile: ${error.message}`,
        error.stack,
      );

      // Handle Prisma unique constraint violations
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          const field = error.meta?.target?.[0];
          if (field === 'email') {
            throw new ConflictException('profile.errors.email.exists');
          }
          if (field === 'phone') {
            throw new ConflictException('profile.errors.phone.exists');
          }
          // Generic unique constraint error
          throw new ConflictException('profile.errors.unique.constraint');
        }
        // Handle other Prisma errors
        throw new BadRequestException('profile.errors.database');
      }

      // Check for Prisma error code even if not instanceof (for wrapped errors)
      if (error.code === 'P2002') {
        const field = error.meta?.target?.[0];
        if (field === 'email') {
          throw new ConflictException('profile.errors.email.exists');
        }
        if (field === 'phone') {
          throw new ConflictException('profile.errors.phone.exists');
        }
        throw new ConflictException('profile.errors.unique.constraint');
      }

      // Re-throw known exceptions
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException
      ) {
        throw error;
      }

      // Generic error
      throw new BadRequestException('profile.errors.create.failed');
    }
  }
}
