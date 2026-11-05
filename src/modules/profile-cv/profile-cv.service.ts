import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CvChoice, ProfileType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { kycBucket } from '../../common/services/storage/kyc-bucket';
import { StorageService } from '../../common/services/storage/storage.service';
import { SystemConfigService } from '../system-config/system-config.service';
import {
  CV_EXTENSION,
  cvFileType,
  DOCX_MIME,
  extractCvText,
  type CvFileType,
} from '../business/cv-screening/cv-files';
import { cvOpen, unlockedWorkers } from './profile-cv.rules';
import {
  CANDIDATE_VIEWED,
  type CandidateViewed,
} from '../application/application.events';
import { stripContacts } from './strip-contacts';

export const MAX_PROFILE_CV_BYTES = 10 * 1024 * 1024;

export type ProfileCvView = {
  uploaded: {
    fileName: string;
    sizeBytes: number;
    mimeType: string;
    uploadedAt: string;
  } | null;
  preferred: CvChoice;
};

/**
 * « Mon CV »: a worker's own CV, kept on the profile and sent with their
 * applications in place of, or beside, the CV Rabotka builds.
 */
@Injectable()
export class ProfileCvService {
  private readonly logger = new Logger(ProfileCvService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly systemConfig: SystemConfigService,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
  ) {}

  async get(profileId: string): Promise<ProfileCvView> {
    const [profile, live] = await Promise.all([
      this.worker(profileId),
      this.live(profileId),
    ]);
    return {
      uploaded: live
        ? {
            fileName: live.file_name,
            sizeBytes: live.size_bytes,
            mimeType: live.mime_type,
            uploadedAt: live.created_at.toISOString(),
          }
        : null,
      preferred: live ? profile.preferred_cv : CvChoice.RABOTKA,
    };
  }

  async upload(
    profileId: string,
    file: Express.Multer.File | undefined,
  ): Promise<ProfileCvView> {
    await this.worker(profileId);
    if (!file?.buffer?.length) {
      throw new BadRequestException('Joignez votre CV.');
    }
    const type = cvFileType(file.buffer, file.mimetype);
    if (type !== 'application/pdf' && type !== DOCX_MIME) {
      throw new BadRequestException(
        'Le CV doit être un PDF ou un fichier Word.',
      );
    }

    const bucket = await kycBucket(this.systemConfig, this.config);
    const { key } = await this.storage.upload(
      file.buffer,
      `${randomUUID()}.${CV_EXTENSION[type]}`,
      {
        folder: `profile-cvs/${profileId}`,
        mimeType: type,
        access: 'private',
        bucket,
      },
    );
    const text = stripContacts(await extractCvText(file.buffer, type));

    let previous: string[] = [];
    try {
      previous = await this.prisma.$transaction(async (tx) => {
        const old = await tx.profileCv.findMany({
          where: { profile_id: profileId, deleted_at: null },
          select: { id: true },
        });
        await tx.profileCv.updateMany({
          where: { id: { in: old.map((o) => o.id) } },
          data: { deleted_at: new Date() },
        });
        await tx.profileCv.create({
          data: {
            profile_id: profileId,
            file_name: cleanName(file.originalname, CV_EXTENSION[type]),
            mime_type: type,
            size_bytes: file.size,
            storage_key: key,
            storage_bucket: bucket,
            cv_text: text,
          },
        });
        // Added a CV: it is the one to send, until they say otherwise.
        await tx.profile.update({
          where: { id: profileId },
          data: { preferred_cv: CvChoice.UPLOADED },
        });
        return old.map((o) => o.id);
      });
    } catch (err) {
      await this.storage.delete(key, { bucket }).catch(() => undefined);
      throw err;
    }
    await this.purgeUnsent(previous);
    return this.get(profileId);
  }

  async remove(profileId: string): Promise<ProfileCvView> {
    await this.worker(profileId);
    const live = await this.prisma.profileCv.findMany({
      where: { profile_id: profileId, deleted_at: null },
      select: { id: true },
    });
    await this.prisma.$transaction([
      this.prisma.profileCv.updateMany({
        where: { id: { in: live.map((l) => l.id) } },
        data: { deleted_at: new Date() },
      }),
      this.prisma.profile.update({
        where: { id: profileId },
        data: { preferred_cv: CvChoice.RABOTKA },
      }),
    ]);
    await this.purgeUnsent(live.map((l) => l.id));
    return this.get(profileId);
  }

