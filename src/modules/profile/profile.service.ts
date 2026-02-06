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
      await this.createKycDocument(
        tx,
        createdProfile.id,
        createProfileDto.documentType,
        documentUploadResult.url,
        selfieUploadResult.url,
      );
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

  private createKycDocument(
    tx: PrismaTransactionClient,
    profileId: string,
    documentType: CreateProfileDto['documentType'],
    documentUrl: string,
    selfieUrl: string,
  ) {
    return tx.kycDocument.create({
      data: {
        profile_id: profileId,
        document_type: documentType,
        document_url: documentUrl,
        selfie_url: selfieUrl,
        verification_status: 'PENDING',
      },
    });
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
