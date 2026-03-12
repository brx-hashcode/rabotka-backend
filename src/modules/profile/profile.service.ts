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
import {
  verificationLinkMessage,
  accountActivatedMessage,
} from '../whatsapp/templates';
import { REDIS_CONNECTION } from '../../common/services/redis/redis.constants';
import { CreateProfileDto } from './dto/create-profile.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  AccountStatus,
  Prisma,
  ProfileType,
  VerificationStatus,
} from '@prisma/client';
import { randomBytes } from 'node:crypto';

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
  jobOffersCount: number;
  applicationsCount: number;
  penaltiesCount: number;
  unpaidPenaltiesCount: number;
};

export type ProfilePenaltyItem = {
  id: string;
  amount: number;
  reason: string | null;
  appliedAt: Date;
  paidAt: Date | null;
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

export type AdminProfileListItem = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  description: string;
  status: string;
  profileType: string;
  whatsappConnected: boolean;
  verificationStatus: string;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  rejectionReason: string | null;
  reliabilityScore: number | null;
  avatarUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AdminProfilesListResponse = {
  data: AdminProfileListItem[];
  total: number;
  page: number;
  limit: number;
};

export type AdminKycDocumentItem = {
  id: string;
  documentType: string | null;
  documentCategory: string;
  documentUrl: string;
  verificationStatus: string;
  verifiedAt: Date | null;
  verifiedBy: string | null;
  rejectionReason: string | null;
  createdAt: Date;
};

export type AdminVerificationImageItem = {
  id: string;
  imageUrl: string;
  uploadedBy: string | null;
  createdAt: Date;
};

export type AdminProfileDetailResponse = AdminProfileListItem & {
  phone: string;
  description: string;
  jobOffersCount: number;
  applicationsCount: number;
  penaltiesCount: number;
  unpaidPenaltiesCount: number;
  kycDocuments: AdminKycDocumentItem[];
  verificationImages: AdminVerificationImageItem[];
};

type PrismaTransactionClient = Parameters<
  Parameters<PrismaService['$transaction']>[0]
>[0];

const VERIFICATION_TOKEN_TTL_SECONDS = 1800;
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
        _count: {
          select: {
            job_offers: true,
            applications: true,
            penalties: true,
          },
        },
      },
    });

    if (!profile) {
      throw new NotFoundException('Profil non trouvé');
    }

    const unpaidPenaltiesCount = await this.prisma.penalty.count({
      where: { worker_id: id, paid_at: null },
    });

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
      jobOffersCount: profile._count.job_offers,
      applicationsCount: profile._count.applications,
      penaltiesCount: profile._count.penalties,
      unpaidPenaltiesCount,
    };
  }

  async updateProfile(
    id: string,
    updateProfileDto: UpdateProfileDto,
  ): Promise<ProfileMeResponse> {
    const existingProfile = await this.prisma.profile.findUnique({
      where: { id },
      select: { id: true, status: true },
    });

    if (!existingProfile) {
      throw new NotFoundException('Profil non trouvé');
    }

    const previousStatus = existingProfile.status;
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
    if (updateProfileDto.status !== undefined) {
      dataToUpdate.status = updateProfileDto.status;
    }

    await this.prisma.profile.update({
      where: { id },
      data: dataToUpdate,
    });

    const transitionedToActive =
      previousStatus !== AccountStatus.ACTIVE &&
      updateProfileDto.status === AccountStatus.ACTIVE;
    if (transitionedToActive) {
      try {
        const profile = await this.prisma.profile.findUnique({
          where: { id },
          select: { phone: true, first_name: true, profile_type: true },
        });
        if (profile?.phone) {
          const text = accountActivatedMessage(
            profile.first_name,
            profile.profile_type,
          );
          await this.whatsAppService
            .sendTextMessage(profile.phone, text)
            .catch((err) =>
              this.logger.warn(
                `Failed to send account-activated WhatsApp to ${profile.phone}:`,
                err,
              ),
            );
        }
      } catch (err) {
        this.logger.warn(
          `Failed to send account-activated WhatsApp for profile ${id}:`,
          err,
        );
      }
    }

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
      throw new NotFoundException('Profil non trouvé');
    }

    if (!avatarFile) {
      throw new BadRequestException('La photo de profil est requise');
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
      paidAt: p.paid_at,
      applicationId: p.application_id,
      jobOfferTitle: p.application?.job_offer?.title,
    }));
  }

  async markPenaltyPaid(penaltyId: string, profileId: string): Promise<void> {
    const penalty = await this.prisma.penalty.findUnique({
      where: { id: penaltyId },
    });
    if (penalty?.worker_id !== profileId) {
      throw new NotFoundException('Pénalité introuvable');
    }
    if (penalty.paid_at) {
      return;
    }
    await this.prisma.penalty.update({
      where: { id: penaltyId },
      data: { paid_at: new Date() },
    });
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

  async getProfileDetailForAdmin(
    id: string,
  ): Promise<AdminProfileDetailResponse> {
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
        status: true,
        profile_type: true,
        whatsapp_connected: true,
        verification_status: true,
        verified_by: true,
        verified_at: true,
        rejection_reason: true,
        reliability_score: true,
        avatar_url: true,
        created_at: true,
        updated_at: true,
        kyc_documents: {
          select: {
            id: true,
            document_type: true,
            document_category: true,
            document_url: true,
            verification_status: true,
            verified_at: true,
            verified_by: true,
            rejection_reason: true,
            created_at: true,
          },
          orderBy: { created_at: 'asc' },
        },
        kyc_verification_images: {
          select: {
            id: true,
            image_url: true,
            uploaded_by: true,
            created_at: true,
          },
          orderBy: { created_at: 'asc' },
        },
        _count: {
          select: {
            job_offers: true,
            applications: true,
            penalties: true,
          },
        },
      },
    });

    if (!profile) {
      throw new NotFoundException('Profil non trouvé');
    }

    const unpaidPenaltiesCount = await this.prisma.penalty.count({
      where: { worker_id: id, paid_at: null },
    });

    const verifierIds = new Set<string>();
    if (profile.verified_by) verifierIds.add(profile.verified_by);
    for (const doc of profile.kyc_documents) {
      if (doc.verified_by) verifierIds.add(doc.verified_by);
    }
    for (const img of profile.kyc_verification_images) {
      if (img.uploaded_by) verifierIds.add(img.uploaded_by);
    }

    const verifierNames = new Map<string, string>();
    if (verifierIds.size > 0) {
      const admins = await this.prisma.user.findMany({
        where: { id: { in: [...verifierIds] } },
        select: { id: true, first_name: true, last_name: true },
      });
      for (const admin of admins) {
        verifierNames.set(admin.id, `${admin.first_name} ${admin.last_name}`);
      }
    }

    return {
      id: profile.id,
      firstName: profile.first_name,
      lastName: profile.last_name,
      email: profile.email,
      phone: profile.phone,
      address: profile.address,
      description: profile.description,
      status: profile.status,
      profileType: profile.profile_type,
      whatsappConnected: profile.whatsapp_connected,
      verificationStatus: profile.verification_status,
      verifiedBy: profile.verified_by
        ? (verifierNames.get(profile.verified_by) ?? profile.verified_by)
        : null,
      verifiedAt: profile.verified_at,
      rejectionReason: profile.rejection_reason,
      reliabilityScore: profile.reliability_score,
      avatarUrl: profile.avatar_url,
      createdAt: profile.created_at,
      updatedAt: profile.updated_at,
      jobOffersCount: profile._count.job_offers,
      applicationsCount: profile._count.applications,
      penaltiesCount: profile._count.penalties,
      unpaidPenaltiesCount,
      kycDocuments: profile.kyc_documents.map((doc) => ({
        id: doc.id,
        documentType: doc.document_type,
        documentCategory: doc.document_category,
        documentUrl: doc.document_url,
        verificationStatus: doc.verification_status,
        verifiedAt: doc.verified_at,
        verifiedBy: doc.verified_by
          ? (verifierNames.get(doc.verified_by) ?? doc.verified_by)
          : null,
        rejectionReason: doc.rejection_reason,
        createdAt: doc.created_at,
      })),
      verificationImages: profile.kyc_verification_images.map((img) => ({
        id: img.id,
        imageUrl: img.image_url,
        uploadedBy: img.uploaded_by
          ? (verifierNames.get(img.uploaded_by) ?? img.uploaded_by)
          : null,
        createdAt: img.created_at,
      })),
    };
  }

  async verifyProfileKyc(
    profileId: string,
    adminUserId: string,
    decision: 'VERIFIED' | 'REJECTED',
    reason?: string,
    files?: Express.Multer.File[],
  ): Promise<AdminProfileDetailResponse> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { id: true },
    });
    if (!profile) {
      throw new NotFoundException('Profil non trouvé');
    }

    const uploadedUrls: string[] = [];
    if (files && files.length > 0) {
      for (const file of files) {
        const result = await this.fileService.uploadToStorage(file, {
          folder: 'kyc-verification',
        });
        uploadedUrls.push(result.url);
      }
    }

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.profile.update({
        where: { id: profileId },
        data: {
          verification_status: decision as VerificationStatus,
          verified_by: adminUserId,
          verified_at: now,
          rejection_reason: decision === 'REJECTED' ? (reason ?? null) : null,
        },
      }),
      this.prisma.kycDocument.updateMany({
        where: { profile_id: profileId },
        data: {
          verification_status: decision as VerificationStatus,
          verified_by: adminUserId,
          verified_at: now,
          rejection_reason: decision === 'REJECTED' ? (reason ?? null) : null,
        },
      }),
      this.prisma.kycVerificationImage.deleteMany({
        where: { profile_id: profileId },
      }),
      ...uploadedUrls.map((url) =>
        this.prisma.kycVerificationImage.create({
          data: {
            profile_id: profileId,
            image_url: url,
            uploaded_by: adminUserId === 'system' ? null : adminUserId,
          },
        }),
      ),
    ]);

    return this.getProfileDetailForAdmin(profileId);
  }

  async updateProfileStatusByAdmin(
    profileId: string,
    status: AccountStatus,
  ): Promise<AdminProfileDetailResponse> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        id: true,
        status: true,
        phone: true,
        first_name: true,
        profile_type: true,
      },
    });
    if (!profile) {
      throw new NotFoundException('Profil non trouvé');
    }

    await this.prisma.profile.update({
      where: { id: profileId },
      data: { status },
    });

    if (
      profile.status !== AccountStatus.ACTIVE &&
      status === AccountStatus.ACTIVE
    ) {
      try {
        if (profile.phone) {
          const text = accountActivatedMessage(
            profile.first_name,
            profile.profile_type,
          );
          await this.whatsAppService.sendTextMessage(profile.phone, text);
        }
      } catch {
        this.logger.warn(
          `Failed to send activation message for profile ${profileId}`,
        );
      }
    }

    return this.getProfileDetailForAdmin(profileId);
  }

  async updateProfileByAdmin(
    profileId: string,
    dto: UpdateProfileDto,
  ): Promise<AdminProfileDetailResponse> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { id: true },
    });
    if (!profile) {
      throw new NotFoundException('Profil non trouvé');
    }

    const dataToUpdate: Prisma.ProfileUpdateInput = {};
    if (dto.firstName !== undefined) dataToUpdate.first_name = dto.firstName;
    if (dto.lastName !== undefined) dataToUpdate.last_name = dto.lastName;
    if (dto.description !== undefined)
      dataToUpdate.description = dto.description;
    if (dto.address !== undefined) dataToUpdate.address = dto.address;
    if (dto.phone !== undefined) dataToUpdate.phone = dto.phone;
    if (dto.email !== undefined) dataToUpdate.email = dto.email;

    try {
      await this.prisma.profile.update({
        where: { id: profileId },
        data: dataToUpdate,
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const fields = (err.meta?.target as string[]) ?? [];
        throw new ConflictException(
          `Ce ${fields.join(', ')} est déjà utilisé par un autre profil.`,
        );
      }
      throw err;
    }

    return this.getProfileDetailForAdmin(profileId);
  }

  async getProfilesForAdmin(params: {
    page: number;
    limit: number;
    q?: string;
    status?: AccountStatus[];
    profileType?: ProfileType[];
    whatsappConnected?: boolean;
    verificationStatus?: VerificationStatus[];
  }): Promise<AdminProfilesListResponse> {
    const {
      page,
      limit,
      q,
      status,
      profileType,
      whatsappConnected,
      verificationStatus,
    } = params;
    const skip = (page - 1) * limit;

    const where: Prisma.ProfileWhereInput = {};

    const searchTrimmed = q?.trim() ?? '';
    if (searchTrimmed.length > 0) {
      where.OR = [
        { first_name: { contains: searchTrimmed, mode: 'insensitive' } },
        { last_name: { contains: searchTrimmed, mode: 'insensitive' } },
        { email: { contains: searchTrimmed, mode: 'insensitive' } },
        { phone: { contains: searchTrimmed, mode: 'insensitive' } },
      ];
    }

    if (status != null && status.length > 0) {
      where.status = { in: status };
    }
    if (profileType != null && profileType.length > 0) {
      where.profile_type = { in: profileType };
    }
    if (whatsappConnected !== undefined) {
      where.whatsapp_connected = whatsappConnected;
    }
    if (verificationStatus != null && verificationStatus.length > 0) {
      where.verification_status = { in: verificationStatus };
    }

    const [profiles, total] = await Promise.all([
      this.prisma.profile.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          first_name: true,
          last_name: true,
          email: true,
          phone: true,
          address: true,
          description: true,
          status: true,
          profile_type: true,
          whatsapp_connected: true,
          verification_status: true,
          verified_by: true,
          verified_at: true,
          rejection_reason: true,
          reliability_score: true,
          avatar_url: true,
          created_at: true,
          updated_at: true,
        },
      }),
      this.prisma.profile.count({ where }),
    ]);

    const data: AdminProfileListItem[] = profiles.map((p) => ({
      id: p.id,
      firstName: p.first_name,
      lastName: p.last_name,
      email: p.email,
      phone: p.phone,
      address: p.address,
      description: p.description,
      status: p.status,
      profileType: p.profile_type,
      whatsappConnected: p.whatsapp_connected,
      verificationStatus: p.verification_status,
      verifiedBy: p.verified_by,
      verifiedAt: p.verified_at,
      rejectionReason: p.rejection_reason,
      reliabilityScore: p.reliability_score,
      avatarUrl: p.avatar_url,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
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

      // Auto-send WhatsApp verification link (non-blocking)
      this.requestWhatsAppVerification(profile.id).catch((err) =>
        this.logger.warn(
          `Failed to auto-send WhatsApp verification link for ${profile.id}:`,
          err,
        ),
      );

      return { message: 'Profil créé avec succès' };
    } catch (error: any) {
      this.handleCreateProfileError(error);
    }
  }

  private validateFiles(
    kycDocument: Express.Multer.File,
    kycSelfie: Express.Multer.File,
  ): void {
    if (!kycDocument) {
      throw new BadRequestException('Le document KYC est requis');
    }
    if (!kycSelfie) {
      throw new BadRequestException('La photo KYC est requise');
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
        status: 'PENDING_ACTIVATION',
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
      throw new BadRequestException(
        "Une erreur de base de données s'est produite. Veuillez réessayer plus tard",
      );
    }

    throw new BadRequestException(
      'Échec de la création du profil. Veuillez réessayer',
    );
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
      return 'Un compte avec cette adresse e-mail existe déjà';
    }
    if (field === 'phone') {
      return 'Un compte avec ce numéro de téléphone existe déjà';
    }
    return 'Un profil avec ces informations existe déjà';
  }

  private isPrismaError(error: any): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError;
  }

  async requestWhatsAppVerification(
    profileId: string,
  ): Promise<{ success: boolean }> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        id: true,
        first_name: true,
        phone: true,
      },
    });

    if (!profile) {
      throw new NotFoundException('Profil non trouvé');
    }

    if (!this.whatsAppService.isConfigured()) {
      throw new ServiceUnavailableException(
        "Le service WhatsApp n'est pas configuré",
      );
    }

    const token = randomBytes(32).toString('base64url');
    const redisKey = `${VERIFICATION_TOKEN_KEY_PREFIX}${token}`;

    await this.redis.set(
      redisKey,
      profileId,
      'EX',
      VERIFICATION_TOKEN_TTL_SECONDS,
    );

    const frontendUrl = this.configService.get<string>(
      'FRONTEND_URL',
      'http://localhost:3000',
    );
    const verificationLink = `${frontendUrl}/verify/whatsapp?token=${token}`;
    const message = verificationLinkMessage(
      profile.first_name,
      verificationLink,
    );

    const sent = await this.whatsAppService.sendTextMessage(
      profile.phone,
      message,
    );

    if (!sent) {
      await this.redis.del(redisKey);
      throw new ServiceUnavailableException(
        "Échec de l'envoi du message WhatsApp",
      );
    }

    this.logger.log(`WhatsApp verification token sent to profile ${profileId}`);
    return { success: true };
  }
}