  async setPreference(
    profileId: string,
    preferred: CvChoice,
  ): Promise<ProfileCvView> {
    await this.worker(profileId);
    if (preferred === CvChoice.UPLOADED && !(await this.live(profileId))) {
      throw new BadRequestException('Ajoutez d’abord votre CV.');
    }
    await this.prisma.profile.update({
      where: { id: profileId },
      data: { preferred_cv: preferred },
    });
    return this.get(profileId);
  }

  /** The worker reading their own CV. */
  async ownFile(profileId: string) {
    await this.worker(profileId);
    const live = await this.live(profileId);
    if (!live) throw new NotFoundException('Aucun CV ajouté.');
    return this.file(live);
  }

  /**
   * A business reading the CV sent with an application to one of its offers:
   * once the contact is unlocked or the application retained.
   */
  async fileForEmployer(employerId: string, applicationId: string) {
    const application = await this.prisma.application.findFirst({
      where: {
        id: applicationId,
        deleted_at: null,
        job_offer: { employer_id: employerId },
      },
      select: {
        status: true,
        worker_id: true,
        profile_cv: true,
      },
    });
    if (!application?.profile_cv || application.profile_cv.purged_at) {
      throw new NotFoundException('Aucun CV joint à cette candidature.');
    }
    const unlocked = await unlockedWorkers(this.prisma, employerId, [
      application.worker_id,
    ]);
    if (!cvOpen(application.status, application.worker_id, unlocked)) {
      throw new ForbiddenException(
        'Le CV joint s’ouvre une fois le contact débloqué.',
      );
    }
    this.events.emit(CANDIDATE_VIEWED, {
      employerId,
      workerId: application.worker_id,
      applicationId,
    } satisfies CandidateViewed);
    return this.file(application.profile_cv);
  }

  private async file(cv: {
    id: string;
    storage_key: string;
    storage_bucket: string | null;
    mime_type: string;
  }) {
    const downloaded = await this.storage.download(cv.storage_key, {
      bucket: cv.storage_bucket ?? undefined,
    });
    return {
      ...downloaded,
      contentType: cv.mime_type,
      // Not the name they gave the file: it goes in a header.
      filename: `cv-${cv.id.slice(0, 8)}.${CV_EXTENSION[cv.mime_type as CvFileType] ?? 'bin'}`,
    };
  }

  private live(profileId: string) {
    return this.prisma.profileCv.findFirst({
      where: { profile_id: profileId, deleted_at: null },
      orderBy: { created_at: 'desc' },
    });
  }

  private async worker(profileId: string) {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { profile_type: true, is_business: true, preferred_cv: true },
    });
    if (
      !profile ||
      profile.profile_type !== ProfileType.WORKER ||
      profile.is_business
    ) {
      throw new ForbiddenException('Réservé aux candidats.');
    }
    return profile;
  }

  /** Old versions no application was sent with: the file goes now. */
  private async purgeUnsent(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const unsent = await this.prisma.profileCv.findMany({
      where: { id: { in: ids }, applications: { none: {} } },
      select: { id: true, storage_key: true, storage_bucket: true },
    });
    for (const cv of unsent) {
      try {
        await this.storage.delete(cv.storage_key, {
          bucket: cv.storage_bucket ?? undefined,
        });
        await this.prisma.profileCv.update({
          where: { id: cv.id },
          data: { purged_at: new Date() },
        });
      } catch (err) {
        this.logger.warn(`Old CV ${cv.id} not deleted: ${String(err)}`);
      }
    }
  }
}

/** The name shown back to the worker: theirs, trimmed, with its extension. */
export function cleanName(original: string | undefined, extension: string) {
  const base = (original ?? '')
    .split('')
    .filter((c) => c.charCodeAt(0) >= 32 && c !== '/' && c !== '\\')
    .join('')
    .trim()
    .slice(0, 120);
  if (!base) return `mon-cv.${extension}`;
  return base.toLowerCase().endsWith(`.${extension}`)
    ? base
    : `${base}.${extension}`;
}
