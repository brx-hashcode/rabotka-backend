import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { JobOfferStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { searchTokens } from '../../common/queries/text-search';
import { businessSiteUrl } from '../mail/audience';
import { LayoutService } from '../mail/layout.service';
import { MailService } from '../mail/mail.service';
import { poolInviteEmail } from '../mail/templates/external-application';
import { cleanTags } from './business-talent.service';

/** Where someone in « Mes profils » comes from, beyond Rabotka workers. */
export type PoolKind = 'external' | 'cv';

/** Results per page. */
const PAGE = 30;

type CvCandidateJson = {
  name?: string | null;
  currentTitle?: string | null;
  city?: string | null;
  email?: string | null;
  phone?: string | null;
  yearsExperience?: number | null;
};

/**
 * « Mes profils » beyond Rabotka workers, searchable by what their CV says:
 * - careers-page candidates who ticked « garder ma candidature », while that
 *   lasts (pool_expires_at);
 * - CVs the business analysed itself (« Analyse de CV »), while its plan
 *   keeps them — never longer: those people never agreed to more.
 * A Rabotka applicant's CV is left out: they are in « Mes profils » as
 * workers already. A business only ever sees its own.
 */
@Injectable()
export class PoolCandidatesService {
  private readonly logger = new Logger(PoolCandidatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly layout: LayoutService,
  ) {}

  async search(
    profileId: string,
    params: { q?: string; source: PoolKind; kept?: boolean; page?: number },
  ) {
    const page = Math.max(1, params.page ?? 1);
    const tokens = searchTokens(params.q);
    const ids =
      params.source === 'external'
        ? await this.externalIds(profileId, tokens, params.kept, page)
        : await this.cvIds(profileId, tokens, params.kept, page);
    const hasMore = ids.length > PAGE;
    const pageIds = ids.slice(0, PAGE);
    const items =
      params.source === 'external'
        ? await this.externalRows(profileId, pageIds)
        : await this.cvRows(profileId, pageIds);
    return { items, page, hasMore };
  }

  /** Keep someone (or edit the note and tags). A careers candidate only with their consent. */
  async save(
    profileId: string,
    kind: PoolKind,
    id: string,
    dto: { note?: string | null; tags?: string[] },
  ) {
    await this.assertKeepable(profileId, kind, id);
    const data = {
      note: dto.note?.trim().slice(0, 1000) || null,
      tags: cleanTags(dto.tags),
    };
    const key =
      kind === 'external'
        ? {
            employer_id_external_application_id: {
              employer_id: profileId,
              external_application_id: id,
            },
          }
        : {
            employer_id_cv_resume_id: {
              employer_id: profileId,
              cv_resume_id: id,
            },
          };
    await this.prisma.businessTalent.upsert({
      where: key,
      create: {
        employer_id: profileId,
        ...(kind === 'external'
          ? { external_application_id: id }
          : { cv_resume_id: id }),
        ...data,
      },
      update: data,
    });
    return { kept: true, ...data };
  }

  async remove(profileId: string, kind: PoolKind, id: string) {
    await this.prisma.businessTalent.deleteMany({
      where: {
        employer_id: profileId,
        ...(kind === 'external'
          ? { external_application_id: id }
          : { cv_resume_id: id }),
      },
    });
    return { kept: false };
  }

  /** « Inviter à postuler » to another open offer, by e-mail, with its careers-page link. */
  async invite(profileId: string, kind: PoolKind, id: string, offerId: string) {
    await this.assertKeepable(profileId, kind, id);
    const offer = await this.prisma.jobOffer.findFirst({
      where: { id: offerId, employer_id: profileId, deleted_at: null },
      select: {
        title: true,
        status: true,
        reference: true,
        employer: {
          select: { business: { select: { name: true, public_slug: true } } },
        },
      },
    });
    if (!offer) throw new NotFoundException('Offre introuvable.');
    if (
      offer.status !== JobOfferStatus.ACTIVE &&
      offer.status !== JobOfferStatus.PARTIALLY_FILLED
    ) {
      throw new BadRequestException(
        'Cette offre ne reçoit plus de candidatures.',
      );
    }
    const business = offer.employer.business;
    if (!business?.public_slug) {
      throw new BadRequestException(
        'Votre page carrières doit être en ligne pour inviter à postuler.',
      );
    }
    const who = await this.contactOf(profileId, kind, id);
    if (!who.email) {
      throw new BadRequestException(
        'Ce candidat n’a pas d’e-mail : invitation impossible.',
      );
    }
    if (kind === 'external' && who.offerId === offerId) {
      throw new ConflictException('Ce candidat a déjà postulé à cette offre.');
    }
    const url = `${businessSiteUrl()}/carrieres/${encodeURIComponent(business.public_slug)}/${encodeURIComponent(offer.reference)}?source=invitation`;
    await this.mail.sendMail({
      to: who.email,
      subject: `${business.name} vous invite à postuler · ${offer.title}`,
      html: await this.layout.wrap(
        poolInviteEmail({
          firstName: who.firstName || 'Bonjour',
          businessName: business.name,
          jobTitle: offer.title,
          url,
        }),
        {
          previewText: `Une offre pour vous : ${offer.title}`,
          product: 'business',
        },
      ),
    });
    return { invited: true };
  }

  // ── Inside ───────────────────────────────────────────────────────────

  /** Each word somewhere in the text, accents and case aside. */
  private matches(tokens: string[], text: Prisma.Sql): Prisma.Sql {
    if (tokens.length === 0) return Prisma.sql`TRUE`;
    return Prisma.join(
      tokens.map((t) => Prisma.sql`${text} LIKE ${`%${t}%`}`),
      ' AND ',
    );
  }

  private async externalIds(
    profileId: string,
    tokens: string[],
    kept: boolean | undefined,
    page: number,
  ) {
    const text = Prisma.sql`unaccent(lower(coalesce(ea.first_name,'') || ' ' || coalesce(ea.last_name,'') || ' ' || coalesce(jo.title,'') || ' ' || coalesce(r.cv_text,'') || ' ' || coalesce(r.candidate::text,'')))`;
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT ea.id FROM external_applications ea
      JOIN job_offers jo ON jo.id = ea.job_offer_id
      LEFT JOIN cv_screening_resumes r ON r.id = ea.cv_resume_id
      WHERE jo.employer_id = ${profileId}::uuid
        AND ea.pool_consent_at IS NOT NULL AND ea.pool_expires_at > now()
        ${kept ? Prisma.sql`AND EXISTS (SELECT 1 FROM business_talents t WHERE t.employer_id = ${profileId}::uuid AND t.external_application_id = ea.id)` : Prisma.empty}
        AND ${this.matches(tokens, text)}
      ORDER BY ea.created_at DESC
      LIMIT ${PAGE + 1} OFFSET ${(page - 1) * PAGE}`;
    return rows.map((r) => r.id);
  }

  private async cvIds(
    profileId: string,
    tokens: string[],
    kept: boolean | undefined,
    page: number,
  ) {
    const text = Prisma.sql`unaccent(lower(coalesce(r.cv_text,'') || ' ' || coalesce(r.candidate::text,'') || ' ' || coalesce(s.job_title,'')))`;
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT r.id FROM cv_screening_resumes r
      JOIN cv_screenings s ON s.id = r.screening_id
      JOIN businesses b ON b.id = s.business_id
      WHERE b.profile_id = ${profileId}::uuid
        AND r.status::text = 'SCORED' AND r.cv_text IS NOT NULL
        AND coalesce(r.expires_at, s.expires_at) > now()
        AND NOT EXISTS (SELECT 1 FROM external_applications ea WHERE ea.cv_resume_id = r.id)
        AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.cv_resume_id = r.id)
        ${kept ? Prisma.sql`AND EXISTS (SELECT 1 FROM business_talents t WHERE t.employer_id = ${profileId}::uuid AND t.cv_resume_id = r.id)` : Prisma.empty}
        AND ${this.matches(tokens, text)}
      ORDER BY r.created_at DESC
      LIMIT ${PAGE + 1} OFFSET ${(page - 1) * PAGE}`;
    return rows.map((r) => r.id);
  }

  private async keptOf(
    profileId: string,
    field: 'external_application_id' | 'cv_resume_id',
    ids: string[],
  ) {
    const rows = await this.prisma.businessTalent.findMany({
      where: { employer_id: profileId, [field]: { in: ids } },
      select: {
        external_application_id: true,
        cv_resume_id: true,
        note: true,
        tags: true,
        created_at: true,
      },
    });
    return new Map(
      rows.map((t) => [
        (field === 'cv_resume_id'
          ? t.cv_resume_id
          : t.external_application_id) as string,
        t,
      ]),
    );
  }

  private async externalRows(profileId: string, ids: string[]) {
    if (ids.length === 0) return [];
    const [rows, kept] = await Promise.all([
      this.prisma.externalApplication.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          first_name: true,
          last_name: true,
          email: true,
          phone: true,
          created_at: true,
          pool_expires_at: true,
          job_offer: { select: { id: true, title: true } },
          cv_resume: {
            select: { score: true, summary: true, candidate: true },
          },
        },
      }),
      this.keptOf(profileId, 'external_application_id', ids),
    ]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => {
      const r = byId.get(id);
      if (!r) return [];
      const c = (r.cv_resume?.candidate ?? {}) as CvCandidateJson;
      const k = kept.get(id);
      return [
        {
          kind: 'external' as const,
          id,
          name: `${r.first_name} ${r.last_name}`.trim(),
          email: r.email,
          phone: r.phone,
          currentTitle: c.currentTitle ?? null,
          city: c.city ?? null,
          score: r.cv_resume?.score ?? null,
          summary: r.cv_resume?.summary ?? null,
          appliedFor: { id: r.job_offer.id, title: r.job_offer.title },
          addedAt: r.created_at.toISOString(),
          keptUntil: r.pool_expires_at?.toISOString() ?? null,
          kept: !!k,
          note: k?.note ?? null,
          tags: k?.tags ?? [],
        },
      ];
    });
  }

  private async cvRows(profileId: string, ids: string[]) {
    if (ids.length === 0) return [];
    const [rows, kept] = await Promise.all([
      this.prisma.cvScreeningResume.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          created_at: true,
          expires_at: true,
          score: true,
          summary: true,
          candidate: true,
          file_name: true,
          screening: {
            select: { id: true, job_title: true, expires_at: true },
          },
        },
      }),
      this.keptOf(profileId, 'cv_resume_id', ids),
    ]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => {
      const r = byId.get(id);
      if (!r) return [];
      const c = (r.candidate ?? {}) as CvCandidateJson;
      const k = kept.get(id);
      return [
        {
          kind: 'cv' as const,
          id,
          screeningId: r.screening.id,
          name: c.name?.trim() || r.file_name,
          email: c.email ?? null,
          phone: c.phone ?? null,
          currentTitle: c.currentTitle ?? null,
          city: c.city ?? null,
          score: r.score,
          summary: r.summary,
          appliedFor: { id: null, title: r.screening.job_title },
          addedAt: r.created_at.toISOString(),
          keptUntil:
            (r.expires_at ?? r.screening.expires_at)?.toISOString() ?? null,
          kept: !!k,
          note: k?.note ?? null,
          tags: k?.tags ?? [],
        },
      ];
    });
  }

  /** Ours, and keepable now: a candidature still within its consent, a CV still kept. */
  private async assertKeepable(profileId: string, kind: PoolKind, id: string) {
    const now = new Date();
    if (kind === 'external') {
      const a = await this.prisma.externalApplication.findFirst({
        where: { id, job_offer: { employer_id: profileId } },
        select: { pool_expires_at: true },
      });
      if (!a) throw new NotFoundException('Candidature introuvable.');
      if (!a.pool_expires_at || a.pool_expires_at <= now) {
        throw new BadRequestException(
          'Le candidat n’a pas accepté d’être gardé pour d’autres postes.',
        );
      }
      return;
    }
    const r = await this.prisma.cvScreeningResume.findFirst({
      where: { id, screening: { business: { profile_id: profileId } } },
      select: {
        cv_text: true,
        expires_at: true,
        screening: { select: { expires_at: true } },
      },
    });
    if (!r) throw new NotFoundException('CV introuvable.');
    const until = r.expires_at ?? r.screening.expires_at;
    if (!r.cv_text || (until && until <= now)) {
      throw new BadRequestException('Ce CV n’est plus conservé.');
    }
  }

  private async contactOf(profileId: string, kind: PoolKind, id: string) {
    if (kind === 'external') {
      const a = await this.prisma.externalApplication.findFirstOrThrow({
        where: { id, job_offer: { employer_id: profileId } },
        select: { first_name: true, email: true, job_offer_id: true },
      });
      return {
        firstName: a.first_name,
        email: a.email,
        offerId: a.job_offer_id,
      };
    }
    const r = await this.prisma.cvScreeningResume.findFirstOrThrow({
      where: { id, screening: { business: { profile_id: profileId } } },
      select: { candidate: true },
    });
    const c = (r.candidate ?? {}) as CvCandidateJson;
    return {
      firstName: (c.name ?? '').trim().split(/\s+/)[0] ?? '',
      email: c.email?.trim() || null,
      offerId: null,
    };
  }
}
