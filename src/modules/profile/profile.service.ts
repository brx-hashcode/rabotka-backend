import { countCountedCancellations } from '../application/cancellation-counter';
import {
  AdminCacheService,
  ADMIN_LIST_TTL_SECONDS,
} from '../../common/services/cache/admin-cache.service';
import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Inject,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  kycBucket,
  storageNames,
} from '../../common/services/storage/kyc-bucket';
import {
  deriveKey,
  isKycKey,
  kycContentKind,
  kycFileAvailable,
  kycObjectRef,
  legacyKycUrl,
} from '../../common/services/storage/kyc-key';
import { DownloadResult } from '../../common/services/storage/types/storage.types';
import { SystemConfigService } from '../system-config/system-config.service';
import { WhatsAppDocumentService } from '../whatsapp/documents/whatsapp-document.service';
import {
  NotificationDispatcher,
  type FreeFormMessage,
} from '../notification-dispatch/notification-dispatcher.service';
import type { TemplateKey, TemplateParams } from '../whatsapp/contracts';
import {
  accountActivatedFreeForm,
  accountSuspendedFreeForm,
} from '../bot/messages/notifications.messages';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { notifyProfile } from '../profile-notification/profile-notification.events';
import {
  PROFILE_AUTO_SUSPENDED_EVENT,
  type ProfileAutoSuspendedPayload,
} from '../../common/events/profile-auto-suspended.event';
import { AdminNotificationEvent } from '../../common/events/admin-notification.events';
import Redis from 'ioredis';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { FileService } from '../file/file.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { verificationLinkMessage } from '../whatsapp/templates';
import {
  WHATSAPP_TEMPLATES,
  SUSPENDED_CTA_PATH,
} from '../../common/constants/whatsapp-templates';
import { WhatsAppLoginLinkService } from '../auth/whatsapp-login-link.service';
import { MailService } from '../mail/mail.service';
import { LayoutService } from '../mail/layout.service';
import { accountSuspendedEmail } from '../mail/templates';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../common/services/redis/redis.constants';
import { WalletService } from '../wallet/wallet.service';
import { DocumentService } from '../document/document.service';
import { MatchingService } from '../matching/matching.service';
import { InterestClusterService } from '../interest-graph/interest-cluster.service';
import { PortfolioService } from '../portfolio/portfolio.service';
import { GeocodingService } from '../../common/services/geocoding/geocoding.service';
import { GeoService } from '../geo/geo.service';
import { ReferralService } from '../referral/referral.service';
import { CreateProfileDto } from './dto/create-profile.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { AdminUpdateProfileDto } from './dto/admin-update-profile.dto';
import { deletedAtFilter } from '../../common/utils/soft-delete.util';
import {
  AccountStatus,
  DocumentType,
  EmploymentType,
  KycDocumentCategory,
  Prisma,
  ProfileType,
  ReferralSource,
  ReferralStatus,
  SuspensionSource,
  VerificationStatus,
  BusinessCategory,
  BusinessDocumentType,
  BusinessLegalForm,
} from '@prisma/client';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { OnboardingAttemptService } from '../onboarding-attempt/onboarding-attempt.service';
import { markProfilesArchived } from '../auth/session-revocation';
import {
  PROFILES_ARCHIVED,
  PROFILES_RESTORED,
  type ProfilesArchivedEvent,
  type ProfilesRestoredEvent,
} from './profile-lifecycle.events';
import {
  assertCanSendOtp,
  assertNotLockedOut,
  recordMiss,
} from '../auth/otp-store';
import { toE164 } from '../whatsapp/contracts/address';
import {
  SESSION_ENDED,
  type SessionEndedEvent,
} from '../../common/events/session-ended.events';
import { assertBusinessIsEmployer } from '../business/business-rules';
import { assertBusinessSignupComplete } from '../business/business-signup';
import {
  BUSINESS_CATEGORY_LABELS,
  BUSINESS_DOCUMENT_LABELS,
  BUSINESS_LEGAL_FORM_LABELS,
  DOCUMENTS_BY_CATEGORY,
  missingRequiredDocuments,
} from '../business/business-catalog';
import type { SignupIdentity } from '../auth/signup-token';
import {
  changedReviewedFields,
  legalFormAfterEdit,
} from '../business/business-edit';
import type { UpdateBusinessDto } from '../business/dto/update-business.dto';

const PROFILE_TYPE_LABELS: Record<ProfileType, string> = {
  [ProfileType.WORKER]: 'Travailleur',
  [ProfileType.EMPLOYER]: 'Employeur',
};

export type ProfileMeResponse = {
  id: string;
  firstName: string;
  lastName: string;
  /** Null for the majority, who sign up with a phone and no email. */
  email: string | null;
  phone: string;
  /** Optional second number. Null for the majority who have only one. */
  directPhone: string | null;
  address: string;
  countryCode: string | null;
  countryName: string | null;
  city: string | null;
  description: string;
  profileType: string;
  status: string;
  verificationStatus: string;
  /**
   * The admin's own words on a refusal and a suspension.
   *
   * Owner-only by construction — `findById` backs `GET /profile/me`, which is
   * authenticated as the profile itself. Both strings have already reached this
   * user on WhatsApp: they fill {{2}} of the refusal and suspension templates
   * the moment an admin decides. Carrying them here lets the app and the
   * assistant answer "why?" instead of only "it was refused".
   */
  rejectionReason: string | null;
  suspensionReason: string | null;
  reliabilityScore: number | null;
  whatsappConnected: boolean;
  avatarUrl: string | null;
  firstLogin: boolean;
  createdAt: Date;
  jobOffersCount: number;
  applicationsCount: number;
  penaltiesCount: number;
  unpaidPenaltiesCount: number;
  walletBalance: number;
  categoryIds: string[];
  categoryNames: string[];
};

export type ProfilePenaltyItem = {
  id: string;
  amount: number;
  reason: string | null;
  appliedAt: Date;
  paidAt: Date | null;
  applicationId: string | null;
  jobOfferTitle?: string | null;
};

