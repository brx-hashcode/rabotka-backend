import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { FileService } from '../file/file.service';
import { CreateProfileDto } from './dto/create-profile.dto';
import { Prisma } from '@prisma/client';

export type ProfileMeResponse = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  description: string;
  profileType: string;
  status: string;
  verificationStatus: string;
  reliabilityScore: number | null;
  whatsappConnected: boolean;
  createdAt: Date;
};

type PrismaTransactionClient = Parameters<
  Parameters<PrismaService['$transaction']>[0]
>[0];

@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fileService: FileService,
  ) {}

  /**
   * Find profile by ID and return sanitized data for /profile/me
   */
  async findById(id: string): Promise<ProfileMeResponse> {
    const profile = await this.prisma.profile.findUnique({
      where: { id },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        phone: true,
        address: true,
        description: true,
        profile_type: true,
        status: true,
        verification_status: true,
        reliability_score: true,
        whatsapp_connected: true,
        created_at: true,
      },
    });

    if (!profile) {
      throw new NotFoundException('profile.errors.not_found');
    }

    return {
      id: profile.id,
      firstName: profile.first_name,
      lastName: profile.last_name,
      email: profile.email,
      phone: profile.phone,
      address: profile.address,
      description: profile.description,
      profileType: profile.profile_type,
      status: profile.status,
      verificationStatus: profile.verification_status,
      reliabilityScore: profile.reliability_score,
      whatsappConnected: profile.whatsapp_connected,
      createdAt: profile.created_at,
    };
  }

  async createProfile(
    createProfileDto: CreateProfileDto,
    kycDocument: Express.Multer.File,
    kycSelfie: Express.Multer.File,
  ): Promise<{ message: string }> {
    this.validateFiles(kycDocument, kycSelfie);

    try {
      const uploadResults = await this.uploadKycFiles(kycDocument, kycSelfie);
      const profile = await this.createProfileWithDocuments(
        createProfileDto,
        uploadResults,
      );

      this.logger.log(`Profile created successfully: ${profile.id}`);
      return { message: 'profile.created.success' };
    } catch (error: any) {
      this.handleCreateProfileError(error);
    }
  }

  private validateFiles(
    kycDocument: Express.Multer.File,
    kycSelfie: Express.Multer.File,
  ): void {
    if (!kycDocument) {
      throw new BadRequestException('KYC document is required');
    }
    if (!kycSelfie) {
      throw new BadRequestException('KYC selfie is required');
    }
  }

  private async uploadKycFiles(
    kycDocument: Express.Multer.File,
    kycSelfie: Express.Multer.File,
  ) {
    return Promise.all([
      this.fileService.uploadToStorage(kycDocument, {
        folder: 'kyc-documents',
      }),
      this.fileService.uploadToStorage(kycSelfie, {
        folder: 'kyc-documents',
      }),
    ]);
  }

  private async createProfileWithDocuments(
    createProfileDto: CreateProfileDto,
    [documentUploadResult, selfieUploadResult]: Awaited<
      ReturnType<typeof this.uploadKycFiles>
    >,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const createdProfile = await this.createProfileRecord(
        tx,
        createProfileDto,
      );

      await this.createFileRecords(tx, createdProfile.id, [
        documentUploadResult,
        selfieUploadResult,
      ]);

      await Promise.all([
        this.createKycDocumentRecord(
          tx,
          createdProfile.id,
          createProfileDto.documentType,
          'DOCUMENT',
          documentUploadResult.url,
        ),
        this.createKycDocumentRecord(
          tx,
          createdProfile.id,
          createProfileDto.documentType,
          'SELFIE',
          selfieUploadResult.url,
        ),
      ]);
      return createdProfile;
    });
  }

  private async createProfileRecord(
    tx: PrismaTransactionClient,
    createProfileDto: CreateProfileDto,
  ): Promise<{ id: string }> {
    return tx.profile.create({
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
      select: {
        id: true,
      },
    });
  }

  private async createFileRecords(
    tx: PrismaTransactionClient,
    profileId: string,
    uploadResults: Awaited<ReturnType<typeof this.uploadKycFiles>>,
  ) {
    return Promise.all(
      uploadResults.map((result) =>
        tx.file.create({
          data: {
            filename: result.key,
            original_filename: result.originalFilename,
            mime_type: result.mimeType,
            size: result.size,
            storage_provider: result.provider,
            storage_key: result.key,
            bucket: result.bucket,
            profile_id: profileId,
          },
        }),
      ),
    );
  }

  private createKycDocumentRecord(
    tx: PrismaTransactionClient,
    profileId: string,
    documentType: CreateProfileDto['documentType'] | undefined,
    documentCategory: 'DOCUMENT' | 'SELFIE',
    documentUrl: string,
  ) {
    const data: {
      profile_id: string;
      document_type?: CreateProfileDto['documentType'];
      document_category: 'DOCUMENT' | 'SELFIE';
      document_url: string;
      verification_status: 'PENDING';
    } = {
      profile_id: profileId,
      document_category: documentCategory,
      document_url: documentUrl,
      verification_status: 'PENDING',
    };

    if (documentType !== undefined) {
      data.document_type = documentType;
    }

    return tx.kycDocument.create({ data });
  }

  private handleCreateProfileError(error: any): never {
    this.logger.error(
      `Failed to create profile: ${error.message}`,
      error.stack,
    );

    if (this.isKnownException(error)) {
      throw error;
    }

    if (this.isPrismaConflictError(error)) {
      throw this.createConflictException(error);
    }

    if (this.isPrismaError(error)) {
      throw new BadRequestException('profile.errors.database');
    }

    throw new BadRequestException('profile.errors.create.failed');
  }

  private isKnownException(error: any): boolean {
    return (
      error instanceof BadRequestException || error instanceof ConflictException
    );
  }

  private isPrismaConflictError(error: any): boolean {
    return (
      (error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002') ||
      error.code === 'P2002'
    );
  }

  private createConflictException(error: any): ConflictException {
    const field = this.extractConflictField(error);
    const errorKey = this.getConflictErrorKey(field);
    return new ConflictException(errorKey);
  }

  private extractConflictField(error: any): string | undefined {
    const firstElement = error?.meta?.target?.[0];
    return typeof firstElement === 'string' ? firstElement : undefined;
  }

  private getConflictErrorKey(field: string | undefined): string {
    if (field === 'email') {
      return 'profile.errors.email.exists';
    }
    if (field === 'phone') {
      return 'profile.errors.phone.exists';
    }
    return 'profile.errors.unique.constraint';
  }

  private isPrismaError(error: any): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError;
  }
}
