import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobOfferStatus, OfferQuestionKind } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { kycBucket } from '../../common/services/storage/kyc-bucket';
import { StorageService } from '../../common/services/storage/storage.service';
import {
  CV_EXTENSION,
  cvFileType,
  DOCX_MIME,
  extractCvText,
  TEXT_MIME,
} from '../business/cv-screening/cv-files';
import {
  answerText,
  fileAnswer,
  fileAnswerValue,
} from '../job-offer/offer-questions';
import { SystemConfigService } from '../system-config/system-config.service';

/** Above any plan: a diploma or a letter, not a video. */
export const MAX_ANSWER_FILE_BYTES = 10 * 1024 * 1024;
/** What the analysis reads of one file, with the CV. */
const MAX_TEXT_CHARS = 4000;
/** An upload no application used: gone after this. */
const UNUSED_MS = 24 * 60 * 60 * 1000;

const OPEN: JobOfferStatus[] = [
  JobOfferStatus.ACTIVE,
  JobOfferStatus.PARTIALLY_FILLED,
];

export type AnswerUpload = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

/**
 * The files candidates send as answers to an offer's FILE questions:
 * checked (PDF, Word or a photo, 10 MB), stored privately, their text kept
 * for the CV analysis. The answer then holds `<id>:<name>`.
 */
