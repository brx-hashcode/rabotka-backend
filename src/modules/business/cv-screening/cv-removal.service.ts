import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CvScreeningResumeStatus,
  type OfferQuestionKind,
} from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { StorageService } from '../../../common/services/storage/storage.service';
import { AnswerFilesService } from '../../answer-files/answer-files.service';
import { answerFileId } from '../../job-offer/offer-questions';
import { BusinessSubscriptionService } from '../subscription/business-subscription.service';
import { deleteCvObjects, forgetCv } from './cv-forget';

const RESUME = {
  select: {
    id: true,
    status: true,
    storage_key: true,
    storage_bucket: true,
    candidate: true,
    reading: true,
  },
} as const;

type Resume = {
  id: string;
  status: CvScreeningResumeStatus;
  storage_key: string | null;
  storage_bucket: string | null;
  candidate: Parameters<typeof forgetCv>[3]['candidate'];
  reading?: Parameters<typeof forgetCv>[3]['reading'];
};

/**
 * « Supprimer le CV »: the business decides a candidate's CV goes. Its files
 * (the « Fichier » answers too), text and conversations are deleted for good;
 * the score, the opinions and the notes stay. A Rabotka candidate's « Mon CV »
 * is theirs: it only closes on this application. Asking twice is fine.
 */
@Injectable()
export class CvRemovalService {
  private readonly logger = new Logger(CvRemovalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly answerFiles: AnswerFilesService,
    private readonly subscriptions: BusinessSubscriptionService,
  ) {}

  /** A Rabotka application's. */
  async application(profileId: string, id: string): Promise<void> {
    const row = await this.prisma.application.findFirst({
      where: { id, deleted_at: null, job_offer: { employer_id: profileId } },
      select: {
        id: true,
        cv_removed_at: true,
        answers: { select: { kind: true, value: true } },
        cv_resume: RESUME,
      },
    });
    if (!row) throw new NotFoundException('Candidature introuvable.');
    if (row.cv_removed_at) return;
    this.assertRead(row.cv_resume);
    const now = new Date();
    // Marked first: nothing rebuilds it while it goes.
    await this.prisma.application.update({
      where: { id: row.id },
      data: { cv_removed_at: now },
    });
    await this.forget(row.cv_resume, row.answers, now);
  }

  /** A careers-page or imported candidate's. */
  async external(profileId: string, id: string): Promise<void> {
    const row = await this.prisma.externalApplication.findFirst({
      where: { id, job_offer: { employer_id: profileId } },
      select: {
        id: true,
        cv_removed_at: true,
        cv_storage_key: true,
        cv_storage_bucket: true,
        answers: true,
        cv_resume: RESUME,
      },
    });
    if (!row) throw new NotFoundException('Candidature introuvable.');
    if (row.cv_removed_at) return;
    this.assertRead(row.cv_resume);
    const now = new Date();
    await this.prisma.externalApplication.update({
      where: { id: row.id },
      // Due now: the sweep takes the file if it cannot be deleted here.
      data: { cv_removed_at: now, cv_expires_at: now },
    });
    await this.forget(
      row.cv_resume,
      Array.isArray(row.answers)
        ? (row.answers as { kind: OfferQuestionKind; value: string }[])
        : [],
      now,
    );
    if (!row.cv_storage_key) return;
    const failed = await deleteCvObjects(this.storage, this.logger, [
      { key: row.cv_storage_key, bucket: row.cv_storage_bucket ?? undefined },
    ]);
    if (failed.size > 0) return;
    await this.prisma.externalApplication.update({
      where: { id: row.id },
      data: { cv_storage_key: null, cv_storage_bucket: null },
    });
  }

  /** One CV of an analysis; an applicant's, with the application it came with. */
  async resume(
    profileId: string,
    screeningId: string,
    resumeId: string,
  ): Promise<void> {
    const businessId = await this.subscriptions.businessOf(profileId);
    if (!businessId) {
      throw new ForbiddenException('Espace réservé aux comptes entreprise.');
    }
    const row = await this.prisma.cvScreeningResume.findFirst({
      where: {
        id: resumeId,
        screening: { id: screeningId, business_id: businessId },
      },
      select: {
        ...RESUME.select,
        removed_at: true,
        application: { select: { id: true } },
        external_application: { select: { id: true } },
      },
    });
    if (!row) throw new NotFoundException('CV introuvable.');
    if (row.application) return this.application(profileId, row.application.id);
    if (row.external_application) {
      return this.external(profileId, row.external_application.id);
    }
    if (row.removed_at) return;
    this.assertRead(row);
    await this.forget(row, [], new Date());
  }

  /** A CV being read would come back with its text as the reading ends. */
  private assertRead(resume: Resume | null): void {
    if (resume?.status === CvScreeningResumeStatus.QUEUED) {
      throw new BadRequestException(
        'Ce CV est en cours d’analyse : supprimez-le une fois l’analyse terminée.',
      );
    }
  }

  private async forget(
    resume: Resume | null,
    answers: { kind: OfferQuestionKind; value: string }[],
    now: Date,
  ): Promise<void> {
    if (resume) {
      await forgetCv(this.prisma, this.storage, this.logger, resume, now);
    }
    await this.answerFiles.remove(
      answers.flatMap((a) => answerFileId(a) ?? []),
      now,
    );
  }
}
