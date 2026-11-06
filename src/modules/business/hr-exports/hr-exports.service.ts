import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ApplicationStatus,
  ContactUnlockStatus,
  ExternalApplicationStatus,
} from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { sourceLabel } from '../report/business-report-sheets';
import { tablesCsv, tablesXlsx, type TableFile } from '../report/table-files';
import { BusinessSubscriptionService } from '../subscription/business-subscription.service';
import {
  acpeTable,
  candidatesTable,
  day,
  staffTable,
  type CandidateRow,
  type HireRow,
} from './hr-export-tables';

export type ExportFormat = 'xlsx' | 'csv';
export type ExportedFile =
  | { format: 'xlsx'; buffer: Buffer; filename: string }
  | { format: 'csv'; text: string; filename: string };

/** A hire who later cancelled or was dropped is not in the register. */
const HIRED: ApplicationStatus[] = [
  ApplicationStatus.ACCEPTED,
  ApplicationStatus.WAITING_PAYMENT,
  ApplicationStatus.STARTED,
  ApplicationStatus.END,
];

/** Where a careers-page candidate came from, as the candidates list says it. */
function careersOrigin(source: string | null): string {
  return !source || source === 'carrieres' || source === 'direct'
    ? 'Page carrières'
    : `Page carrières · ${sourceLabel(source)}`;
}

/**
 * « Exports RH », a plan service: an offer's candidates, the staff register of
 * the hires, the offers to declare to the ACPE — as Excel or CSV. A Rabotka
 * candidate's phone and e-mail are in only once its contact was obtained.
 */
