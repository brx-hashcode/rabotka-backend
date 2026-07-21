import {
  Injectable,
  Inject,
  NotFoundException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Redis from 'ioredis';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../common/services/redis/redis.constants';
import { launchBrowser } from '../../common/utils/puppeteer';
import {
  Prisma,
  ProfileType,
  VerificationStatus,
  AssignmentStatus,
} from '@prisma/client';
import {
  rankResumeExperiences,
  RESUME_EXPERIENCE_LIMIT,
} from './resume-ranking';

/** A single accomplished mission as rendered in the CV. */
type ResumeJob = {
  period: string;
  employer: string;
  status: string;
  ongoing: boolean;
  title: string;
  amount: string;
  location: string;
};

type ResumeProfile = Prisma.ProfileGetPayload<{
  select: {
    first_name: true;
    last_name: true;
    email: true;
    phone: true;
    address: true;
    description: true;
    profile_type: true;
    verification_status: true;
    created_at: true;
    rating_avg: true;
    categories: { include: { category: true } };
  };
}>;

type ResumeAssignment = Prisma.AssignmentGetPayload<{
  include: {
    ratings: { select: { score: true } };
    job_offer: {
      select: {
        title: true;
        address: true;
        amount: true;
        scheduled_at: true;
        payment_flow: true;
        category_id: true;
        employer: { select: { first_name: true; last_name: true } };
      };
    };
  };
}>;

@Injectable()
export class ResumeService {
  private readonly logger = new Logger(ResumeService.name);

  private logoDataUri: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
  ) {}

  async download(
    profileId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const cacheKey = `${REDIS_KEY_PREFIX}pdf:resume:${profileId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      const named = await this.prisma.profile.findUnique({
        where: { id: profileId },
        select: { first_name: true, last_name: true },
      });
      return {
        buffer: Buffer.from(cached, 'base64'),
        filename: named
          ? buildResumeFilename(named.first_name, named.last_name)
          : `${profileId}_resume.pdf`,
      };
    }

    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        first_name: true,
        last_name: true,
        email: true,
        phone: true,
        address: true,
        description: true,
        profile_type: true,
        verification_status: true,
        created_at: true,
        rating_avg: true,
        categories: { include: { category: true } },
      },
    });

    if (!profile) {
      throw new NotFoundException('Profil introuvable');
    }

    // Stat strip counts completed missions; the list below ranks both completed
    // and current (in-progress) missions by relevance and shows the best few.
    const [totalCompleted, eligible] = await Promise.all([
      this.prisma.assignment.count({
        where: { worker_id: profileId, status: AssignmentStatus.COMPLETED },
      }),
      this.prisma.assignment.findMany({
        where: {
          worker_id: profileId,
          status: {
            in: [AssignmentStatus.COMPLETED, AssignmentStatus.CONFIRMED],
          },
        },
        include: {
          // The rating THIS worker earned on the mission (ratee = worker).
          ratings: { where: { ratee_id: profileId }, select: { score: true } },
          job_offer: {
            select: {
              title: true,
              address: true,
              amount: true,
              scheduled_at: true,
              payment_flow: true,
              category_id: true,
              employer: { select: { first_name: true, last_name: true } },
            },
          },
        },
        // Prefetch a bounded set ordered by recency; relevance ranking below
        // picks the final top few.
        orderBy: { job_offer: { scheduled_at: 'desc' } },
        take: 100,
      }),
    ]);

    const assignments = rankResumeExperiences(eligible, {
      targetCategoryIds: new Set(
        profile.categories.map((c) => c.category_id).filter(Boolean),
      ),
      ratingAvg: profile.rating_avg,
      limit: RESUME_EXPERIENCE_LIMIT,
    });

    const filename = buildResumeFilename(profile.first_name, profile.last_name);

    const html = this.buildResumeHtml(profile, assignments, totalCompleted);
    const buffer = await this.renderHtmlToPdf(html);

    await this.redis.setex(cacheKey, 3600, buffer.toString('base64'));
    return { buffer, filename };
  }

  private buildResumeHtml(
    profile: ResumeProfile,
    assignments: ResumeAssignment[],
    totalCompleted: number,
  ): string {
    const typeLabel =
      profile.profile_type === ProfileType.WORKER ? 'Travailleur' : 'Employeur';
    const verifLabel =
      profile.verification_status === VerificationStatus.VERIFIED
        ? 'Vérifié'
        : 'Non vérifié';
    const headline = `${typeLabel} ${verifLabel}`;
    const categoryLabel = profile.categories?.[0]?.category?.name ?? '';

    const description =
      profile.description?.trim() ||
      `${typeLabel} inscrit sur la plateforme Rabotka.`;

    const experiences: ResumeJob[] = assignments.map((a) => {
      const job = a.job_offer;
      const date = a.completed_at ?? job.scheduled_at;
      const inProgress = a.status === AssignmentStatus.CONFIRMED;
      return {
        period: date.toLocaleDateString('fr-FR').toUpperCase(),
        employer: `${job.employer.first_name} ${job.employer.last_name}`,
        status: inProgress ? 'En cours' : 'Terminé',
        ongoing: inProgress,
        title: job.title,
        amount: this.formatAmount(job.amount),
        location: job.address,
      };
    });

    // Stat strip shows the lifetime total; the list below is capped for layout.
    const missionsCount = String(totalCompleted);
    const experienceCountLabel =
      totalCompleted > experiences.length
        ? `${experiences.length} sur ${totalCompleted}`
        : `${totalCompleted} missions accomplies`;
    const generatedDate = new Date().toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });

    const esc = escapeHtml;

    // Headline line: "TYPE STATUT · CATÉGORIE" as plain uppercase text (no boxes).
    const headlineText = categoryLabel
      ? `${headline} · ${categoryLabel}`
      : headline;

    const experiencesHtml =
      experiences.length > 0
        ? experiences
            .map((job) => {
              // Green pill for completed, amber for an in-progress mission.
              const pill = job.ongoing
                ? 'background:#FEF3E2; border:1px solid #F7D9A8; color:#B4690E;'
                : 'background:#E7F8EE; border:1px solid #BCEACE; color:#0A8C42;';
              return `
      <div style="border-top:1px solid #E6EAE7; padding:17px 0;">
        <div style="display:flex; justify-content:space-between; align-items:baseline; gap:16px;">
          <div style="font-family:'Space Grotesk',sans-serif; font-size:10px; font-weight:600; letter-spacing:0.16em; text-transform:uppercase; color:#7A857F;">${esc(job.period)}&nbsp;&nbsp;·&nbsp;&nbsp;${esc(job.employer)}</div>
          <div style="flex-shrink:0; display:inline-flex; align-items:center; gap:6px; ${pill} font-family:'Space Grotesk',sans-serif; font-size:9px; font-weight:600; letter-spacing:0.14em; text-transform:uppercase; padding:3px 9px; border-radius:999px;">${esc(job.status)}</div>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:baseline; gap:16px; margin-top:7px;">
          <h3 style="font-family:'Space Grotesk',sans-serif; font-size:17px; font-weight:600; letter-spacing:-0.01em; margin:0; color:#0F1713;">${esc(job.title)}</h3>
          <div style="flex-shrink:0; font-family:'Space Grotesk',sans-serif; font-size:14px; font-weight:600; color:#0F1713;">${esc(job.amount)}</div>
        </div>
        <div style="margin-top:4px; font-size:12.5px; color:#5A655F;">${esc(job.location)}</div>
      </div>`;
            })
            .join('')
        : `<div style="border-top:1px solid #E6EAE7; margin-top:8px; padding:30px 0; text-align:center; color:#7A857F; font-size:13.5px; font-style:italic;">Aucune expérience pour le moment.</div>`;

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Hanken+Grotesk:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Space+Grotesk:wght@400;500;600;700&display=swap');
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; font-family: 'Hanken Grotesk', -apple-system, BlinkMacSystemFont, sans-serif; }
  @page { size: A4; margin: 0; }
</style>
</head>
<body>
<div class="cv-page" style="width:794px; height:1123px; overflow:hidden; margin:0 auto; background:#ffffff; color:#0F1713; padding:60px 58px 56px; box-sizing:border-box; position:relative; line-height:1.5;">

  <!-- HEADER -->
  <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:24px;">
    <div style="flex:1; min-width:0;">
      <div style="font-family:'Space Grotesk',sans-serif; font-size:10.5px; font-weight:600; letter-spacing:0.34em; text-transform:uppercase; color:#0FA84C;">CURRICULUM VITÆ&nbsp;&nbsp;·&nbsp;&nbsp;RABOTKA</div>
      <h1 style="font-family:'Space Grotesk',sans-serif; font-size:46px; font-weight:700; letter-spacing:-0.015em; text-transform:uppercase; line-height:1.0; margin:16px 0 0; color:#0F1713;">${esc(`${profile.first_name} ${profile.last_name}`)}</h1>
      <div style="margin-top:13px; font-family:'Space Grotesk',sans-serif; font-size:11px; font-weight:500; letter-spacing:0.18em; text-transform:uppercase; color:#5A655F;">${esc(headlineText)}</div>
    </div>
    <div style="flex-shrink:0;">
      ${this.logoHtml()}
    </div>
  </div>

  <!-- CONTACT LINE -->
  <div style="margin-top:22px; display:flex; flex-wrap:wrap; align-items:center; gap:14px; font-size:12.5px; color:#3C4641; letter-spacing:0.01em;">
    <span style="display:inline-flex; align-items:center; gap:7px;"><span style="width:5px; height:5px; border-radius:50%; background:#10C95A; display:inline-block;"></span>${esc(profile.email)}</span>
    <span style="display:inline-flex; align-items:center; gap:7px;"><span style="width:5px; height:5px; border-radius:50%; background:#10C95A; display:inline-block;"></span>${esc(profile.phone ?? '')}</span>
    <span style="display:inline-flex; align-items:center; gap:7px;"><span style="width:5px; height:5px; border-radius:50%; background:#10C95A; display:inline-block;"></span>${esc(profile.address)}</span>
  </div>

  <div style="height:3px; background:#0F1713; margin-top:22px;"></div>

  <!-- STATS STRIP -->
  <div style="display:grid; grid-template-columns:repeat(3,1fr); border-bottom:1px solid #E6EAE7;">
    <div style="padding:18px 22px 18px 0;">
      <div style="font-family:'Space Grotesk',sans-serif; font-size:32px; font-weight:700; letter-spacing:-0.02em; line-height:1; color:#0F1713;">${esc(missionsCount)}</div>
      <div style="margin-top:8px; font-family:'Space Grotesk',sans-serif; font-size:9.5px; font-weight:600; letter-spacing:0.18em; text-transform:uppercase; color:#7A857F;">Missions accomplies</div>
    </div>
    <div style="padding:18px 22px; border-left:1px solid #E6EAE7;">
      <div style="font-family:'Space Grotesk',sans-serif; font-size:32px; font-weight:700; letter-spacing:-0.02em; line-height:1; color:#0F1713;">${esc(String(profile.created_at.getFullYear()))}</div>
      <div style="margin-top:8px; font-family:'Space Grotesk',sans-serif; font-size:9.5px; font-weight:600; letter-spacing:0.18em; text-transform:uppercase; color:#7A857F;">Membre depuis</div>
    </div>
    <div style="padding:18px 0 18px 22px; border-left:1px solid #E6EAE7;">
      <div style="font-family:'Space Grotesk',sans-serif; font-size:32px; font-weight:700; letter-spacing:-0.02em; line-height:1; color:#0F1713;">${esc(typeLabel)}</div>
      <div style="margin-top:8px; font-family:'Space Grotesk',sans-serif; font-size:9.5px; font-weight:600; letter-spacing:0.18em; text-transform:uppercase; color:#7A857F;">Type de profil</div>
    </div>
  </div>

  <!-- PROFIL -->
  <div style="margin-top:34px; display:flex; align-items:baseline; gap:14px;">
    <div style="font-family:'Space Grotesk',sans-serif; font-size:10px; font-weight:700; letter-spacing:0.06em; color:#0FA84C;">01</div>
    <div style="font-family:'Space Grotesk',sans-serif; font-size:11px; font-weight:600; letter-spacing:0.28em; text-transform:uppercase; color:#0F1713;">Profil</div>
    <div style="flex:1; height:1px; background:#E6EAE7;"></div>
  </div>
  <p style="margin:16px 0 0; font-size:14px; line-height:1.7; color:#2B342F; text-align:justify; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:3; line-clamp:3; overflow:hidden;">${esc(description)}</p>

  <!-- EXPÉRIENCES -->
  <div style="margin-top:38px; display:flex; align-items:baseline; gap:14px;">
    <div style="font-family:'Space Grotesk',sans-serif; font-size:10px; font-weight:700; letter-spacing:0.06em; color:#0FA84C;">02</div>
    <div style="font-family:'Space Grotesk',sans-serif; font-size:11px; font-weight:600; letter-spacing:0.28em; text-transform:uppercase; color:#0F1713;">Expériences récentes</div>
    <div style="flex:1; height:1px; background:#E6EAE7;"></div>
    <div style="font-family:'Space Grotesk',sans-serif; font-size:10px; font-weight:500; letter-spacing:0.14em; text-transform:uppercase; color:#7A857F;">${esc(experienceCountLabel)}</div>
  </div>

  <div style="margin-top:8px; padding-bottom:80px;">
    ${experiencesHtml}
  </div>

  <!-- FOOTER -->
  <div style="position:absolute; left:58px; right:58px; bottom:30px; display:flex; justify-content:space-between; align-items:center; padding-top:14px; border-top:1px solid #E6EAE7; font-family:'Space Grotesk',sans-serif; font-size:9.5px; font-weight:500; letter-spacing:0.16em; text-transform:uppercase; color:#9AA49E;">
    <div>Rabotka&nbsp;&nbsp;·&nbsp;&nbsp;CV généré le ${esc(generatedDate)}</div>
    <div>P&nbsp;|&nbsp;1&nbsp;/&nbsp;1</div>
  </div>

</div>
</body>
</html>`;
  }

  private logoHtml(): string {
    const uri = this.getLogoDataUri();
    if (!uri) return '';
    return `<img src="${uri}" alt="Rabotka" style="width:64px; height:64px; object-fit:contain; display:block;">`;
  }

  private getLogoDataUri(): string | null {
    if (this.logoDataUri !== null) {
      return this.logoDataUri || null;
    }
    try {
      const logoPath = path.join(process.cwd(), 'assets', 'rabotka-logo.png');
      const base64 = fs.readFileSync(logoPath).toString('base64');
      this.logoDataUri = `data:image/png;base64,${base64}`;
    } catch {
      this.logger.warn(
        'Rabotka logo not found at assets/rabotka-logo.png — rendering CV without logo.',
      );
      this.logoDataUri = '';
    }
    return this.logoDataUri || null;
  }

  private formatAmount(amount: Prisma.Decimal | null): string {
    if (amount == null) return '—';
    const n = Number(amount);
    if (!Number.isFinite(n)) return '—';
    return `${n.toLocaleString('fr-FR')} FCFA`;
  }

  private async renderHtmlToPdf(html: string): Promise<Buffer> {
    try {
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const pdf = await page.pdf({
          format: 'A4',
          printBackground: true,
          displayHeaderFooter: false,
        });
        return Buffer.from(pdf);
      } finally {
        await browser.close();
      }
    } catch (err: any) {
      if (err?.status) throw err;
      // The client only ever sees the generic message, so without this the
      // real cause (missing Chromium, launch failure, render timeout) is lost
      // and the 500 is undiagnosable.
      this.logger.error(
        'Resume PDF generation failed',
        err instanceof Error ? err.stack : String(err),
      );
      throw new InternalServerErrorException('PDF generation unavailable');
    }
  }
}

/** Builds a safe "firstname_lastname_resume.pdf" download filename. */
function buildResumeFilename(firstName: string, lastName: string): string {
  const base = `${firstName}_${lastName}_resume`
    .normalize('NFD')
    .replaceAll(/[̀-ͯ]/g, '') // strip accents
    .replaceAll(/[^a-zA-Z0-9_-]/g, '_')
    .replaceAll(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `${base || 'resume'}.pdf`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