export type ProfileApplicationItem = {
  id: string;
  status: string;
  createdAt: Date;
  contractId: string | null;
  jobOffer: {
    id: string;
    title: string;
    scheduledAt: Date | null;
    employmentType: EmploymentType;
    /** Null when the employer named no price — «À négocier», not «0 FCFA». */
    amount: number | null;
    address: string | null;
    isRemote: boolean;
    city: string | null;
    countryName: string | null;
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
  /** A business account: the admin shows its « Entreprise » tab. */
  isBusiness: boolean;
  firstName: string;
  lastName: string;
  /** Null for the majority, who sign up with a phone and no email. */
  email: string | null;
  phone: string;
  /**
   * Optional second number. Null for the majority who have only one.
   *
   * Selected on the detail read only — the list query does not fetch it, so
   * this is null on every row that comes from `listProfilesForAdmin`.
   */
  directPhone?: string | null;
  address: string;
  countryCode: string | null;
  countryName: string | null;
  city: string | null;
  /** Null unless geocoding succeeded; it is fire-and-forget, so gaps are normal. */
  latitude: number | null;
  longitude: number | null;
  description: string;
  status: string;
  profileType: string;
  whatsappConnected: boolean;
  verificationStatus: string;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  rejectionReason: string | null;
  kycVerificationNote: string | null;
  reliabilityScore: number | null;
  avatarUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * The trades this profile works in. Plural and unordered — a multi-skilled
   * worker has several, and picking one to represent them is what made the
   * recommendation cards look like specialists.
   */
  categoryIds: string[];
  categoryNames: string[];
  ratingAvg: number | null;
  ratingCount: number;
  billingStatus: string;
  suspensionReason: string | null;
  suspendedAt: Date | null;
  lastLoginAt: Date | null;
  /** First time the account became usable. Not a sign-in — activation mints no session. */
  activatedAt: Date | null;
  firstLogin: boolean;
  readAndApprovedPolicies: boolean;
  portfolioSlug: string | null;
  /** When this profile last reached the vector index; null means never. */
  vectorIndexedAt: Date | null;
  jobOffersCount: number;
  applicationsCount: number;
  penaltiesCount: number;
  unpaidPenaltiesCount: number;
};

export type AdminProfilesListResponse = {
  data: AdminProfileListItem[];
  total: number;
  page: number;
  limit: number;
};

/**
 * What kind of thing the bytes are.
 *
 * The admin needs this because the stream route's path has no file extension,
 * so the client cannot guess from a url the way it used to. Derived from the
 * stored key, server-side, where the extension actually is.
 */
export type KycContentKind = 'image' | 'pdf' | 'other';

export type AdminKycDocumentItem = {
  id: string;
  documentType: string | null;
  documentCategory: string;
  /**
   * No url. The document is fetched from
   * `GET /admin/profiles/:id/kyc-documents/:docId/raw`, which streams the bytes
   * behind the admin's session.
   *
   * `documentUrl` used to be here, and was either a signed url that expired
   * within the hour — the bug — or a public url to an identity document that
   * anyone holding the link could read. Neither belongs in a JSON payload.
   */
  fileAvailable: boolean;
  contentKind: KycContentKind;
  verificationStatus: string;
  verifiedAt: Date | null;
  verifiedBy: string | null;
  rejectionReason: string | null;
  createdAt: Date;
};

export type AdminVerificationImageItem = {
  id: string;
  /** Streamed from `.../verification-images/:imageId/raw`. See above. */
  fileAvailable: boolean;
  contentKind: KycContentKind;
  uploadedBy: string | null;
  createdAt: Date;
};

/**
 * Only what the detail view adds on top of the list item.
 *
 * The list now carries the profile's own columns, its trades and its activity
 * counts — the export needed them, and a field declared in both places is a
 * field that can silently disagree between them. What is left here is genuinely
 * detail-only: the KYC evidence, and the single legacy `category_id` that the
 * many-to-many `categories` replaced.
 */
/** Who invited this profile, or null if nobody did. */
export type AdminProfileReferredBy = {
  profileId: string;
  firstName: string;
  lastName: string;
  code: string;
  source: ReferralSource;
  status: ReferralStatus;
  rewardedAt: Date | null;
  referrerAmount: number | null;
  /** Why nothing was paid, when the status says nothing was. */
  settlementNote: string | null;
};

export type AdminProfileDetailResponse = AdminProfileListItem & {
  /**
   * When the bot stops being silent for this profile, or null when it was
   * never paused.
   *
   * A DEADLINE, not a flag: a date in the past means the pause has lapsed and
   * the bot is answering again, so a reader has to compare it with the clock
   * rather than test for its presence.
   */
  botPausedUntil: Date | null;
  /** Legacy single category, superseded by `categoryIds`/`categoryNames`. */
  categoryId: string | null;
  categoryName: string | null;
  kycDocuments: AdminKycDocumentItem[];
  verificationImages: AdminVerificationImageItem[];
  referredBy: AdminProfileReferredBy | null;
  referralsMadeCount: number;
  /**
   * Where a worker stands against the repeated-cancellation suspension:
   * committed cancellations in the current window, out of the threshold.
   * Null for an employer, or when the rule is switched off.
   */
  cancellations: {
    inWindow: number;
    threshold: number;
    windowDays: number;
  } | null;
};

/** The « Entreprise » tab of the admin profile page (getBusinessForAdmin). */
export type AdminBusinessDetail = {
  id: string;
  name: string;
  /** The organisation's logo: the account's own profile picture. */
  logoUrl: string | null;
  category: BusinessCategory;
  categoryLabel: string;
  legalForm: BusinessLegalForm | null;
  legalFormLabel: string | null;
  size: string | null;
  registrationNumber: string | null;
  taxId: string | null;
  statisticalId: string | null;
  address: string;
  countryCode: string | null;
  /** The country's name, from the same list as the public geo API. */
  countryName: string | null;
  city: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  description: string | null;
  verificationStatus: VerificationStatus;
  verifiedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
  /** The current papers; each carries the versions it replaced. */
  documents: (BusinessDocumentView & {
    /** Sent to replace a refused or pending paper. */
    resubmitted: boolean;
    /** What was sent before, newest first — kept for the reviewer. */
    previousVersions: BusinessDocumentView[];
  })[];
  /** « One of » groups the type must provide, and those not yet covered. */
  requiredDocuments: { type: BusinessDocumentType; label: string }[][];
  missingDocuments: { type: BusinessDocumentType; label: string }[][];
};

type BusinessDocumentView = {
  id: string;
  documentType: BusinessDocumentType;
  label: string;
  fileName: string | null;
  mimeType: string | null;
  verificationStatus: VerificationStatus;
  rejectionReason: string | null;
  createdAt: string;
  verifiedAt: string | null;
};

type PrismaTransactionClient = Parameters<
  Parameters<PrismaService['$transaction']>[0]
>[0];

const VERIFICATION_TOKEN_TTL_SECONDS = 1800;

/**
 * Changing the WhatsApp number — the login identity — is a two-step flow.
 *
 * Five minutes, matching the login OTP: long enough to fetch a handset from the
 * next room, short enough that a code glimpsed over a shoulder is stale. The
 * pending change is keyed by profile, so asking again simply replaces it and a
 * user cannot accumulate several live codes for several numbers.
 */
const PHONE_CHANGE_TTL_SECONDS = 300;
const PHONE_CHANGE_KEY_PREFIX = `${REDIS_KEY_PREFIX}profile:phone-change:`;
/** KYC uploads not yet attached to a profile, scored by upload time (#836). */
const KYC_PENDING_UPLOADS = `${REDIS_KEY_PREFIX}kyc:pending-uploads`;
const KYC_PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const KYC_SWEEP_BATCH = 20;

/** The content type of an uploaded KYC object, from the extension its key carries. */
type BusinessDocumentRow = {
  id: string;
  document_type: BusinessDocumentType;
  file_name: string | null;
  mime_type: string | null;
  verification_status: VerificationStatus;
  rejection_reason: string | null;
  created_at: Date;
  verified_at: Date | null;
  replaces_id: string | null;
};

function documentView(d: BusinessDocumentRow): BusinessDocumentView {
  return {
    id: d.id,
    documentType: d.document_type,
    label: BUSINESS_DOCUMENT_LABELS[d.document_type],
    fileName: d.file_name,
    mimeType: d.mime_type,
    verificationStatus: d.verification_status,
    rejectionReason: d.rejection_reason,
    createdAt: d.created_at.toISOString(),
    verifiedAt: d.verified_at?.toISOString() ?? null,
  };
}

/** The chain a paper replaced, newest first (bounded: a cycle cannot loop). */
function previousVersionsOf<T extends BusinessDocumentRow>(
  doc: T,
  byId: Map<string, T>,
): T[] {
  const chain: T[] = [];
  let next = doc.replaces_id ? byId.get(doc.replaces_id) : undefined;
  while (next && chain.length < 50) {
    chain.push(next);
    next = next.replaces_id ? byId.get(next.replaces_id) : undefined;
  }
  return chain;
}

/** Back to « en attente »: the last decision no longer holds. */
function reopenedReview() {
  return {
    verification_status: VerificationStatus.PENDING,
    verified_at: null,
    verified_by: null,
    rejection_reason: null,
  };
}

function mimeTypeOfKey(key: string): string | null {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  return (
    {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      pdf: 'application/pdf',
    }[ext] ?? null
  );
}
const PHONE_CHANGE_SENDS_PREFIX = `${REDIS_KEY_PREFIX}profile:phone-change-sends:`;
const phoneChangeMissKey = (profileId: string) =>
  `${REDIS_KEY_PREFIX}profile:phone-change-misses:${profileId}`;
/**
 * Attempts before the pending change is discarded outright.
 *
 * A six-digit code is one in a million per guess, which is only true while the
 * number of guesses is bounded. Discarding rather than locking keeps the
 * failure recoverable: the user asks for a new code.
 */
const PHONE_CHANGE_MAX_ATTEMPTS = 5;
const VERIFICATION_TOKEN_KEY_PREFIX = `${REDIS_KEY_PREFIX}wa:verify:`;

/** Where the activation message's button lands. `/home` is role-aware. */
const ACTIVATION_LANDING_PATH = 'home';

@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fileService: FileService,
    @Inject(REDIS_CONNECTION)
    private readonly redis: Redis,
    private readonly whatsAppService: WhatsAppService,
    private readonly whatsAppLoginLink: WhatsAppLoginLinkService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
    private readonly layoutService: LayoutService,
    private readonly eventEmitter: EventEmitter2,
    private readonly walletService: WalletService,
    private readonly documentService: DocumentService,
    private readonly matchingService: MatchingService,
    private readonly interestClusters: InterestClusterService,
    private readonly geocodingService: GeocodingService,
    private readonly cache: AdminCacheService,
    private readonly portfolioService: PortfolioService,
    private readonly geo: GeoService,
    private readonly referralService: ReferralService,
    // @Optional() parce que SystemConfigModule est @Global() mais que les specs
    // instancient ProfileService à la main : `kycBucket` retombe alors sur
    // l'env, et lève si celui-ci est vide lui aussi.
    @Optional()
    private readonly systemConfig?: SystemConfigService,
    // Appended, and @Optional() for the same reason as `systemConfig` above:
    // the specs construct this service positionally, so a mid-list parameter
    // shifts every mock after it, and one they do not pass must not be a hard
    // dependency.
    @Optional()
    private readonly whatsAppDocuments?: WhatsAppDocumentService,
    // The window-aware send path, appended and @Optional() for the same
    // positional-spec reason. `notify()` falls back to the template without it.
    @Optional()
    private readonly notificationDispatcher?: NotificationDispatcher,
    // Drop-off tracking: marks the sign-up attempt completed. Appended and
    // @Optional() for the same positional-spec reason.
    @Optional()
    private readonly onboardingAttempts?: OnboardingAttemptService,
  ) {}

  /**
   * Send the cheap way inside the 24h window, the approved way always.
   *
   * Mirrors `BotNotificationService.notify`. The account-state messages here
   * are low volume, but they reach people who are often mid-conversation with
   * the assistant about the very state this announces.
   */
  private async notifyWhatsApp<K extends TemplateKey>(params: {
    phone: string;
    profileId: string;
    key: K;
    params: TemplateParams<K>;
    freeForm: FreeFormMessage;
  }): Promise<boolean> {
    if (!this.notificationDispatcher) {
      return this.whatsAppService.sendTemplateMessage(
        params.phone,
        params.key,
        params.params,
        params.profileId,
      );
    }

    const { sent } = await this.notificationDispatcher.send({
      phone: params.phone,
      profileId: params.profileId,
      template: { key: params.key, params: params.params },
      freeForm: params.freeForm,
    });
    return sent;
  }

  async findById(id: string): Promise<ProfileMeResponse> {
    const profile = await this.prisma.profile.findUnique({
      where: { id },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        phone: true,
        direct_phone: true,
        address: true,
        country_code: true,
        country_name: true,
        city: true,
        description: true,
        profile_type: true,
        status: true,
        verification_status: true,
        rejection_reason: true,
        suspension_reason: true,
        reliability_score: true,
        whatsapp_connected: true,
        avatar_url: true,
        first_login: true,
        created_at: true,
        categories: {
          select: { category: { select: { id: true, name: true } } },
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

    const [unpaidPenaltiesCount, walletBalance] = await Promise.all([
      this.prisma.penalty.count({
        where: { profile_id: id, paid_at: null, deleted_at: null },
      }),
      this.walletService.getProfileWalletBalance(id),
    ]);

    return {
      id: profile.id,
      firstName: profile.first_name,
      lastName: profile.last_name,
      email: profile.email,
      phone: profile.phone,
      directPhone: profile.direct_phone,
      address: profile.address,
      countryCode: profile.country_code,
      countryName: profile.country_name,
      city: profile.city,
      description: profile.description,
      profileType: profile.profile_type,
      status: profile.status,
      verificationStatus: profile.verification_status,
      rejectionReason: profile.rejection_reason,
      suspensionReason: profile.suspension_reason,
      reliabilityScore: profile.reliability_score,
      whatsappConnected: profile.whatsapp_connected,
      avatarUrl: profile.avatar_url,
      firstLogin: profile.first_login,
      createdAt: profile.created_at,
      jobOffersCount: profile._count.job_offers,
      applicationsCount: profile._count.applications,
      penaltiesCount: profile._count.penalties,
      unpaidPenaltiesCount,
      walletBalance,
      categoryIds: profile.categories.map((pc) => pc.category.id),
      categoryNames: profile.categories.map((pc) => pc.category.name),
    };
  }

  async markFirstLoginDone(id: string): Promise<void> {
    await this.prisma.profile.update({
      where: { id },
      data: { first_login: false },
    });
  }

  async updateProfile(
    id: string,
    updateProfileDto: UpdateProfileDto,
  ): Promise<ProfileMeResponse> {
    const existingProfile = await this.prisma.profile.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        first_name: true,
        last_name: true,
        profile_type: true,
        // Needed to detect an address change and trigger a re-geocode.
        address: true,
      },
    });

    if (!existingProfile) {
      throw new NotFoundException('Profil non trouvé');
    }

    const dataToUpdate = this.buildProfileUpdateData(updateProfileDto);

    await this.prisma.$transaction(async (tx) => {
      await tx.profile.update({ where: { id }, data: dataToUpdate });
      if (updateProfileDto.categoryIds !== undefined) {
        await tx.profileCategory.deleteMany({ where: { profile_id: id } });
        if (updateProfileDto.categoryIds.length > 0) {
          await tx.profileCategory.createMany({
            data: updateProfileDto.categoryIds.map((categoryId) => ({
              profile_id: id,
              category_id: categoryId,
            })),
            skipDuplicates: true,
          });
        }
      }
    });

    // Re-geocode when the address actually changed. Coordinates were previously
    // only ever written at profile creation, so anyone who moved kept stale
    // coordinates forever — and every distance-weighted ranking term silently
    // degraded to a neutral value for them.
    if (
      updateProfileDto.address !== undefined &&
      updateProfileDto.address !== existingProfile.address
    ) {
      void this.geocodingService
        .geocode(updateProfileDto.address)
        .then((coords) => {
          if (!coords) return;
          return this.prisma.profile.update({
            where: { id },
            data: { latitude: coords.lat, longitude: coords.lng },
          });
        })
        .catch((err: unknown) =>
          this.logger.warn(
            `re-geocoding failed for profile ${id}`,
            err instanceof Error ? err.message : String(err),
          ),
        );
    }

    // Re-index in Qdrant after update (fire-and-forget)
    if (existingProfile.profile_type === ProfileType.WORKER) {
      this.matchingService
        .indexWorkerProfile(id)
        .catch((err: unknown) =>
          this.logger.warn(
            `indexWorkerProfile failed for id`,
            err instanceof Error ? err.message : String(err),
          ),
        );
    } else {
      this.matchingService
        .indexEmployerProfile(id)
        .catch((err: unknown) =>
          this.logger.warn(
            `indexEmployerProfile failed for id`,
            err instanceof Error ? err.message : String(err),
          ),
        );
    }

    this.eventEmitter.emit(AdminNotificationEvent.PROFILE_UPDATED, {
      event: AdminNotificationEvent.PROFILE_UPDATED,
      title: 'Profil mis à jour',
      message: `${existingProfile.first_name} ${existingProfile.last_name} a mis à jour son profil`,
      entityType: 'profile',
      entityId: String(id),
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`Profile updated successfully: ${id}`);
    return this.findById(id);
  }

  private buildProfileUpdateData(
    dto: UpdateProfileDto,
  ): Prisma.ProfileUpdateInput {
    const data: Prisma.ProfileUpdateInput = {};
    if (dto.firstName !== undefined) data.first_name = dto.firstName;
    if (dto.lastName !== undefined) data.last_name = dto.lastName;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.address !== undefined) data.address = dto.address;
    // Empty string clears it. Unlike the fields above, "no value" is a legitimate
    // state here — most people have only one number — so the user needs a way to
    // remove one they added by mistake.
    if (dto.directPhone !== undefined) {
      data.direct_phone = dto.directPhone || null;
    }
    // Same "absent is legitimate" story as `directPhone`: email is optional at
    // signup, so this is where someone adds one later or drops a stale one. The
    // DTO transform has already lowercased it and mapped "" to null, so an
    // explicit null here is a deliberate clear and `undefined` means untouched.
    if (dto.email !== undefined) {
      data.email = dto.email;
    }
    Object.assign(data, this.geo.resolveLocation(dto));
    return data;
  }

  /**
   * Both variants take the same params, so the union is a single key type and
   * callers pass it straight through to `sendTemplateMessage`.
   */
  private accountActivatedTemplateKey(
    profileType: ProfileType,
  ): 'accountActivatedWorker' | 'accountActivatedEmployer' {
    return profileType === ProfileType.WORKER
      ? 'accountActivatedWorker'
      : 'accountActivatedEmployer';
  }

  private async sendActivationNotification(profileId: string): Promise<void> {
    try {
      const profile = await this.prisma.profile.findUnique({
        where: { id: profileId },
        select: { phone: true, first_name: true, profile_type: true },
      });
      if (!profile?.phone) return;
      await this.notifyWhatsApp({
        phone: profile.phone,
        profileId,
        key: this.accountActivatedTemplateKey(profile.profile_type),
        params: {
          firstName: profile.first_name,
          path: ACTIVATION_LANDING_PATH,
        },
        freeForm: accountActivatedFreeForm({
          firstName: profile.first_name,
          path: ACTIVATION_LANDING_PATH,
          isWorker: profile.profile_type === ProfileType.WORKER,
        }),
      }).catch((err) =>
        this.logger.warn(
          `Failed to send account-activated WhatsApp to ${profile.phone}:`,
          err,
        ),
      );
    } catch (err) {
      this.logger.warn(
        `Failed to send account-activated WhatsApp for profile ${profileId}:`,
        err,
      );
    }
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
      access: 'public',
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
      where: { profile_id: profileId },
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
      jobOfferTitle: p.application?.job_offer?.title ?? null,
    }));
  }

  async markPenaltyPaid(penaltyId: string, profileId: string): Promise<void> {
    const penalty = await this.prisma.penalty.findUnique({
      where: { id: penaltyId },
    });
    if (penalty?.profile_id !== profileId) {
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
        include: { job_offer: true, contract: { select: { id: true } } },
      }),
      this.prisma.application.count({ where: { worker_id: profileId } }),
    ]);
    const data: ProfileApplicationItem[] = applications.map((a) => ({
      id: a.id,
      status: a.status,
      createdAt: a.created_at,
      contractId: a.contract?.id ?? null,
      jobOffer: {
        id: a.job_offer.id,
        title: a.job_offer.title,
        scheduledAt: a.job_offer.scheduled_at,
        employmentType: a.job_offer.employment_type,
        // Number(null) is 0, which reads as "this job pays nothing" rather
        // than "the price is open".
        amount: a.job_offer.amount == null ? null : Number(a.job_offer.amount),
        address: a.job_offer.address,
        // An address alone cannot express a remote job, so the applications
        // list had a blank where the location goes.
        isRemote: a.job_offer.is_remote,
        city: a.job_offer.city,
        countryName: a.job_offer.country_name,
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
        direct_phone: true,
        address: true,
        country_code: true,
        country_name: true,
        city: true,
        latitude: true,
        longitude: true,
        description: true,
        status: true,
        profile_type: true,
        is_business: true,
        whatsapp_connected: true,
        bot_paused_until: true,
        verification_status: true,
        verified_by: true,
        verified_at: true,
        rejection_reason: true,
        kyc_verification_note: true,
        suspension_reason: true,
        suspended_at: true,
        reliability_score: true,
        rating_avg: true,
        rating_count: true,
        billing_status: true,
        first_login: true,
        read_and_approved_policies: true,
        portfolio_slug: true,
        avatar_url: true,
        created_at: true,
        updated_at: true,
        last_login_at: true,
        activated_at: true,
        vector_indexed_at: true,
        category: {
          select: { id: true, name: true },
        },
        categories: {
          select: { category: { select: { id: true, name: true } } },
        },
        kyc_documents: {
          select: {
            id: true,
            document_type: true,
            document_category: true,
            document_url: true,
            storage_key: true,
            verification_status: true,
            verified_at: true,
            verified_by: true,
            rejection_reason: true,
            created_at: true,
          },
          // Category first, so the reviewer always sees front -> back -> selfie.
          // created_at alone cannot order these: all of a profile's rows are
          // inserted in one transaction and share its timestamp. Enum columns
          // sort by declaration order, which is why the migration added
          // DOCUMENT_BACK with `AFTER 'DOCUMENT'` rather than appending it.
          orderBy: [{ document_category: 'asc' }, { created_at: 'asc' }],
        },
        kyc_verification_images: {
          select: {
            id: true,
            image_url: true,
            storage_key: true,
            uploaded_by: true,
            created_at: true,
          },
          orderBy: { created_at: 'asc' },
        },
        // Who invited this profile, straight off the relation. There is no
        // `referred_by_id` column to read instead, on purpose: Referral is the
        // one place that answers this, so the admin view and the payout logic
        // cannot disagree about it.
        referral_received: {
          select: {
            code_used: true,
            source: true,
            status: true,
            rewarded_at: true,
            referrer_amount: true,
            settlement_note: true,
            referrer: {
              select: { id: true, first_name: true, last_name: true },
            },
          },
        },
        _count: {
          select: {
            job_offers: true,
            applications: true,
            penalties: true,
            referrals_made: true,
          },
        },
      },
    });

    if (!profile) {
      throw new NotFoundException('Profil non trouvé');
    }

    const unpaidPenaltiesCount = await this.prisma.penalty.count({
      where: { profile_id: id, paid_at: null, deleted_at: null },
    });
    const cancellations = await this.cancellationStanding(
      id,
      profile.profile_type,
    );

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
      directPhone: profile.direct_phone,
      address: profile.address,
      countryCode: profile.country_code,
      countryName: profile.country_name,
      city: profile.city,
      latitude: profile.latitude,
      longitude: profile.longitude,
      description: profile.description,
      status: profile.status,
      profileType: profile.profile_type,
      isBusiness: profile.is_business,
      whatsappConnected: profile.whatsapp_connected,
      /**
       * When VoVa stops being silent for this profile, or null when it is not
       * paused. An expired deadline reads as "not paused" — the column is only
       * cleared when somebody toggles it off, so the admin UI must judge it
       * against the clock rather than on the field being present.
       */
      botPausedUntil: profile.bot_paused_until,
      verificationStatus: profile.verification_status,
      verifiedBy: profile.verified_by
        ? (verifierNames.get(profile.verified_by) ?? profile.verified_by)
        : null,
      verifiedAt: profile.verified_at,
      rejectionReason: profile.rejection_reason,
      kycVerificationNote: profile.kyc_verification_note,
      suspensionReason: profile.suspension_reason,
      suspendedAt: profile.suspended_at,
      reliabilityScore: profile.reliability_score,
      ratingAvg: profile.rating_avg,
      ratingCount: profile.rating_count,
      billingStatus: profile.billing_status,
      firstLogin: profile.first_login,
      readAndApprovedPolicies: profile.read_and_approved_policies,
      portfolioSlug: profile.portfolio_slug,
      avatarUrl: profile.avatar_url,
      createdAt: profile.created_at,
      updatedAt: profile.updated_at,
      lastLoginAt: profile.last_login_at,
      activatedAt: profile.activated_at,
      vectorIndexedAt: profile.vector_indexed_at,
      categoryId: profile.category?.id ?? null,
      categoryName: profile.category?.name ?? null,
      categoryIds: profile.categories.map((pc) => pc.category.id),
      categoryNames: profile.categories.map((pc) => pc.category.name),
      jobOffersCount: profile._count.job_offers,
      applicationsCount: profile._count.applications,
      penaltiesCount: profile._count.penalties,
      unpaidPenaltiesCount,
      cancellations,
      referralsMadeCount: profile._count.referrals_made,
      referredBy: profile.referral_received
        ? {
            profileId: profile.referral_received.referrer.id,
            firstName: profile.referral_received.referrer.first_name,
            lastName: profile.referral_received.referrer.last_name,
            code: profile.referral_received.code_used,
            source: profile.referral_received.source,
            status: profile.referral_received.status,
            rewardedAt: profile.referral_received.rewarded_at,
            referrerAmount:
              profile.referral_received.referrer_amount === null
                ? null
                : Number(profile.referral_received.referrer_amount),
            settlementNote: profile.referral_received.settlement_note,
          }
        : null,
      // No urls here any more, signed or otherwise. An admin's browser fetches
      // each file from the stream route, authenticated by the session it
      // already has — so nothing in this payload expires, and nothing in it
      // grants access to an identity document to whoever it is forwarded to.
      kycDocuments: profile.kyc_documents.map((doc) => ({
        id: doc.id,
        documentType: doc.document_type,
        documentCategory: doc.document_category,
        fileAvailable: kycFileAvailable(doc.storage_key, doc.document_url),
        contentKind: kycContentKind(doc.storage_key, doc.document_url),
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
        fileAvailable: kycFileAvailable(img.storage_key, img.image_url),
        contentKind: kycContentKind(img.storage_key, img.image_url),
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
    reason: string,
    documents?: { key: string; url?: string }[],
  ): Promise<AdminProfileDetailResponse> {
    const note = reason?.trim();
    if (!note) {
      throw new BadRequestException('La raison / la note est requise');
    }

    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { id: true, profile_type: true },
    });

    if (!profile) {
      throw new NotFoundException('Profil non trouvé');
    }

    // Private, like the KYC documents themselves. These are evidence an admin
    // attaches while reviewing an identity — usually photographs of the very
    // same papers — and they were going to the public bucket under a guessable
    // filename. They are only ever displayed in the admin detail view, so
    // nothing public breaks by moving them.
    const verificationBucket = await kycBucket(
      this.systemConfig,
      this.configService,
    );

    // The bytes are already in the bucket: `uploadVerificationImage` put them
    // there as the admin picked each file, and this call carries only their
    // keys. What is left to do is check that each key is one this profile is
    // allowed to reference and that the object is really there.
    //
    // Deduped first. A double-click that submits the same key twice must not
    // produce two rows pointing at one object.
    const uniqueDocuments = [
      ...new Map((documents ?? []).map((doc) => [doc.key, doc])).values(),
    ];

    // Resolved BEFORE the transaction opens, for the reason
    // `createProfileWithDocuments` spells out: these are network round-trips,
    // and holding a Postgres transaction open across them is how a slow bucket
    // becomes a connection-pool outage.
    //
    // In parallel, unlike the sequential upload loop this replaces — a HEAD is
    // a few hundred bytes and there are at most ten of them.
    //
    // The url each descriptor carries is used only as a derivation fallback
    // inside `resolveVerificationImageKey` and then dropped. Storing it is what
    // left KYC rows holding a dead credential; the key is the durable half, and
    // the stream route reads from it.
    const uploaded = (
      await Promise.all(
        uniqueDocuments.map((doc) =>
          this.resolveVerificationImageKey(profileId, verificationBucket, doc),
        ),
      )
    ).map((key) => ({ key }));

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.profile.update({
        where: { id: profileId },
        data: {
          verification_status: decision,
          verified_by: adminUserId,
          verified_at: now,
          kyc_verification_note: note,
          rejection_reason: decision === 'REJECTED' ? note : null,
          // Passing KYC is the moment the account becomes usable: a verified
          // profile left PENDING_ACTIVATION can do nothing, and every other
          // writer of whatsapp_connected flips status with it.
          ...(decision === 'VERIFIED'
            ? { whatsapp_connected: true, status: AccountStatus.ACTIVE }
            : {}),
        },
      }),

      this.prisma.kycDocument.updateMany({
        where: { profile_id: profileId },
        data: {
          verification_status: decision,
          verified_by: adminUserId,
          verified_at: now,
          rejection_reason: decision === 'REJECTED' ? note : null,
        },
      }),

      this.prisma.kycVerificationImage.deleteMany({
        where: { profile_id: profileId },
      }),

      ...uploaded.map(({ key }) =>
        this.prisma.kycVerificationImage.create({
          data: {
            profile_id: profileId,
            image_url: kycObjectRef(verificationBucket, key),
            storage_key: key,
            uploaded_by: adminUserId === 'system' ? null : adminUserId,
          },
        }),
      ),
    ]);

    const kycProfile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { first_name: true, last_name: true },
    });

    this.eventEmitter.emit(AdminNotificationEvent.PROFILE_KYC_VERIFIED, {
      event: AdminNotificationEvent.PROFILE_KYC_VERIFIED,
      title: 'KYC vérifié',
      message: `KYC de ${kycProfile?.first_name ?? ''} ${kycProfile?.last_name ?? ''} : ${decision}`,
      entityType: 'profile',
      entityId: String(profileId),
      timestamp: new Date().toISOString(),
    });

    if (decision === 'VERIFIED') {
      // Seed interest vector so first recommendation isn't cold-start
      void this.interestClusters.ensureSeeded(profileId).catch((err) => {
        this.logger.warn(
          `Interest vector reseed failed for profile=${profileId}`,
          err,
        );
      });

      // Grant welcome credit (idempotent — no-op if already granted)
      void this.walletService
        .grantWelcomeCredit(profileId, profile.profile_type)
        .catch((err) => {
          this.logger.warn(
            `Welcome credit grant failed for profile=${profileId}`,
            err,
          );
        });

      // Pay out any parrainage that has been waiting on this KYC. A filleul
      // who paid while their parrain was still in the review queue leaves the
      // referral QUALIFIED_ON_HOLD; this is the trigger that releases it, which
      // is why holding costs no scheduler of its own.
      void this.referralService
        .settleHeldForReferrer(profileId)
        .catch((err) => {
          this.logger.warn(
            `Held referral settlement failed for referrer=${profileId}`,
            err,
          );
        });
    }

    return this.getProfileDetailForAdmin(profileId);
  }

  /** See `AdminProfileDetailResponse.cancellations`. */
  private async cancellationStanding(
    profileId: string,
    profileType: ProfileType,
  ): Promise<AdminProfileDetailResponse['cancellations']> {
    if (profileType !== ProfileType.WORKER || !this.systemConfig) return null;
    const fees = await this.systemConfig.getFees();
    const threshold = Number(fees.cancellationSuspensionCount);
    const windowDays = Number(fees.cancellationSuspensionWindowDays);
    if (!(threshold > 0) || !(windowDays > 0)) return null;
    return {
      inWindow: await countCountedCancellations(
        this.prisma,
        profileId,
        windowDays,
      ),
      threshold,
      windowDays,
    };
  }

  async updateProfileStatusByAdmin(
    profileId: string,
    status: AccountStatus,
    reason?: string,
  ): Promise<AdminProfileDetailResponse> {
    const trimmedReason = reason?.trim() || null;

    // Suspending someone without saying why is what this whole path exists to
    // stop: the notification then reads "your account was suspended" and the
    // user has nothing to act on. The admin UI already requires it client-side.
    if (status === AccountStatus.SUSPENDED && !trimmedReason) {
      throw new BadRequestException('La raison de la suspension est requise');
    }

    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        id: true,
        status: true,
        phone: true,
        email: true,
        first_name: true,
        profile_type: true,
      },
    });
    if (!profile) {
      throw new NotFoundException('Profil non trouvé');
    }

    const becomingSuspended =
      profile.status !== AccountStatus.SUSPENDED &&
      status === AccountStatus.SUSPENDED;
    const leavingSuspended =
      profile.status === AccountStatus.SUSPENDED &&
      status !== AccountStatus.SUSPENDED;

    await this.prisma.profile.update({
      where: { id: profileId },
      data: {
        status,
        // The stored reason describes the CURRENT suspension. Leaving it behind
        // on reactivation would show a stale motive next to an active account.
        ...(becomingSuspended
          ? {
              suspension_reason: trimmedReason,
              suspended_at: new Date(),
              suspension_source: SuspensionSource.ADMIN,
            }
          : {}),
        ...(leavingSuspended
          ? {
              suspension_reason: null,
              suspended_at: null,
              suspension_source: null,
            }
          : {}),
      },
    });

    this.eventEmitter.emit(AdminNotificationEvent.PROFILE_STATUS_CHANGED, {
      event: AdminNotificationEvent.PROFILE_STATUS_CHANGED,
      title: 'Statut profil modifié',
      message: `${profile.first_name} — statut changé en ${status}`,
      entityType: 'profile',
      entityId: String(profileId),
      timestamp: new Date().toISOString(),
    });

    if (
      profile.status !== AccountStatus.ACTIVE &&
      status === AccountStatus.ACTIVE
    ) {
      try {
        if (profile.phone) {
          await this.notifyWhatsApp({
            phone: profile.phone,
            profileId,
            key: this.accountActivatedTemplateKey(profile.profile_type),
            params: {
              firstName: profile.first_name,
              path: ACTIVATION_LANDING_PATH,
            },
            freeForm: accountActivatedFreeForm({
              firstName: profile.first_name,
              path: ACTIVATION_LANDING_PATH,
              isWorker: profile.profile_type === ProfileType.WORKER,
            }),
          });
        }
      } catch {
        this.logger.warn(
          `Failed to send activation message for profile ${profileId}`,
        );
      }

      this.walletService
        .grantWelcomeCredit(profileId, profile.profile_type)
        .catch(() => {
          this.logger.warn(
            `Failed to grant welcome credit for profile ${profileId}`,
          );
        });

      // An account coming back from SUSPENDED becomes an eligible parrain
      // again, so anything held while it was suspended settles here.
      void this.referralService.settleHeldForReferrer(profileId).catch(() => {
        this.logger.warn(
          `Held referral settlement failed for referrer=${profileId}`,
        );
      });
    }

    if (becomingSuspended) {
      await this.notifySuspended(profile, trimmedReason);
    }

    return this.getProfileDetailForAdmin(profileId);
  }

  /**
   * A rule suspended this account (repeated cancellations, …): tell the person
   * exactly as an admin suspension does. Never throws — the suspension is
   * already committed.
   */
  @OnEvent(PROFILE_AUTO_SUSPENDED_EVENT, { async: true })
  async onAutoSuspended(payload: ProfileAutoSuspendedPayload): Promise<void> {
    try {
      const profile = await this.prisma.profile.findUnique({
        where: { id: payload.profileId },
        select: { id: true, phone: true, email: true, first_name: true },
      });
      if (profile) await this.notifySuspended(profile, payload.reason);
    } catch {
      this.logger.warn(
        `Failed to notify automatic suspension for profile ${payload.profileId}`,
      );
    }
  }

  /** E-mail and WhatsApp the person that their account was suspended, and why. */
  private async notifySuspended(
    profile: {
      id: string;
      phone: string | null;
      email: string | null;
      first_name: string;
    },
    reason: string | null,
  ): Promise<void> {
    const profileId = profile.id;
    notifyProfile(this.eventEmitter, {
      recipientId: profileId,
      input: { type: 'ACCOUNT_SUSPENDED', reason },
    });
    try {
      if (profile.email) {
        await this.mailService.sendMail({
          to: profile.email,
          subject: 'Votre compte a été suspendu',
          html: await this.layoutService.wrap(
            accountSuspendedEmail(profile.first_name, reason ?? undefined),
          ),
        });
      }
    } catch {
      this.logger.warn(
        `Failed to send suspension email for profile ${profileId}`,
      );
    }

    // WhatsApp as well as email. Both fields are required on a profile, so
    // this is not about reachability — it is about which channel is read.
    // WhatsApp is where this user base actually is; an email announcing a
    // suspension can sit unopened for days.
    try {
      if (profile.phone) {
        // Minted here, not by the outbound processor: this send goes
        // straight to the provider and never enters the queue, so nothing
        // else would fill the CTA's variable. A null code degrades to the
        // bare path — the button then lands on the login screen instead of
        // deep-linking, which beats a dead link.
        const loginCode = await this.whatsAppLoginLink
          .mint(profileId, SUSPENDED_CTA_PATH)
          .catch(() => null);

        await this.notifyWhatsApp({
          phone: profile.phone,
          profileId,
          key: 'accountSuspended',
          params: {
            firstName: profile.first_name,
            reason,
            loginCode,
          },
          freeForm: accountSuspendedFreeForm({
            firstName: profile.first_name,
            reason: reason || 'Non précisé',
          }),
        });
      }
    } catch {
      this.logger.warn(
        `Failed to send suspension WhatsApp message for profile ${profileId}`,
      );
    }
  }

  async updateProfileByAdmin(
    profileId: string,
    dto: AdminUpdateProfileDto,
  ): Promise<AdminProfileDetailResponse> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        profile_type: true,
        is_business: true,
      },
    });
    if (!profile) {
      throw new NotFoundException('Profil non trouvé');
    }
    // A business stays an employer: refused here in words, before the
    // database's CHECK refuses it with a 500.
    assertBusinessIsEmployer(
      dto.profileType ?? profile.profile_type,
      profile.is_business,
    );

    try {
      await this.prisma.profile.update({
        where: { id: profileId },
        data: this.buildAdminProfileUpdateData(dto),
      });
    } catch (err) {
      this.throwIfUniqueConstraintViolation(err);
      throw err;
    }

    // Re-index in Qdrant after update (fire-and-forget). If the profile type
    // changed, the point must move collections: drop it from the OLD collection
    // first, then index into the NEW one — otherwise a stale worker/employer
    // point lingers and keeps matching.
    const oldType = profile.profile_type;
    const newType = dto.profileType ?? oldType;
    if (newType !== oldType) {
      const removeFromOld =
        oldType === ProfileType.WORKER
          ? this.matchingService.deleteWorkerFromIndex(profileId)
          : this.matchingService.deleteEmployerFromIndex(profileId);
      removeFromOld.catch((err: unknown) =>
        this.logger.warn(
          `Removing profile from old ${oldType} index failed`,
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
    if (newType === ProfileType.WORKER) {
      this.matchingService
        .indexWorkerProfile(profileId)
        .catch((err: unknown) =>
          this.logger.warn(
            `indexWorkerProfile failed for profileId`,
            err instanceof Error ? err.message : String(err),
          ),
        );
    } else {
      this.matchingService
        .indexEmployerProfile(profileId)
        .catch((err: unknown) =>
          this.logger.warn(
            `indexEmployerProfile failed for profileId`,
            err instanceof Error ? err.message : String(err),
          ),
        );
    }

    this.eventEmitter.emit(AdminNotificationEvent.PROFILE_UPDATED, {
      event: AdminNotificationEvent.PROFILE_UPDATED,
      title: 'Profil mis à jour par admin',
      message: `${profile.first_name} ${profile.last_name} — mis à jour par un administrateur`,
      entityType: 'profile',
      entityId: String(profileId),
      timestamp: new Date().toISOString(),
    });

    return this.getProfileDetailForAdmin(profileId);
  }

  private buildAdminProfileUpdateData(
    dto: AdminUpdateProfileDto,
  ): Prisma.ProfileUpdateInput {
    const data: Prisma.ProfileUpdateInput = {};
    if (dto.firstName !== undefined) data.first_name = dto.firstName;
    if (dto.lastName !== undefined) data.last_name = dto.lastName;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.phone !== undefined) data.phone = dto.phone;
    // Empty string clears it, unlike `phone` above, which has no "absent"
    // state — a profile always has a WhatsApp number, and most have no second.
    if (dto.directPhone !== undefined) {
      data.direct_phone = dto.directPhone.trim() || null;
    }
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.profileType !== undefined) data.profile_type = dto.profileType;
    Object.assign(data, this.geo.resolveLocation(dto));
    return data;
  }

  private throwIfUniqueConstraintViolation(err: unknown): void {
    if (
      !(err instanceof Prisma.PrismaClientKnownRequestError) ||
      err.code !== 'P2002'
    ) {
      return;
    }
    const fieldLabels: Record<string, string> = {
      phone: 'numéro de téléphone',
      email: 'adresse email',
    };
    const raw = err.meta?.target;
    let fields: string[];
    if (Array.isArray(raw)) {
      fields = raw as string[];
    } else if (typeof raw === 'string') {
      fields = [raw.replace(/^Profile_/, '').replace(/_key$/, '')];
    } else {
      fields = [];
    }
    const label = fields.map((f) => fieldLabels[f] ?? f).join(', ') || 'champ';
    throw new ConflictException(
      `Ce ${label} est déjà utilisé par un autre profil.`,
    );
  }

  async getProfilesForAdmin(params: {
    page: number;
    limit: number;
    q?: string;
    status?: AccountStatus[];
    profileType?: ProfileType[];
    whatsappConnected?: boolean;
    verificationStatus?: VerificationStatus[];
    deleted?: boolean;
  }): Promise<AdminProfilesListResponse> {
    return this.cache.wrap(
      this.cache.listKey('profiles', params),
      ADMIN_LIST_TTL_SECONDS,
      () => this.loadGetProfilesForAdmin(params),
    );
  }

  private async loadGetProfilesForAdmin(params: {
    page: number;
    limit: number;
    q?: string;
    status?: AccountStatus[];
    profileType?: ProfileType[];
    whatsappConnected?: boolean;
    verificationStatus?: VerificationStatus[];
    deleted?: boolean;
  }): Promise<AdminProfilesListResponse> {
    const {
      page,
      limit,
      q,
      status,
      profileType,
      whatsappConnected,
      verificationStatus,
      deleted,
    } = params;
    const skip = (page - 1) * limit;

    // Active rows by default; the admin "Deleted" filter flips to archived rows.
    const where: Prisma.ProfileWhereInput = {
      deleted_at: deletedAtFilter(deleted),
    };

    const searchTrimmed = q?.trim() ?? '';
    if (searchTrimmed.length > 0) {
      const parts = searchTrimmed.split(/\s+/).filter(Boolean);
      const orClauses: Prisma.ProfileWhereInput[] = [
        { first_name: { contains: searchTrimmed, mode: 'insensitive' } },
        { last_name: { contains: searchTrimmed, mode: 'insensitive' } },
        { email: { contains: searchTrimmed, mode: 'insensitive' } },
        { phone: { contains: searchTrimmed, mode: 'insensitive' } },
      ];
      // "Alice Dupont" → match first_name=Alice AND last_name=Dupont, or vice-versa
      if (parts.length >= 2) {
        orClauses.push(
          {
            AND: [
              { first_name: { contains: parts[0], mode: 'insensitive' } },
              {
                last_name: {
                  contains: parts.slice(1).join(' '),
                  mode: 'insensitive',
                },
              },
            ],
          },
          {
            AND: [
              {
                first_name: {
                  contains: parts.slice(1).join(' '),
                  mode: 'insensitive',
                },
              },
              { last_name: { contains: parts[0], mode: 'insensitive' } },
            ],
          },
        );
      }
      where.OR = orClauses;
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
          country_code: true,
          country_name: true,
          city: true,
          latitude: true,
          longitude: true,
          description: true,
          status: true,
          profile_type: true,
          is_business: true,
          whatsapp_connected: true,
          verification_status: true,
          verified_by: true,
          verified_at: true,
          rejection_reason: true,
          kyc_verification_note: true,
          reliability_score: true,
          rating_avg: true,
          rating_count: true,
          billing_status: true,
          suspension_reason: true,
          suspended_at: true,
          last_login_at: true,
          activated_at: true,
          first_login: true,
          read_and_approved_policies: true,
          portfolio_slug: true,
          vector_indexed_at: true,
          avatar_url: true,
          created_at: true,
          updated_at: true,
          categories: {
            select: { category: { select: { id: true, name: true } } },
          },
          // Subselects on the same query rather than a count per row — the
          // export pulls whole pages at a time, and a per-profile round trip
          // would turn one export into thousands of queries.
          _count: {
            select: {
              job_offers: true,
              applications: true,
              penalties: true,
            },
          },
        },
      }),
      this.prisma.profile.count({ where }),
    ]);

    // `_count` cannot express "penalties that are unpaid", so the one filtered
    // count is a single grouped query over the page rather than one per profile.
    const unpaidByProfile = new Map<string, number>();
    if (profiles.length > 0) {
      const grouped = await this.prisma.penalty.groupBy({
        by: ['profile_id'],
        where: {
          profile_id: { in: profiles.map((p) => p.id) },
          paid_at: null,
          deleted_at: null,
        },
        _count: { _all: true },
      });
      for (const row of grouped) {
        unpaidByProfile.set(row.profile_id, row._count._all);
      }
    }

    const data: AdminProfileListItem[] = profiles.map((p) => ({
      id: p.id,
      firstName: p.first_name,
      lastName: p.last_name,
      email: p.email,
      phone: p.phone,
      address: p.address,
      countryCode: p.country_code,
      countryName: p.country_name,
      city: p.city,
      description: p.description,
      status: p.status,
      profileType: p.profile_type,
      isBusiness: p.is_business,
      whatsappConnected: p.whatsapp_connected,
      verificationStatus: p.verification_status,
      verifiedBy: p.verified_by,
      verifiedAt: p.verified_at,
      rejectionReason: p.rejection_reason,
      kycVerificationNote: p.kyc_verification_note,
      reliabilityScore: p.reliability_score,
      avatarUrl: p.avatar_url,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      latitude: p.latitude,
      longitude: p.longitude,
      categoryIds: p.categories.map((pc) => pc.category.id),
      categoryNames: p.categories.map((pc) => pc.category.name),
      ratingAvg: p.rating_avg,
      ratingCount: p.rating_count,
      billingStatus: p.billing_status,
      suspensionReason: p.suspension_reason,
      suspendedAt: p.suspended_at,
      lastLoginAt: p.last_login_at,
      activatedAt: p.activated_at,
      firstLogin: p.first_login,
      readAndApprovedPolicies: p.read_and_approved_policies,
      portfolioSlug: p.portfolio_slug,
      vectorIndexedAt: p.vector_indexed_at,
      jobOffersCount: p._count.job_offers,
      applicationsCount: p._count.applications,
      penaltiesCount: p._count.penalties,
      unpaidPenaltiesCount: unpaidByProfile.get(p.id) ?? 0,
    }));

    return { data, total, page, limit };
  }

  /** Lets a restored profile's sessions through again — see bulkSoftDeleteProfiles. */
  async clearArchivedSessions(ids: string[]): Promise<void> {
    await markProfilesArchived(this.redis, ids, false);
  }

  /** When each of these profiles was archived; read BEFORE restoring them. */
  async archivedAt(ids: string[]): Promise<{ id: string; at: Date }[]> {
    const rows = await this.prisma.profile.findMany({
      where: { id: { in: ids }, deleted_at: { not: null } },
      select: { id: true, deleted_at: true },
    });
    return rows.map((r) => ({ id: r.id, at: r.deleted_at as Date }));
  }

  /** What went with them comes back with them — see PROFILES_ARCHIVED. */
  announceRestored(restored: { id: string; at: Date }[]): void {
    if (restored.length === 0) return;
    this.eventEmitter.emit(PROFILES_RESTORED, {
      restored,
    } satisfies ProfilesRestoredEvent);
  }

  /** Archive many profiles at once (admin bulk delete). Returns the count archived. */
  async bulkSoftDeleteProfiles(ids: string[]): Promise<{ count: number }> {
    if (ids.length === 0) return { count: 0 };
    const at = new Date();
    const { count } = await this.prisma.profile.updateMany({
      where: { id: { in: ids }, deleted_at: null },
      data: { deleted_at: at },
    });
    await this.cache.invalidate('profiles');
    // An archived employer's open offers go with it (pentest A2-F14, #870).
    this.eventEmitter.emit(PROFILES_ARCHIVED, {
      ids,
      at,
    } satisfies ProfilesArchivedEvent);
    // Ends their open sessions on the next request (#878), and their open
    // sockets now (#864).
    await markProfilesArchived(this.redis, ids, true);
    for (const id of ids) {
      this.eventEmitter.emit(SESSION_ENDED, {
        kind: 'profile',
        id,
      } satisfies SessionEndedEvent);
    }
    return { count };
  }

  /**
   * `entry` is what the signup token proved (ProfileController reads it):
   * 'business' for an email-verified sign-up, which creates the organisation
   * with the profile.
   */
  async createProfile(
    createProfileDto: CreateProfileDto,
    entry: SignupIdentity['entry'] = 'whatsapp',
  ): Promise<{
    message: string;
    profileId: string;
    profileType: ProfileType;
    creditedBalance: number;
  }> {
    try {
      const profile = await this.createProfileWithDocuments(
        createProfileDto,
        entry,
      );

      this.logger.log(`Profile created successfully: ${profile.id}`);
      // The sign-up attempt is done. Not awaited, never throws. A business's
      // attempt is keyed by the email it proved.
      void this.onboardingAttempts?.completed(
        entry === 'business' && createProfileDto.email
          ? createProfileDto.email
          : createProfileDto.phone,
        profile.id,
      );

      // Give every worker a public portfolio URL from day one. The slug used to
      // be minted only on the first realization upload, so a worker who had not
      // uploaded anything had no `/p/<slug>` — and an employer browsing them saw
      // no "Voir le portfolio" at all. The workers most in need of a shopfront
      // were the ones without one.
      //
      // After the transaction, not inside it: ensurePortfolioSlug retries on
      // unique collisions, and a slug that could not be minted must never roll
      // back a completed signup.
      if (createProfileDto.profileType === ProfileType.WORKER) {
        await this.portfolioService
          .ensurePortfolioSlug(profile.id)
          .catch((err) =>
            this.logger.warn(
              `Portfolio slug not minted for profile=${profile.id}; it will be minted on first view`,
              err,
            ),
          );
      }

      // Grant registration welcome credit via the idempotent path so the
      // KYC-verified flow (which also calls grantWelcomeCredit) cannot
      // double-credit the same profile.
      const creditedBalance = await this.walletService
        .grantWelcomeCredit(profile.id, createProfileDto.profileType)
        .catch((err) => {
          this.logger.warn(
            `Welcome credit grant failed for profile=${profile.id}`,
            err,
          );
          return 0;
        });

      // Record who invited this profile. Credits nothing — the parrainage pays
      // out when this user first pays by mobile money for a connection.
      //
      // After the transaction and swallowed on failure, for the same reason the
      // portfolio slug above is: an unknown code, a self-referral or a dropped
      // connection must never roll back a completed signup.
      if (createProfileDto.referralCode) {
        await this.referralService
          .recordReferral({
            refereeId: profile.id,
            code: createProfileDto.referralCode,
            source:
              createProfileDto.referralSource ?? ReferralSource.MANUAL_CODE,
          })
          .catch((err) =>
            this.logger.warn(
              `Referral not recorded for profile=${profile.id}`,
              err,
            ),
          );
      }

      // Geocode address asynchronously (fire-and-forget)
      this.geocodingService
        .geocode(createProfileDto.address)
        .then((coords) => {
          if (!coords) return;
          return this.prisma.profile.update({
            where: { id: profile.id },
            data: { latitude: coords.lat, longitude: coords.lng },
          });
        })
        .catch((err: unknown) =>
          this.logger.warn(
            `geocoding failed for profile ${profile.id}`,
            err instanceof Error ? err.message : String(err),
          ),
        );

      // Index profile asynchronously (fire-and-forget, gated by feature flag)
      if (createProfileDto.profileType === 'WORKER') {
        this.matchingService
          .indexWorkerProfile(profile.id)
          .catch((err: unknown) =>
            this.logger.warn(
              `indexWorkerProfile failed for profile.id`,
              err instanceof Error ? err.message : String(err),
            ),
          );
      } else {
        this.matchingService
          .indexEmployerProfile(profile.id)
          .catch((err: unknown) =>
            this.logger.warn(
              `indexEmployerProfile failed for profile.id`,
              err instanceof Error ? err.message : String(err),
            ),
          );
      }

      this.eventEmitter.emit(AdminNotificationEvent.PROFILE_CREATED, {
        event: AdminNotificationEvent.PROFILE_CREATED,
        title: 'Nouveau profil',
        message: `Nouveau profil créé : ${createProfileDto.firstName} ${createProfileDto.lastName}`,
        entityType: 'profile',
        entityId: String(profile.id),
        timestamp: new Date().toISOString(),
      });

      return {
        message: 'Profil créé avec succès',
        profileId: profile.id,
        profileType: createProfileDto.profileType,
        creditedBalance,
      };
    } catch (error: any) {
      this.handleCreateProfileError(error);
    }
  }

  /**
   * Where one KYC row's bytes actually live: a bucket and a key, or null when
   * the row points at nothing readable.
   *
   * Two shapes have to resolve here. A row written since the key was derived
   * server-side carries `storage_key` and lives in the private bucket. A row
   * written before that carries no key at all, only a legacy PUBLIC url — and
   * that url is enough, because `deriveKey` reconstructs the key from it and
   * the object is still in the public bucket until the backfill moves it.
   *
   * Reading the legacy case out of the url rather than fetching the url means
   * the stream route works on untouched production data, so it can ship
   * without waiting on the backfill, and it does it without the server ever
   * making an outbound request to a url held in a database column.
   */
  private async resolveKycStorage(
    storageKey: string | null,
    storedUrl: string | null,
  ): Promise<{ bucket: string; key: string } | null> {
    if (storageKey) {
      return {
        bucket: await kycBucket(this.systemConfig, this.configService),
        key: storageKey,
      };
    }

    const legacy = legacyKycUrl(storedUrl);
    if (!legacy) return null;

    const { publicBaseUrl, buckets } = await storageNames(
      this.systemConfig,
      this.configService,
    );
    const derived = deriveKey(legacy, publicBaseUrl, buckets);
    if (!derived || !isKycKey(derived.key)) return null;

    const [publicBucket] = buckets;
    const bucket = derived.bucket || publicBucket;
    if (!bucket) return null;

    return { bucket, key: derived.key };
  }

  /**
   * One KYC document's bytes, for an admin who is allowed to see them.
   *
   * `profileId` is part of the lookup rather than checked afterwards: a
   * document id that belongs to another profile simply does not match, so the
   * route cannot be walked sideways by swapping one id.
   */
  async streamKycDocument(
    profileId: string,
    documentId: string,
  ): Promise<DownloadResult & { filename: string }> {
    const doc = await this.prisma.kycDocument.findFirst({
      where: { id: documentId, profile_id: profileId },
      select: {
        storage_key: true,
        document_url: true,
        document_category: true,
      },
    });

    if (!doc) {
      throw new NotFoundException('Document introuvable.');
    }

    return this.streamKycObject(
      doc.storage_key,
      doc.document_url,
      doc.document_category,
    );
  }

  /**
   * The organisation behind a business profile, for the admin's « Entreprise »
   * tab: its details, its documents (bytes behind `streamBusinessDocument`,
   * never a url), and which required papers are still missing for its type.
   */
  async getBusinessForAdmin(profileId: string): Promise<AdminBusinessDetail> {
    const business = await this.prisma.business.findUnique({
      where: { profile_id: profileId },
      include: {
        documents: { orderBy: { created_at: 'asc' } },
        profile: { select: { avatar_url: true } },
      },
    });
    if (!business) {
      throw new NotFoundException("Ce profil n'a pas d'organisation.");
    }
    const requirement = DOCUMENTS_BY_CATEGORY[business.category];
    const current = business.documents.filter((d) => !d.superseded_at);
    const byId = new Map(business.documents.map((d) => [d.id, d]));
    return {
      id: business.id,
      name: business.name,
      logoUrl: business.profile.avatar_url,
      category: business.category,
      categoryLabel: BUSINESS_CATEGORY_LABELS[business.category],
      legalForm: business.legal_form,
      legalFormLabel: business.legal_form
        ? BUSINESS_LEGAL_FORM_LABELS[business.legal_form]
        : null,
      size: business.size,
      registrationNumber: business.registration_number,
      taxId: business.tax_id,
      statisticalId: business.statistical_id,
      address: business.address,
      countryCode: business.country_code,
      countryName: this.geo.findCountry(business.country_code)?.name ?? null,
      city: business.city,
      email: business.email,
      phone: business.phone,
      website: business.website,
      description: business.description,
      verificationStatus: business.verification_status,
      verifiedAt: business.verified_at?.toISOString() ?? null,
      rejectionReason: business.rejection_reason,
      createdAt: business.created_at.toISOString(),
      // A replacement keeps the place of the paper it replaced: ordered by
      // when the first version was sent.
      documents: current
        .map((d) => ({ doc: d, previous: previousVersionsOf(d, byId) }))
        .sort(
          (a, b) =>
            (a.previous.at(-1) ?? a.doc).created_at.getTime() -
            (b.previous.at(-1) ?? b.doc).created_at.getTime(),
        )
        .map(({ doc, previous }) => ({
          ...documentView(doc),
          resubmitted: doc.replaces_id !== null,
          previousVersions: previous.map(documentView),
        })),
      requiredDocuments: requirement.required.map((group) =>
        group.map((t) => ({ type: t, label: BUSINESS_DOCUMENT_LABELS[t] })),
      ),
      missingDocuments: missingRequiredDocuments(
        business.category,
        current.map((d) => d.document_type),
      ).map((group) =>
        group.map((t) => ({ type: t, label: BUSINESS_DOCUMENT_LABELS[t] })),
      ),
    };
  }

  /** One business document's bytes, behind the admin session, like KYC. */
  async streamBusinessDocument(
    profileId: string,
    documentId: string,
  ): Promise<DownloadResult & { filename: string }> {
    const doc = await this.prisma.businessDocument.findFirst({
      where: { id: documentId, business: { profile_id: profileId } },
      select: { storage_key: true, document_type: true },
    });
    if (!doc) {
      throw new NotFoundException('Document introuvable.');
    }
    return this.streamKycObject(
      doc.storage_key,
      null,
      doc.document_type.toLowerCase(),
    );
  }

  /** One document accepted or refused, on its own (the business is decided apart). */
  async verifyBusinessDocument(
    profileId: string,
    documentId: string,
    adminUserId: string,
    decision: 'VERIFIED' | 'REJECTED',
    reason?: string,
  ): Promise<AdminBusinessDetail> {
    const note = reason?.trim() || null;
    if (decision === 'REJECTED' && !note) {
      throw new BadRequestException('Indiquez le motif du refus.');
    }
    const { count } = await this.prisma.businessDocument.updateMany({
      // A superseded version is history: only the current paper is decided.
      where: {
        id: documentId,
        superseded_at: null,
        business: { profile_id: profileId },
      },
      data: {
        verification_status: decision,
        verified_by: adminUserId === 'system' ? null : adminUserId,
        verified_at: new Date(),
        rejection_reason: decision === 'REJECTED' ? note : null,
      },
    });
    if (count === 0) {
      throw new NotFoundException('Document introuvable.');
    }
    return this.getBusinessForAdmin(profileId);
  }

  /**
   * The business review's decision. A business has no personal KYC (product
   * decision): approving its organisation is what verifies and activates the
   * account — the same VERIFIED + ACTIVE transition KYC approval makes, so
   * every existing guard (KycVerifiedGuard, ActiveProfileGuard) just works.
   *
   * Unlike KYC, `whatsapp_connected` is left alone: the business phone was
   * never verified, and business accounts get no WhatsApp at all.
   */
  async verifyBusiness(
    profileId: string,
    adminUserId: string,
    decision: 'VERIFIED' | 'REJECTED',
    reason?: string,
  ): Promise<AdminBusinessDetail> {
    const note = reason?.trim() || null;
    if (decision === 'REJECTED' && !note) {
      throw new BadRequestException('Indiquez le motif du refus.');
    }
    const business = await this.prisma.business.findUnique({
      where: { profile_id: profileId },
      select: { id: true, profile: { select: { profile_type: true } } },
    });
    if (!business) {
      throw new NotFoundException("Ce profil n'a pas d'organisation.");
    }

    const now = new Date();
    const by = adminUserId === 'system' ? null : adminUserId;
    await this.prisma.$transaction([
      this.prisma.business.update({
        where: { id: business.id },
        data: {
          verification_status: decision,
          verified_at: now,
          verified_by: by,
          rejection_reason: decision === 'REJECTED' ? note : null,
        },
      }),
      // Approving the business approves its papers still waiting; a paper
      // already refused on its own stays refused.
      ...(decision === 'VERIFIED'
        ? [
            this.prisma.businessDocument.updateMany({
              where: {
                business_id: business.id,
                verification_status: 'PENDING',
                superseded_at: null,
              },
              data: {
                verification_status: 'VERIFIED',
                verified_at: now,
                verified_by: by,
              },
            }),
          ]
        : []),
      this.prisma.profile.update({
        where: { id: profileId },
        data: {
          verification_status: decision,
          verified_by: adminUserId,
          verified_at: now,
          kyc_verification_note: note,
          rejection_reason: decision === 'REJECTED' ? note : null,
          ...(decision === 'VERIFIED' ? { status: AccountStatus.ACTIVE } : {}),
        },
      }),
    ]);

    this.eventEmitter.emit(AdminNotificationEvent.PROFILE_KYC_VERIFIED, {
      event: AdminNotificationEvent.PROFILE_KYC_VERIFIED,
      title: 'Organisation vérifiée',
      message: `Organisation du profil ${profileId} : ${decision}`,
      entityType: 'profile',
      entityId: String(profileId),
      timestamp: now.toISOString(),
    });

    if (decision === 'VERIFIED') {
      // Idempotent, as on the KYC path: no double credit.
      void this.walletService
        .grantWelcomeCredit(profileId, business.profile.profile_type)
        .catch((err) =>
          this.logger.warn(
            `Welcome credit grant failed for profile=${profileId}`,
            err,
          ),
        );
    }

    return this.getBusinessForAdmin(profileId);
  }

  /**
   * Edits an organisation. By the business itself (`by: 'owner'`), changing
   * what the review checked (name, type, legal form, RCCM, NIU, SCIEN) sends
   * it back to review — a verified business would otherwise rename itself
   * after the check. An admin's correction (`by: 'admin'`) is the review, and
   * reopens nothing. Contact details never do.
   */
  async updateBusiness(
    profileId: string,
    dto: UpdateBusinessDto,
    by: 'owner' | 'admin',
  ): Promise<{ business: AdminBusinessDetail; reopened: boolean }> {
    const business = await this.prisma.business.findUnique({
      where: { profile_id: profileId },
    });
    if (!business || business.deleted_at) {
      throw new NotFoundException("Ce profil n'a pas d'organisation.");
    }

    const category = dto.category ?? business.category;
    const legalForm = legalFormAfterEdit(category, business.legal_form, dto);
    const changed = changedReviewedFields(
      {
        name: business.name,
        category: business.category,
        legalForm: business.legal_form,
        registrationNumber: business.registration_number,
        taxId: business.tax_id,
        statisticalId: business.statistical_id,
      },
      { ...dto, legalForm },
    );
    const reopened =
      by === 'owner' &&
      changed.length > 0 &&
      business.verification_status !== VerificationStatus.PENDING;

    const location =
      dto.countryCode !== undefined || dto.city !== undefined
        ? this.geo.resolveLocation({
            countryCode: dto.countryCode ?? business.country_code ?? undefined,
            city: dto.city ?? undefined,
          })
        : {};

    await this.prisma.$transaction([
      this.prisma.business.update({
        where: { id: business.id },
        data: {
          name: dto.name,
          category: dto.category,
          legal_form: legalForm,
          size: dto.size,
          registration_number: dto.registrationNumber,
          tax_id: dto.taxId,
          statistical_id: dto.statisticalId,
          address: dto.address,
          country_code: location.country_code,
          city: dto.city === null ? null : location.city,
          email: dto.email,
          phone: dto.phone,
          website: dto.website,
          description: dto.description,
          ...(reopened ? reopenedReview() : {}),
        },
      }),
      ...(reopened ? [this.reopenProfileReview(profileId)] : []),
    ]);

    if (reopened) {
      this.emitBusinessResubmitted(
        profileId,
        `${business.name} a modifié ses informations (${changed.join(', ')}) : à revoir.`,
      );
    }
    return { business: await this.getBusinessForAdmin(profileId), reopened };
  }

  /**
   * A paper sent from the dashboard: a new one, or the replacement of a
   * current paper not yet accepted (`replacesId`). The replaced row stays,
   * superseded, so the reviewer can compare and read why it was refused. A
   * refused business goes back to review with it.
   */
  async uploadBusinessDocument(
    profileId: string,
    file: Express.Multer.File,
    documentType: BusinessDocumentType,
    replacesId?: string,
  ): Promise<AdminBusinessDetail> {
    const business = await this.prisma.business.findUnique({
      where: { profile_id: profileId },
      include: { documents: { where: { superseded_at: null } } },
    });
    if (!business || business.deleted_at) {
      throw new NotFoundException("Ce profil n'a pas d'organisation.");
    }
    const accepted = DOCUMENTS_BY_CATEGORY[business.category];
    if (
      ![...accepted.required.flat(), ...accepted.optional].includes(
        documentType,
      )
    ) {
      throw new BadRequestException(
        'Ce document ne correspond pas à votre type d’organisation.',
      );
    }

    let replaced: (typeof business.documents)[number] | undefined;
    if (replacesId) {
      replaced = business.documents.find((d) => d.id === replacesId);
      if (!replaced) {
        throw new NotFoundException('Document introuvable.');
      }
      if (replaced.verification_status === VerificationStatus.VERIFIED) {
        throw new ConflictException('Ce document est déjà validé.');
      }
      if (replaced.document_type !== documentType) {
        throw new BadRequestException(
          'Le nouveau fichier doit être du même type que celui qu’il remplace.',
        );
      }
    } else if (
      business.documents.some((d) => d.document_type === documentType)
    ) {
      throw new ConflictException(
        'Ce document est déjà fourni : remplacez-le plutôt.',
      );
    }

    const bucket = await kycBucket(this.systemConfig, this.configService);
    const uploaded = await this.fileService.uploadToStorage(file, {
      folder: 'kyc-documents',
      access: 'private',
      bucket,
    });

    const reopened =
      business.verification_status === VerificationStatus.REJECTED;
    const now = new Date();
    await this.prisma.$transaction([
      ...(replaced
        ? [
            this.prisma.businessDocument.update({
              where: { id: replaced.id },
              data: { superseded_at: now },
            }),
          ]
        : []),
      this.prisma.businessDocument.create({
        data: {
          business_id: business.id,
          document_type: documentType,
          storage_key: uploaded.key,
          file_name: file.originalname?.slice(0, 255) || null,
          mime_type: file.mimetype,
          replaces_id: replaced?.id ?? null,
        },
      }),
      ...(reopened
        ? [
            this.prisma.business.update({
              where: { id: business.id },
              data: reopenedReview(),
            }),
            this.reopenProfileReview(profileId),
          ]
        : []),
    ]);

    this.emitBusinessResubmitted(
      profileId,
      `${business.name} a ${replaced ? 'renvoyé' : 'ajouté'} : ${BUSINESS_DOCUMENT_LABELS[documentType]}.`,
    );
    return this.getBusinessForAdmin(profileId);
  }

  /** A refused profile goes back to « en attente » with its business. */
  private reopenProfileReview(profileId: string) {
    return this.prisma.profile.updateMany({
      where: {
        id: profileId,
        verification_status: VerificationStatus.REJECTED,
      },
      data: {
        verification_status: VerificationStatus.PENDING,
        rejection_reason: null,
      },
    });
  }

  private emitBusinessResubmitted(profileId: string, message: string): void {
    this.eventEmitter.emit(AdminNotificationEvent.PROFILE_UPDATED, {
      event: AdminNotificationEvent.PROFILE_UPDATED,
      title: 'Organisation à revoir',
      message,
      entityType: 'profile',
      entityId: String(profileId),
      timestamp: new Date().toISOString(),
    });
  }

  /** The same, for a verification image attached during review. */
  async streamVerificationImage(
    profileId: string,
    imageId: string,
  ): Promise<DownloadResult & { filename: string }> {
    const img = await this.prisma.kycVerificationImage.findFirst({
      where: { id: imageId, profile_id: profileId },
      select: { storage_key: true, image_url: true },
    });

    if (!img) {
      throw new NotFoundException('Image introuvable.');
    }

    return this.streamKycObject(img.storage_key, img.image_url, 'verification');
  }

  private async streamKycObject(
    storageKey: string | null,
    storedUrl: string | null,
    label: string,
  ): Promise<DownloadResult & { filename: string }> {
    const target = await this.resolveKycStorage(storageKey, storedUrl);

    if (!target) {
      throw new NotFoundException('Fichier indisponible.');
    }

    const downloaded = await this.fileService.download(
      target.key,
      target.bucket,
    );

    // The route path carries no extension, so the filename is what tells a
    // download what it is.
    const ext = target.key.split('.').pop();
    return {
      ...downloaded,
      filename: ext && ext !== target.key ? `${label}.${ext}` : label,
    };
  }

  /**
   * Uploads a single KYC file and returns a SIGNED url plus its storage key.
   * Used by POST /profile/kyc-upload so files are uploaded during onboarding
   * (one round-trip per file) instead of inline with profile creation.
   *
   * Two things changed here, and both were load-bearing.
   *
   * `access: 'public'` put identity documents — ID cards, passports, and the
   * selfie held next to them — behind a permanent, unauthenticated URL. They
   * now go to a bucket that is never published, and are read back through a
   * signature that dies within the hour.
   *
   * And the key is returned. It used to be dropped here, which is why
   * `storage_key` is NULL on every KYC row ever written: the caller never had
   * a key to send back, so `createKycDocumentRecord` was called without one and
   * nothing could ever be signed.
   *
   * The url is still returned, and still works, because onboarding falls back
   * to it when the local preview is gone (`kycDocumentPreview ?? kycDocumentUrl`
   * in the client's confirmation view). An hour covers a signup session.
   */
  async uploadKycFile(
    file: Express.Multer.File,
  ): Promise<{ url: string; key: string }> {
    const bucket = await kycBucket(this.systemConfig, this.configService);
    const result = await this.fileService.uploadToStorage(file, {
      folder: 'kyc-documents',
      access: 'private',
      bucket,
    });
    // Pending until a profile is created with it. Anything still pending a
    // day later was abandoned mid-signup and is deleted (pentest F4, #836):
    // identity documents nobody owns must not sit in the bucket forever.
    await this.redis
      .zadd(KYC_PENDING_UPLOADS, Date.now(), result.key)
      .catch(() => undefined);
    void this.sweepAbandonedKycUploads(bucket).catch((err: unknown) =>
      this.logger.warn('KYC upload sweep failed', err),
    );
    return { url: result.url, key: result.key };
  }

  /**
   * Deletes a few abandoned KYC uploads. Run on each upload rather than on a
   * schedule: sign-ups are what create them, so sign-ups keep the set short.
   * Idempotent, so concurrent instances only repeat a delete.
   */
  private async sweepAbandonedKycUploads(bucket?: string): Promise<void> {
    const cutoff = Date.now() - KYC_PENDING_TTL_MS;
    const expired = await this.redis.zrangebyscore(
      KYC_PENDING_UPLOADS,
      0,
      cutoff,
      'LIMIT',
      0,
      KYC_SWEEP_BATCH,
    );
    for (const key of expired) {
      // A business's documents go through the same upload, so a key is
      // attached when either table holds it.
      const [personal, business] = await Promise.all([
        this.prisma.kycDocument.count({ where: { storage_key: key } }),
        this.prisma.businessDocument.count({ where: { storage_key: key } }),
      ]);
      if (personal + business === 0) {
        await this.fileService.deleteStoredObject(key, bucket);
      }
      await this.redis.zrem(KYC_PENDING_UPLOADS, key);
    }
  }

  /**
   * One image an admin attaches while reviewing an identity, uploaded on its
   * own so the verify call afterwards carries only descriptors.
   *
   * The admin modal used to POST every attachment as binary inside the verify
   * request — all-or-nothing, unbounded, and with nothing to show a reviewer on
   * a slow connection but a spinner on the submit button. Splitting the upload
   * out is what lets each file fail and retry by itself.
   *
   * FOLDER IS SCOPED TO THE PROFILE. Every provider builds the key as
   * `${folder}/${filename}`, so this yields
   * `kyc-verification/<profileId>/<ts>_<rand>.jpg`. That still satisfies
   * `isKycKey`, and it gives `verifyProfileKyc` a structural check it could not
   * otherwise make: a key submitted for one profile cannot name an object
   * uploaded under another. Rows written before this keep their flat keys and
   * stay readable — the stream route reads `storage_key` verbatim.
   *
   * NOT WATERMARKED, unlike everything else that goes through
   * `uploadToStorage`. These images are only ever served through the
   * authenticated stream route, so the mark protects nothing, and it re-encodes
   * the very detail a reviewer opened the image to read.
   */
  async uploadVerificationImage(
    profileId: string,
    file: Express.Multer.File,
  ): Promise<{ url: string; key: string }> {
    // Checked before the PUT, not after: an admin working on a deleted profile
    // should find out now rather than after uploading ten photographs.
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { id: true },
    });

    if (!profile) {
      throw new NotFoundException('Profil non trouvé');
    }

    const result = await this.fileService.uploadToStorage(file, {
      folder: `kyc-verification/${profileId}`,
      access: 'private',
      bucket: await kycBucket(this.systemConfig, this.configService),
      watermark: false,
    });

    return { url: result.url, key: result.key };
  }

  /**
   * The object key for one submitted KYC document, decided HERE rather than
   * accepted from the caller.
   *
   * This is the fix for the bug that made a document unviewable the hour after
   * it was uploaded. `storage_key` used to come only from an optional DTO
   * field, so a client that did not send one — a bundle loaded before the
   * private-bucket rollout, a mobile app, anything calling the API directly —
   * produced a row with a NULL key and a *signed* url frozen into
   * `document_url`. Nothing could re-sign it, and the signature died in an
   * hour. Deriving the key from the url the caller already sent removes the
   * dependency on the caller behaving well.
   *
   * The hint is still honoured when it is a plausible KYC key, because a
   * well-behaved client knows the key exactly and the url is only ever a
   * reconstruction of it. But it is a candidate, not an answer: `isKycKey`
   * rejects anything outside the KYC folders, and the object still has to be
   * found in a bucket. Returning a caller-supplied string unchecked is what
   * this method exists to stop doing.
   *
   * Accepts an object that is still in the PUBLIC bucket. That is precisely the
   * case that produced this report — an onboarding session that uploaded some
   * files before the cutover and submitted after it — and rejecting it would
   * fail a signup for a file that is present and correct. It is logged, and the
   * backfill relocates it.
   */
  private async resolveKycObject(
    label: string,
    url: string,
    hintKey?: string,
  ): Promise<string> {
    const { publicBaseUrl, buckets } = await storageNames(
      this.systemConfig,
      this.configService,
    );
    const derived = deriveKey(url, publicBaseUrl, buckets);

    if (hintKey && !isKycKey(hintKey)) {
      this.logger.warn(
        `Ignoring ${label} storage key hint that is not a KYC key: ${hintKey}`,
      );
    }

    // The hint first — it is exact when it is right. The derived key is the
    // fallback that makes a silent client harmless.
    const candidates = [
      hintKey && isKycKey(hintKey) ? hintKey : null,
      derived && isKycKey(derived.key) ? derived.key : null,
    ].filter((key): key is string => !!key);

    if (candidates.length === 0) {
      throw new BadRequestException(
        `Le fichier ${label} n'est pas un document KYC valide.`,
      );
    }

    const privateBucket = await kycBucket(
      this.systemConfig,
      this.configService,
    );
    const [publicBucket] = buckets;

    for (const key of new Set(candidates)) {
      if (await this.fileService.exists(key, privateBucket)) return key;

      // Not in the private bucket. Before moving on, look in the public one: a
      // session that straddled the rollout uploaded there, and the file is real.
      if (publicBucket && (await this.fileService.exists(key, publicBucket))) {
        this.logger.warn(
          `${label} is still in the public bucket (${key}). Accepting it and ` +
            'recording the key; run prisma/backfill-kyc-storage-keys.ts to move it.',
        );
        return key;
      }
    }

    throw new BadRequestException(
      `Le fichier ${label} est introuvable. Merci de le téléverser à nouveau.`,
    );
  }

  /**
   * The object key for one verification image an admin attached.
   *
   * Deliberately NOT `resolveKycObject`, which sits directly above and is
   * forgiving in three ways that would be wrong here:
   *
   * 1. It accepts an object still sitting in the PUBLIC bucket, because an
   *    onboarding session that straddled the bucket split really did upload
   *    there. Nothing of the sort applies to an image `uploadVerificationImage`
   *    wrote seconds ago against a hardcoded private bucket — accepting a
   *    public-bucket object here would quietly reopen the exposure the split
   *    exists to close.
   * 2. Its precedence is url-first with the key as a hint, because that caller
   *    is an unauthenticated client that may know neither. Here it is inverted:
   *    the key came from our own endpoint in this session and is authoritative,
   *    while the url is a signed preview that may already have expired.
   * 3. It accepts any KYC key, `kyc-documents/` included. A verification image
   *    must not be able to point at the worker's passport object — verification
   *    images are replaced wholesale on every verify, so that would let one
   *    admin action rewrite what an evidence row references.
   *
   * Same primitives as that method — `isKycKey`, `deriveKey`, `storageNames`,
   * `fileService.exists` — so this is a second policy, not a second
   * implementation.
   */
  private async resolveVerificationImageKey(
    profileId: string,
    bucket: string,
    doc: { key: string; url?: string },
  ): Promise<string> {
    const prefix = `kyc-verification/${profileId}/`;

    const usable = (
      candidate: string | null | undefined,
    ): candidate is string =>
      !!candidate && isKycKey(candidate) && candidate.startsWith(prefix);

    let key: string | null = usable(doc.key) ? doc.key : null;

    // Only reached by a caller that lost the key but kept the url. The admin
    // client always has both, so this is belt-and-braces rather than a path
    // anything takes today.
    if (!key && doc.url) {
      const { publicBaseUrl, buckets } = await storageNames(
        this.systemConfig,
        this.configService,
      );
      const derived = deriveKey(doc.url, publicBaseUrl, buckets);
      if (usable(derived?.key)) key = derived.key;
    }

    if (!key) {
      this.logger.warn(
        `Rejected a verification image key for profile=${profileId}: ${doc.key}`,
      );
      throw new BadRequestException(
        "Une des images jointes n'est pas une pièce de vérification valide.",
      );
    }

    // The private bucket and nothing else — see reason 1 above.
    if (!(await this.fileService.exists(key, bucket))) {
      throw new BadRequestException(
        'Une des images jointes est introuvable. Merci de la téléverser à nouveau.',
      );
    }

    return key;
  }

  private async createProfileWithDocuments(
    createProfileDto: CreateProfileDto,
    entry: SignupIdentity['entry'],
  ) {
    if (entry === 'business') {
      return this.createBusinessProfileWithDocuments(createProfileDto);
    }
    const { kycDocumentUrl, kycSelfieUrl, kycDocumentBackUrl } =
      createProfileDto;
    // Required by the DTO for every sign-up but a business one.
    if (!kycDocumentUrl || !kycSelfieUrl) {
      throw new BadRequestException(
        "Le document d'identité et le selfie sont requis.",
      );
    }

    // Resolved BEFORE the transaction opens. These do network I/O against R2,
    // and holding a Postgres transaction open across it is how a slow bucket
    // becomes a pool exhaustion; a rejection here also has to leave no
    // half-written profile behind.
    const wantsBackSide =
      createProfileDto.documentType !== DocumentType.PASSPORT &&
      !!kycDocumentBackUrl;

    const [documentKey, documentBackKey, selfieKey] = await Promise.all([
      this.resolveKycObject(
        "recto du document d'identité",
        kycDocumentUrl,
        createProfileDto.kycDocumentKey,
      ),
      wantsBackSide
        ? this.resolveKycObject(
            "verso du document d'identité",
            kycDocumentBackUrl,
            createProfileDto.kycDocumentBackKey,
          )
        : Promise.resolve(undefined),
      this.resolveKycObject(
        'selfie',
        kycSelfieUrl,
        createProfileDto.kycSelfieKey,
      ),
    ]);

    const privateBucket = await kycBucket(
      this.systemConfig,
      this.configService,
    );

    return this.prisma.$transaction(async (tx) => {
      const createdProfile = await this.createProfileRecord(
        tx,
        createProfileDto,
      );

      await this.linkProfileCategories(tx, createdProfile.id, createProfileDto);

      // A PASSPORT has no back to photograph, so it gets two rows; every other
      // type gets three. Gating on documentType rather than merely on the URL
      // being present is what makes a back sent alongside a PASSPORT a no-op
      // instead of an orphan row no reviewer would ever be shown.
      //
      // The keys are the ones this service derived, not the ones the client
      // sent, and the url is now a canonical `s3://` reference rather than
      // whatever the client round-tripped. A signed url written here is an
      // expired url written here.
      await Promise.all([
        this.createKycDocumentRecord(
          tx,
          createdProfile.id,
          createProfileDto.documentType,
          'DOCUMENT',
          privateBucket,
          documentKey,
        ),
        ...(wantsBackSide && documentBackKey
          ? [
              this.createKycDocumentRecord(
                tx,
                createdProfile.id,
                createProfileDto.documentType,
                'DOCUMENT_BACK',
                privateBucket,
                documentBackKey,
              ),
            ]
          : []),
        this.createKycDocumentRecord(
          tx,
          createdProfile.id,
          createProfileDto.documentType,
          'SELFIE',
          privateBucket,
          selfieKey,
        ),
      ]);

      await this.linkPlatformDocuments(tx, createdProfile.id);

      return createdProfile;
    });
  }

  /**
   * A business sign-up: the person's profile, flagged `is_business`, and the
   * organisation with its documents — in ONE transaction, so a profile can
   * never be flagged without its business, nor a business exist without its
   * profile. No personal ID or selfie (product decision): the business's own
   * papers are what the team reviews, and approving them activates the
   * account.
   *
   * The documents are resolved like the personal KYC files — same upload
   * route, same private bucket, keys derived server-side — and before the
   * transaction opens, for the same reason (network I/O against R2).
   */
  private async createBusinessProfileWithDocuments(
    createProfileDto: CreateProfileDto,
  ) {
    const business = createProfileDto.business;
    if (!business) {
      throw new BadRequestException(
        'Renseignez les informations de votre entreprise.',
      );
    }
    assertBusinessSignupComplete(business);

    const documentKeys = await Promise.all(
      business.documents.map((doc) =>
        this.resolveKycObject(
          BUSINESS_DOCUMENT_LABELS[doc.documentType],
          doc.url,
          doc.key,
        ),
      ),
    );
    const location = this.geo.resolveLocation(createProfileDto);

    return this.prisma.$transaction(async (tx) => {
      const createdProfile = await this.createProfileRecord(
        tx,
        createProfileDto,
        { isBusiness: true },
      );
      await this.linkProfileCategories(tx, createdProfile.id, createProfileDto);

      await tx.business.create({
        data: {
          profile_id: createdProfile.id,
          name: business.name,
          category: business.category,
          legal_form: business.legalForm ?? null,
          size: business.size ?? null,
          registration_number: business.registrationNumber ?? null,
          tax_id: business.taxId ?? null,
          statistical_id: business.statisticalId ?? null,
          address: business.address,
          country_code: location.country_code ?? null,
          city: location.city ?? null,
          email: business.email ?? createProfileDto.email ?? null,
          phone: business.phone ?? createProfileDto.phone,
          website: business.website ?? null,
          description: business.description ?? null,
          documents: {
            create: business.documents.map((doc, i) => ({
              document_type: doc.documentType,
              storage_key: documentKeys[i],
              file_name: doc.fileName ?? null,
              mime_type: mimeTypeOfKey(documentKeys[i]),
            })),
          },
        },
      });

      await this.linkPlatformDocuments(tx, createdProfile.id);
      return createdProfile;
    });
  }

  private async linkProfileCategories(
    tx: PrismaTransactionClient,
    profileId: string,
    createProfileDto: CreateProfileDto,
  ): Promise<void> {
    if (!createProfileDto.categoryIds?.length) return;
    await tx.profileCategory.createMany({
      data: createProfileDto.categoryIds.map((categoryId) => ({
        profile_id: profileId,
        category_id: categoryId,
      })),
      skipDuplicates: true,
    });
  }

  /** Snapshot-link all current AGREEMENT/POLICY platform documents. */
  private async linkPlatformDocuments(
    tx: PrismaTransactionClient,
    profileId: string,
  ): Promise<void> {
    const platformDocs = await tx.document.findMany({
      where: { category: { in: ['AGREEMENT', 'POLICY'] } },
      select: { id: true },
    });
    if (platformDocs.length > 0) {
      await tx.profilePlatformDocumentLink.createMany({
        data: platformDocs.map((doc) => ({
          profile_id: profileId,
          document_id: doc.id,
        })),
        skipDuplicates: true,
      });
    }
  }

  private async createProfileRecord(
    tx: PrismaTransactionClient,
    createProfileDto: CreateProfileDto,
    { isBusiness = false }: { isBusiness?: boolean } = {},
  ): Promise<{ id: string }> {
    return tx.profile.create({
      data: {
        first_name: createProfileDto.firstName,
        last_name: createProfileDto.lastName,
        // `?? null` like `direct_phone` below, and for the same reason: an
        // omitted key arrives as `undefined`, which Prisma reads as "not
        // provided" rather than "no value". Both end up NULL on this nullable
        // column, but writing the intent down beats relying on that.
        email: createProfileDto.email ?? null,
        phone: createProfileDto.phone,
        direct_phone: createProfileDto.directPhone ?? null,
        address: createProfileDto.address,
        ...this.geo.resolveLocation(createProfileDto),
        description: createProfileDto.description || '',
        profile_type: createProfileDto.profileType,
        category_id: null,
        status: 'PENDING_ACTIVATION',
        verification_status: 'PENDING',
        reliability_score: 100,
        read_and_approved_policies: true,
        // Signup already proves the number: onboarding is WhatsApp-first and
        // every message the platform sends this profile goes to `phone`. The
        // separate "link your number" step only re-asked for what we had, and
        // left new profiles unreachable by anything that targets connected
        // numbers (ad dispatch, reminders) until they happened to reply.
        //
        // This does NOT activate the account — `status` stays
        // PENDING_ACTIVATION until KYC passes. The bot's pre-activation gate
        // keys on `status`, not on this flag, so the KYC wall still holds.
        //
        // A business proved its email, not its phone: the number is required
        // but unverified, so nothing that targets connected numbers may treat
        // it as a WhatsApp line until it is verified.
        whatsapp_connected: !isBusiness,
        is_business: isBusiness,
      },
      select: {
        id: true,
      },
    });
  }

  private createKycDocumentRecord(
    tx: PrismaTransactionClient,
    profileId: string,
    documentType: CreateProfileDto['documentType'] | undefined,
    documentCategory: KycDocumentCategory,
    bucket: string,
    storageKey: string,
  ) {
    const data: {
      profile_id: string;
      document_type?: CreateProfileDto['documentType'];
      document_category: KycDocumentCategory;
      document_url: string;
      storage_key: string;
      verification_status: 'PENDING';
    } = {
      profile_id: profileId,
      document_category: documentCategory,
      document_url: kycObjectRef(bucket, storageKey),
      storage_key: storageKey,
      verification_status: 'PENDING',
    };

    if (documentType !== undefined) {
      data.document_type = documentType;
    }

    // Not removed from the pending set here: this runs inside a transaction
    // that may still roll back. The sweep checks for a row before deleting.
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

  /**
   * Step 1 of changing the WhatsApp number: prove the new handset is reachable.
   *
   * Writes nothing to the profile. The number is the login identity, so the
   * only safe order is prove-then-switch: committing here would let a single
   * typo send every future login link to a number the user does not own, and
   * would turn a borrowed session into a permanent account takeover rather than
   * a temporary one.
   *
   * The code goes to the NEW number, not the current one. Sending to the
   * current one would only re-confirm what we already know — and the person who
   * just lost that handset is exactly who this exists for.
   */
  async requestPhoneChange(
    profileId: string,
    newPhone: string,
  ): Promise<{ success: boolean }> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { id: true, phone: true },
    });
    if (!profile) {
      throw new NotFoundException('Profil non trouvé');
    }

    // One canonical form before anything is compared or stored: « 242… » and
    // « +242… » are the same number, and the uniqueness check must see that
    // (pentest A2-F10, #866).
    const phone = toE164(newPhone);
    if (phone === profile.phone) {
      throw new BadRequestException('Ce numéro est déjà celui de votre compte');
    }

    // `phone` is UNIQUE, so committing a taken number would fail at the
    // database with an opaque error after the user had already entered a code.
    // Checked here so the refusal lands on the field they can still edit.
    const taken = await this.prisma.profile.findUnique({
      where: { phone },
      select: { id: true },
    });
    if (taken) {
      throw new ConflictException(
        'Ce numéro est déjà utilisé par un autre compte',
      );
    }

    if (!this.whatsAppService.isConfigured()) {
      throw new ServiceUnavailableException(
        "Le service WhatsApp n'est pas configuré",
      );
    }

    // The shared send cap, per account and per target number (#866): there
    // was none, and every request also reset the five-guess limit. Each code
    // is a paid WhatsApp template to a number the caller chooses.
    await assertCanSendOtp(
      this.redis,
      `${PHONE_CHANGE_SENDS_PREFIX}profile:${profileId}`,
    );
    await assertCanSendOtp(
      this.redis,
      `${PHONE_CHANGE_SENDS_PREFIX}phone:${phone}`,
    );
    await assertNotLockedOut(this.redis, phoneChangeMissKey(profileId));

    const code = randomInt(100000, 1000000).toString();

    // Sent BEFORE the pending change is stored: if WhatsApp refuses the number
    // — not on WhatsApp, unreachable — there is nothing to clean up, and the
    // user learns immediately rather than at the code screen.
    const sent = await this.whatsAppService.sendTemplateMessage(
      phone,
      'otp',
      code,
      profileId,
    );
    if (!sent) {
      this.logger.error(
        `WhatsApp failed to send phone-change code for profile=${profileId}`,
      );
      throw new ServiceUnavailableException(
        "Impossible d'envoyer le code sur ce numéro. Vérifiez qu'il est bien sur WhatsApp.",
      );
    }

    await this.redis.set(
      `${PHONE_CHANGE_KEY_PREFIX}${profileId}`,
      JSON.stringify({ phone, code, attempts: 0 }),
      'EX',
      PHONE_CHANGE_TTL_SECONDS,
    );

    this.logger.log(`Phone-change code sent for profile=${profileId}`);
    return { success: true };
  }

  /**
   * Step 2: the code came back, so the handset is real. Switch the number.
   *
   * Also sets `whatsapp_connected`: reaching this point is proof the new number
   * receives WhatsApp, which is the only thing that flag claims.
   */
  async confirmPhoneChange(
    profileId: string,
    code: string,
  ): Promise<{ success: boolean; phone: string }> {
    const key = `${PHONE_CHANGE_KEY_PREFIX}${profileId}`;
    // Wrong guesses add up across codes for a day; a new request does not
    // reset them (#866).
    await assertNotLockedOut(this.redis, phoneChangeMissKey(profileId));
    const raw = await this.redis.get(key);
    if (!raw) {
      throw new BadRequestException(
        'Aucun changement de numéro en attente, ou le code a expiré',
      );
    }

    const pending = JSON.parse(raw) as {
      phone: string;
      code: string;
      attempts: number;
    };

    if (!this.codesMatch(pending.code, code)) {
      await recordMiss(this.redis, phoneChangeMissKey(profileId));
      const attempts = pending.attempts + 1;
      if (attempts >= PHONE_CHANGE_MAX_ATTEMPTS) {
        await this.redis.del(key);
        throw new BadRequestException(
          'Trop de tentatives. Demandez un nouveau code.',
        );
      }
      // Preserves the original TTL rather than restarting it, so guessing
      // cannot extend the window it happens in.
      const ttl = await this.redis.ttl(key);
      await this.redis.set(
        key,
        JSON.stringify({ ...pending, attempts }),
        'EX',
        ttl > 0 ? ttl : PHONE_CHANGE_TTL_SECONDS,
      );
      throw new BadRequestException('Code incorrect');
    }

    try {
      await this.prisma.profile.update({
        where: { id: profileId },
        data: { phone: pending.phone, whatsapp_connected: true },
      });
    } catch (err) {
      // Someone claimed the number in the five minutes since we checked.
      this.throwIfUniqueConstraintViolation(err);
      throw err;
    }

    await this.redis.del(key);
    this.logger.log(`Phone changed for profile=${profileId}`);
    return { success: true, phone: pending.phone };
  }

  /**
   * Constant-time compare, so a wrong code cannot be narrowed digit by digit
   * from how long the answer took. Lengths are checked first because
   * `timingSafeEqual` throws on a mismatch.
   */
  private codesMatch(expected: string, supplied: string): boolean {
    const a = Buffer.from(expected);
    const b = Buffer.from(supplied);
    return a.length === b.length && timingSafeEqual(a, b);
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
    const message = verificationLinkMessage(verificationLink);

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

  /**
   * Deliver the agreement PDF over WhatsApp, alongside the `kyc` notification.
   *
   * Lives here rather than at its two call sites because this is the only class
   * that can render the thing: `downloadAgreement` below needs the AGREEMENT
   * template row, the profile, and the 30-day Redis cache that keeps a
   * re-verification from re-rendering it. Reusing it also means the WhatsApp
   * copy is byte-identical to what the web download serves.
   *
   * BEST EFFORT, ALWAYS. A KYC approval is a state change the admin has already
   * committed; an attachment that failed to render must not surface as a
   * failure on that request, and must never be retried into a second copy.
   */
  async sendAgreementDocument(profileId: string): Promise<void> {
    if (!this.whatsAppDocuments) return;

    // Short, not long: 10 minutes absorbs a double-clicked verify button, while
    // still letting the admin's explicit resend endpoint actually resend. A
    // 30-day guard would make that endpoint silently do nothing, which is the
    // worse failure of the two.
    const claimKey = `${REDIS_KEY_PREFIX}wa:doc:agreement:${profileId}`;
    let claimed = false;
    try {
      claimed = (await this.redis.set(claimKey, '1', 'EX', 600, 'NX')) !== null;
    } catch {
      // Redis down: send anyway. A duplicate agreement is an annoyance;
      // silence is a document the user never receives.
      claimed = true;
    }
    if (!claimed) return;

    try {
      const profile = await this.prisma.profile.findUnique({
        where: { id: profileId },
        select: { phone: true, first_name: true },
      });
      if (!profile?.phone) return;

      const { buffer, filename } = await this.downloadAgreement(profileId);

      await this.whatsAppDocuments.send({
        phone: profile.phone,
        profileId,
        template: 'kycAgreementDocument',
        // No body variables: the `kyc` card sent moments earlier already
        // greets them by name.
        params: {},
        pdf: buffer,
        filename,
        storageKey: `agreement/${profileId}.pdf`,
      });
    } catch (err) {
      // Release the claim so the next attempt is not suppressed by a failure.
      await this.redis.del(claimKey).catch(() => undefined);
      this.logger.warn(
        `[agreement] WhatsApp delivery failed for profile ${profileId}`,
        err,
      );
    }
  }

  async downloadAgreement(
    profileId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const template = await this.prisma.document.findFirst({
      where: { category: 'AGREEMENT' },
      orderBy: { created_at: 'desc' },
    });

    if (!template) {
      throw new NotFoundException("Aucun modèle d'accord trouvé");
    }

    // Check cache before fetching profile — saves a DB round-trip on hits.
    const cacheKey = `${REDIS_KEY_PREFIX}pdf:agreement:${profileId}:${template.id}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      // Still need a filename — derive it from profileId as a safe fallback.
      return {
        buffer: Buffer.from(cached, 'base64'),
        filename: `accord_${profileId}.pdf`,
      };
    }

    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        first_name: true,
        last_name: true,
        created_at: true,
        email: true,
        phone: true,
        profile_type: true,
      },
    });

    if (!profile) {
      throw new NotFoundException('Profil introuvable');
    }

    const safeName = `${profile.last_name}_accord`.replaceAll(
      /[^a-zA-Z0-9_-]/g,
      '_',
    );
    const filename = `${safeName}.pdf`;

    const data: Record<string, string> = {
      EMAIL: profile.email ?? '-',
      LAST_NAME: profile.last_name,
      FIRST_NAME: profile.first_name,
      FULL_NAME: `${profile.first_name} ${profile.last_name}`,
      PROFILE_TYPE: this.getProfileTypeLabel(profile.profile_type),
      DATE: profile.created_at.toLocaleDateString('fr-FR'),
      PHONE: profile.phone ?? '',
      USER_ID: profileId,
    };

    const buffer = await this.documentService.fillDocumentTemplateAsPdf(
      template.id,
      data,
    );

    await this.redis.setex(
      cacheKey,
      30 * 24 * 60 * 60,
      buffer.toString('base64'),
    );
    return { buffer, filename };
  }

  private getProfileTypeLabel(profileType: ProfileType): string {
    return PROFILE_TYPE_LABELS[profileType] ?? profileType;
  }
}