@Injectable()
export class HrExportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: BusinessSubscriptionService,
  ) {}

  async candidates(profileId: string, offerId: string, format: ExportFormat) {
    const business = await this.business(profileId);
    const offer = await this.prisma.jobOffer.findFirst({
      where: { id: offerId, employer_id: business.profile_id },
      select: { id: true, title: true, reference: true },
    });
    if (!offer) throw new NotFoundException('Offre introuvable.');

    const [rabotka, careers] = await Promise.all([
      this.prisma.application.findMany({
        where: { job_offer_id: offer.id, deleted_at: null },
        orderBy: { created_at: 'desc' },
        select: {
          status: true,
          created_at: true,
          knocked_out: true,
          agent_id: true,
          worker: {
            select: {
              first_name: true,
              last_name: true,
              phone: true,
              email: true,
            },
          },
          cv_resume: { select: { score: true } },
          assessment: { select: { score: true } },
          contact_unlock_attempt: { select: { status: true } },
        },
      }),
      this.prisma.externalApplication.findMany({
        where: { job_offer_id: offer.id },
        orderBy: { created_at: 'desc' },
        select: {
          first_name: true,
          last_name: true,
          email: true,
          phone: true,
          status: true,
          source: true,
          created_at: true,
          knocked_out: true,
          cv_resume: { select: { score: true } },
        },
      }),
    ]);

    const rows: CandidateRow[] = [
      ...rabotka.map((a) => {
        const obtained =
          a.contact_unlock_attempt?.status === ContactUnlockStatus.UNLOCKED;
        return {
          lastName: a.worker.last_name ?? '',
          firstName: a.worker.first_name ?? '',
          origin: a.agent_id ? 'Agents Rabotka' : 'Rabotka',
          status: { rabotka: a.status },
          score: a.cv_resume?.score ?? a.assessment?.score ?? null,
          appliedAt: a.created_at,
          phone: obtained ? (a.worker.phone ?? null) : null,
          email: obtained ? (a.worker.email ?? null) : null,
          knockedOut: a.knocked_out,
        };
      }),
      ...careers.map((e) => ({
        lastName: e.last_name,
        firstName: e.first_name,
        origin: careersOrigin(e.source),
        status: { careers: e.status },
        score: e.cv_resume?.score ?? null,
        appliedAt: e.created_at,
        phone: e.phone,
        email: e.email,
        knockedOut: e.knocked_out,
      })),
    ].sort((x, y) => y.appliedAt.getTime() - x.appliedAt.getTime());

    return this.file(format, `candidats-${offer.reference}`, {
      title: `Candidats — ${offer.title} (${offer.reference})`,
      subtitle: `${business.name} · exporté le ${day(new Date())}`,
      tables: [candidatesTable(rows)],
      generatedAt: new Date(),
      empty: 'Aucun candidat pour cette offre.',
    });
  }

  async staffRegister(profileId: string, format: ExportFormat) {
    const business = await this.business(profileId);
    const offerOf = {
      select: {
        title: true,
        reference: true,
        employment_type: true,
        scheduled_at: true,
        amount: true,
        payment_flow: true,
        city: true,
      },
    } as const;
    const [rabotka, careers] = await Promise.all([
      this.prisma.application.findMany({
        where: {
          deleted_at: null,
          status: { in: HIRED },
          job_offer: { employer_id: business.profile_id },
        },
        select: {
          accepted_at: true,
          agent_id: true,
          worker: {
            select: {
              first_name: true,
              last_name: true,
              phone: true,
              email: true,
            },
          },
          contact_unlock_attempt: { select: { status: true } },
          job_offer: offerOf,
        },
      }),
      this.prisma.externalApplication.findMany({
        where: {
          status: ExternalApplicationStatus.RETAINED,
          job_offer: { employer_id: business.profile_id },
        },
        select: {
          first_name: true,
          last_name: true,
          email: true,
          phone: true,
          source: true,
          retained_at: true,
          job_offer: offerOf,
        },
      }),
    ]);

    const hire = (
      o: (typeof rabotka)[number]['job_offer'],
    ): Pick<
      HireRow,
      | 'post'
      | 'reference'
      | 'contract'
      | 'missionAt'
      | 'amount'
      | 'paymentFlow'
      | 'city'
    > => ({
      post: o.title,
      reference: o.reference,
      contract: o.employment_type,
      missionAt: o.scheduled_at,
      amount: o.amount === null ? null : Number(o.amount),
      paymentFlow: o.payment_flow,
      city: o.city,
    });
    const rows: HireRow[] = [
      ...rabotka.map((a) => {
        const obtained =
          a.contact_unlock_attempt?.status === ContactUnlockStatus.UNLOCKED;
        return {
          lastName: a.worker.last_name ?? '',
          firstName: a.worker.first_name ?? '',
          ...hire(a.job_offer),
          hiredAt: a.accepted_at,
          origin: a.agent_id ? 'Agents Rabotka' : 'Rabotka',
          phone: obtained ? (a.worker.phone ?? null) : null,
          email: obtained ? (a.worker.email ?? null) : null,
        };
      }),
      ...careers.map((e) => ({
        lastName: e.last_name,
        firstName: e.first_name,
        ...hire(e.job_offer),
        hiredAt: e.retained_at,
        origin: careersOrigin(e.source),
        phone: e.phone,
        email: e.email,
      })),
    ].sort((x, y) => (y.hiredAt?.getTime() ?? 0) - (x.hiredAt?.getTime() ?? 0));

    const today = day(new Date());
    return this.file(format, `registre-du-personnel-${today}`, {
      title: `Registre du personnel — ${business.name}`,
      subtitle: `Personnes recrutées avec Rabotka · au ${today}`,
      tables: [staffTable(rows)],
      generatedAt: new Date(),
      empty: 'Personne n’a encore été recruté.',
    });
  }

  /** The offers published in the last `days` (all of them when null). */
  async acpe(profileId: string, days: number | null, format: ExportFormat) {
    const business = await this.business(profileId);
    const since = days ? new Date(Date.now() - days * 86_400_000) : null;
    const offers = await this.prisma.jobOffer.findMany({
      where: {
        employer_id: business.profile_id,
        deleted_at: null,
        ...(since ? { created_at: { gte: since } } : {}),
      },
      orderBy: { created_at: 'desc' },
      select: {
        reference: true,
        title: true,
        employment_type: true,
        quantity: true,
        city: true,
        country_name: true,
        address: true,
        created_at: true,
        scheduled_at: true,
        amount: true,
        payment_flow: true,
        description: true,
        status: true,
        category: { select: { name: true } },
      },
    });
    const today = day(new Date());
    return this.file(format, `offres-acpe-${today}`, {
      title: `Offres à déclarer à l’ACPE — ${business.name}`,
      subtitle: since
        ? `Publiées depuis le ${day(since)} · exporté le ${today}`
        : `Toutes les offres · exporté le ${today}`,
      tables: [
        acpeTable(
          offers.map((o) => ({
            reference: o.reference,
            title: o.title,
            category: o.category?.name ?? null,
            contract: o.employment_type,
            quantity: o.quantity,
            city: o.city,
            countryName: o.country_name,
            address: o.address,
            publishedAt: o.created_at,
            scheduledAt: o.scheduled_at,
            amount: o.amount === null ? null : Number(o.amount),
            paymentFlow: o.payment_flow,
            description: o.description,
            status: o.status,
          })),
        ),
      ],
      generatedAt: new Date(),
      empty: 'Aucune offre sur la période.',
    });
  }

  private async file(
    format: ExportFormat,
    name: string,
    file: TableFile,
  ): Promise<ExportedFile> {
    return format === 'csv'
      ? { format, text: tablesCsv(file), filename: `${name}.csv` }
      : { format, buffer: await tablesXlsx(file), filename: `${name}.xlsx` };
  }

  /** The business, refused when its plan leaves « Exports RH » out. */
  private async business(profileId: string) {
    const businessId = await this.subscriptions.businessOf(profileId);
    if (!businessId) {
      throw new ForbiddenException('Espace réservé aux comptes entreprise.');
    }
    const e = await this.subscriptions.entitlements(businessId);
    if (!e.hrExports) {
      throw new ForbiddenException(
        'Les exports RH sont inclus dans les formules supérieures. Changez de formule depuis la rubrique « Abonnement ».',
      );
    }
    const business = await this.prisma.business.findUniqueOrThrow({
      where: { id: businessId },
      select: { profile_id: true, name: true },
    });
    return business;
  }
}