@Injectable()
export class AnswerFilesService {
  private readonly logger = new Logger(AnswerFilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly systemConfig: SystemConfigService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Stores one file for an open offer that asks for one. From the Rabotka
   * app (`profileId`, attached when the application uses it) or with a
   * careers application (`attached`, no profile). Returns the answer's value.
   */
  async upload(
    jobOfferId: string,
    file: AnswerUpload | undefined,
    by: { profileId: string } | { attached: true },
  ): Promise<{ id: string; name: string; value: string }> {
    if (!file) throw new BadRequestException('Ajoutez un fichier.');
    const offer = await this.prisma.jobOffer.findFirst({
      where: {
        id: jobOfferId,
        deleted_at: null,
        status: { in: OPEN },
        questions: { some: { kind: OfferQuestionKind.FILE } },
      },
      select: { id: true },
    });
    if (!offer) {
      throw new NotFoundException('Cette offre ne demande pas de fichier.');
    }
    const name = (file.originalname || 'fichier').slice(0, 200);
    if (file.size > MAX_ANSWER_FILE_BYTES) {
      throw new BadRequestException(`« ${name} » dépasse 10 Mo.`);
    }
    const type = cvFileType(file.buffer, file.mimetype);
    if (!type || type === TEXT_MIME) {
      throw new BadRequestException(
        `« ${name} » n'est pas accepté : envoyez un PDF, un fichier Word (.docx) ou une photo (JPG, PNG, WEBP).`,
      );
    }

    const id = randomUUID();
    const bucket = await kycBucket(this.systemConfig, this.config);
    const { key } = await this.storage.upload(
      file.buffer,
      `${randomUUID()}.${CV_EXTENSION[type]}`,
      {
        folder: `answer-files/${offer.id}/${id}`,
        mimeType: type,
        access: 'private',
        bucket,
      },
    );
    // Read once, here: the analysis then never downloads it again.
    const text =
      type === 'application/pdf' || type === DOCX_MIME
        ? (await extractCvText(file.buffer, type)).slice(0, MAX_TEXT_CHARS) ||
          null
        : null;
    try {
      await this.prisma.answerFile.create({
        data: {
          id,
          job_offer_id: offer.id,
          profile_id: 'profileId' in by ? by.profileId : null,
          file_name: name,
          mime_type: type,
          size_bytes: file.size,
          storage_key: key,
          storage_bucket: bucket,
          text,
          attached_at: 'attached' in by ? new Date() : null,
        },
      });
    } catch (err) {
      await this.storage.delete(key, { bucket }).catch(() => undefined);
      throw err;
    }
    return { id, name, value: fileAnswerValue(id, name) };
  }

  /**
   * The Rabotka app's FILE answers, before its application is created: each
   * the worker's own upload for this offer, not used yet. Marked used.
   */
  async claim(
    jobOfferId: string,
    profileId: string,
    values: string[],
  ): Promise<void> {
    const ids = values.flatMap((v) => {
      const f = fileAnswer(v);
      return f ? [f.id] : [];
    });
    if (ids.length === 0) return;
    const { count } = await this.prisma.answerFile.updateMany({
      where: {
        id: { in: ids },
        job_offer_id: jobOfferId,
        profile_id: profileId,
        attached_at: null,
        storage_key: { not: null },
      },
      data: { attached_at: new Date() },
    });
    if (count !== ids.length) {
      throw new BadRequestException(
        'Un fichier joint n’est plus disponible : ajoutez-le à nouveau.',
      );
    }
  }

  /** The file, for the business whose offer it answers. */
  async readForEmployer(employerId: string, id: string) {
    const file = await this.prisma.answerFile.findFirst({
      where: { id, job_offer: { employer_id: employerId } },
    });
    if (!file) throw new NotFoundException('Fichier introuvable.');
    if (!file.storage_key || file.removed_at) {
      throw new NotFoundException(
        file.removed_at
          ? 'Ce fichier a été supprimé par votre équipe, avec le CV du candidat.'
          : 'Ce fichier a été supprimé à la fin de sa durée de conservation.',
      );
    }
    const downloaded = await this.storage.download(file.storage_key, {
      bucket: file.storage_bucket ?? undefined,
    });
    return {
      ...downloaded,
      contentType: file.mime_type,
      filename: `fichier-${file.id.slice(0, 8)}.${CV_EXTENSION[file.mime_type as keyof typeof CV_EXTENSION] ?? 'bin'}`,
    };
  }

  /**
   * The answers as the CV analysis reads them: a FILE answer becomes the
   * file's name and its text, rather than an id.
   */
  async notes(
    rows: {
      label: string;
      kind: OfferQuestionKind;
      value: string;
      passed?: boolean | null;
    }[],
  ): Promise<
    {
      question: string;
      answer: string;
      knockoutFailed: boolean;
      knockoutPassed?: boolean;
    }[]
  > {
    const ids = rows.flatMap((r) => {
      const f = r.kind === OfferQuestionKind.FILE ? fileAnswer(r.value) : null;
      return f ? [f.id] : [];
    });
    const files = ids.length
      ? await this.prisma.answerFile.findMany({
          where: { id: { in: ids } },
          select: { id: true, text: true },
        })
      : [];
    const text = new Map(files.map((f) => [f.id, f.text]));
    return rows.map((r) => {
      let answer = answerText(r);
      const f = r.kind === OfferQuestionKind.FILE ? fileAnswer(r.value) : null;
      if (f) {
        const body = text.get(f.id);
        answer = body
          ? `Fichier « ${f.name} » :\n${body}`
          : `Fichier « ${f.name} » (photo ou fichier sans texte lisible)`;
      }
      return {
        question: r.label,
        answer,
        knockoutFailed: r.passed === false,
        ...(r.passed === true ? { knockoutPassed: true } : {}),
      };
    });
  }

  /**
   * Deleted by the business, with the candidate's CV. Due now: what the
   * storage would not delete, the sweep tries again.
   */
  async remove(ids: string[], now = new Date()): Promise<void> {
    if (ids.length === 0) return;
    const rows = await this.prisma.answerFile.findMany({
      where: { id: { in: ids }, storage_key: { not: null } },
      select: { id: true, storage_key: true, storage_bucket: true },
    });
    await this.prisma.answerFile.updateMany({
      where: { id: { in: ids } },
      data: { removed_at: now, expires_at: now, text: null },
    });
    await this.purge(rows);
  }

  /**
   * Hourly: uploads never used are deleted after a day, the others at their
   * date, moved on while the offer recruits (cv-retention.service.ts). The row
   * stays (its name in the answer).
   */
  async sweep(now = new Date()): Promise<number> {
    const rows = await this.prisma.answerFile.findMany({
      where: {
        storage_key: { not: null },
        OR: [
          {
            attached_at: null,
            created_at: { lt: new Date(now.getTime() - UNUSED_MS) },
          },
          { expires_at: { lte: now } },
        ],
      },
      select: { id: true, storage_key: true, storage_bucket: true },
      take: 500,
    });
    await this.purge(rows);
    return rows.length;
  }

  private async purge(
    rows: {
      id: string;
      storage_key: string | null;
      storage_bucket: string | null;
    }[],
  ): Promise<void> {
    for (const r of rows) {
      try {
        await this.storage.delete(r.storage_key as string, {
          bucket: r.storage_bucket ?? undefined,
        });
        await this.prisma.answerFile.update({
          where: { id: r.id },
          data: { storage_key: null, text: null },
        });
      } catch (err) {
        this.logger.warn(`Answer file ${r.id} not purged: ${String(err)}`);
      }
    }
  }
}
