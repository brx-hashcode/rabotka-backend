import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { FileService } from '../file/file.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { REDIS_CONNECTION } from '../../common/services/redis/redis.constants';
import { CreateProfileDto } from './dto/create-profile.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';

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
  avatarUrl: string | null;
  createdAt: Date;
};

export type ProfilePenaltyItem = {
  id: string;
  amount: number;
  reason: string | null;
  appliedAt: Date;
  applicationId: string;
  jobOfferTitle?: string;
};

export type ProfileApplicationItem = {
  id: string;
  status: string;
  createdAt: Date;
  jobOffer: {
    id: string;
    title: string;
    scheduledAt: Date;
    amount: number;
    address: string;
    status: string;
  };
};

export type ProfileApplicationsResponse = {
  data: ProfileApplicationItem[];
  total: number;
  page: number;
  limit: number;
};

type PrismaTransactionClient = Parameters<
  Parameters<PrismaService['$transaction']>[0]
>[0];

const VERIFICATION_TOKEN_TTL_SECONDS = 1800; // 30 minutes
const VERIFICATION_TOKEN_KEY_PREFIX = 'wa:verify:';

@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fileService: FileService,
    @Inject(REDIS_CONNECTION)
    private readonly redis: Redis,
    private readonly whatsAppService: WhatsAppService,
    private readonly configService: ConfigService,
  ) {}

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
        avatar_url: true,
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
      avatarUrl: profile.avatar_url,
      createdAt: profile.created_at,
    };
  }

  async updateProfile(
    id: string,
    updateProfileDto: UpdateProfileDto,
  ): Promise<ProfileMeResponse> {
    const existingProfile = await this.prisma.profile.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!existingProfile) {
      throw new NotFoundException('profile.errors.not_found');
    }

    const dataToUpdate: Prisma.ProfileUpdateInput = {};

    if (updateProfileDto.firstName !== undefined) {
      dataToUpdate.first_name = updateProfileDto.firstName;
    }
    if (updateProfileDto.lastName !== undefined) {
      dataToUpdate.last_name = updateProfileDto.lastName;
    }
    if (updateProfileDto.description !== undefined) {
      dataToUpdate.description = updateProfileDto.description;
    }
    if (updateProfileDto.address !== undefined) {
      dataToUpdate.address = updateProfileDto.address;
    }

    await this.prisma.profile.update({
      where: { id },
      data: dataToUpdate,
    });

    this.logger.log(`Profile updated successfully: ${id}`);
    return this.findById(id);
  }

  async updateAvatar(
    id: string,
    avatarFile: Express.Multer.File,
  ): Promise<{ avatarUrl: string }> {
    const existingProfile = await this.prisma.profile.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!existingProfile) {
      throw new NotFoundException('profile.errors.not_found');
    }

    if (!avatarFile) {
      throw new BadRequestException('profile.errors.avatar.required');
    }

    const uploadResult = await this.fileService.uploadToStorage(avatarFile, {
      folder: 'avatars',
    });

    await this.prisma.profile.update({
      where: { id },
      data: { avatar_url: uploadResult.url },
    });

    this.logger.log(`Avatar updated successfully for profile: ${id}`);
    return { avatarUrl: uploadResult.url };
  }

  async getPenaltiesByProfileId(
    profileId: string,
  ): Promise<ProfilePenaltyItem[]> {
    const penalties = await this.prisma.penalty.findMany({
      where: { worker_id: profileId },
      orderBy: { applied_at: 'desc' },
      include: {
        application: { include: { job_offer: true } },
      },
    });
    return penalties.map((p) => ({
      id: p.id,
      amount: Number(p.amount),
      reason: p.reason,
      appliedAt: p.applied_at,
      applicationId: p.application_id,
      jobOfferTitle: p.application?.job_offer?.title,
    }));
  }

  async getApplicationsByProfileId(
    profileId: string,
    page: number,
    limit: number,
  ): Promise<ProfileApplicationsResponse> {
    const skip = (page - 1) * limit;
    const [applications, total] = await Promise.all([
      this.prisma.application.findMany({
        where: { worker_id: profileId },
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        include: { job_offer: true },
      }),
      this.prisma.application.count({ where: { worker_id: profileId } }),
    ]);
    const data: ProfileApplicationItem[] = applications.map((a) => ({
      id: a.id,
      status: a.status,
      createdAt: a.created_at,
      jobOffer: {
        id: a.job_offer.id,
        title: a.job_offer.title,
        scheduledAt: a.job_offer.scheduled_at,
        amount: Number(a.job_offer.amount),
        address: a.job_offer.address,
        status: a.job_offer.status,
      },
    }));
    return { data, total, page, limit };
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

  async requestWhatsAppVerification(
    profileId: string,
  ): Promise<{ success: boolean }> {
    // Get profile with phone number
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        id: true,
        first_name: true,
        phone: true,
      },
    });

    if (!profile) {
      throw new NotFoundException('profile.errors.not_found');
    }

    // Check if WhatsApp service is connected
    if (!this.whatsAppService.isConnected()) {
      throw new ServiceUnavailableException('whatsapp.errors.not_connected');
    }

    // Generate secure token
    const token = randomBytes(32).toString('base64url');
    const redisKey = `${VERIFICATION_TOKEN_KEY_PREFIX}${token}`;

    // Store token in Redis with 30 minute expiration
    await this.redis.set(
      redisKey,
      profileId,
      'EX',
      VERIFICATION_TOKEN_TTL_SECONDS,
    );

    // Get frontend URL from config
    const frontendUrl = this.configService.get<string>(
      'FRONTEND_URL',
      'http://localhost:3000',
    );
    const verificationLink = `${frontendUrl}/verify/whatsapp?token=${token}`;

    // Create WhatsApp message
    const message = `Bonjour ${profile.first_name},

Cliquez sur ce lien pour vérifier votre compte WhatsApp :
${verificationLink}

Ce lien expire dans 30 minutes.`;

    // Send WhatsApp message
    const sent = await this.whatsAppService.sendTextMessage(
      profile.phone,
      message,
    );

    if (!sent) {
      // Clean up token if message failed to send
      await this.redis.del(redisKey);
      throw new ServiceUnavailableException('whatsapp.errors.send_failed');
    }

    this.logger.log(`WhatsApp verification token sent to profile ${profileId}`);
    return { success: true };
  }
}
