import type { ReportInput } from './business-report';
import {
  tablesCsv,
  tablesXlsx,
  type Cell,
  type DataTable,
} from './table-files';
import { OFFER_STATUS_LABEL } from './business-report';

/**
 * The recruitment report as data: the PDF's sections as tables, for Excel
 * (one sheet each) and CSV (one after the other). Values stay raw numbers so
 * they can be summed and charted; empty means « not enough data ».
 */

export type { Cell } from './table-files';
export type ReportTable = DataTable;

const SOURCE_LABEL: Record<string, string> = {
  rabotka: 'Rabotka',
  agent: 'Agents Rabotka',
  carrieres: 'Page carrières',
  direct: 'Lien direct',
  google: 'Google',
  bing: 'Bing',
  facebook: 'Facebook',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  x: 'X',
  whatsapp: 'WhatsApp',
  qr: 'Affiche (QR code)',
  jooble: 'Jooble',
  careerjet: 'Careerjet',
  indeed: 'Indeed',
  fuzu: 'Fuzu',
  talent: 'Talent.com',
  jora: 'Jora',
};

export const sourceLabel = (s: string) =>
  SOURCE_LABEL[s] ?? s.charAt(0).toUpperCase() + s.slice(1);

const share = (n: number, of: number) =>
  of ? Math.round((n / of) * 100) : null;

export function reportTables(input: ReportInput): ReportTable[] {
  const s = input.stats;
  const f = s.funnel;
  const costPerHire =
    s.hires.count > 0 && input.spend.total > 0
      ? Math.round(input.spend.total / s.hires.count)
      : null;

  const summary: ReportTable = {
    name: 'Résumé',
    header: ['Indicateur', 'Valeur', 'Période précédente', 'Unité'],
    rows: [
      [
        'Candidatures reçues',
        s.applications.received,
        s.applications.receivedPrevious,
        '',
      ],
      ['Candidatures par offre', s.applications.perOffer, null, ''],
      ['À examiner', s.applications.toReview, null, ''],
      ['Recrutements', s.hires.count, s.hires.previous, ''],
      ['Offres publiées', s.offers.published, s.offers.publishedPrevious, ''],
      ['Offres en ligne', s.offers.open, null, ''],
      ['Postes pourvus', s.quality.fillRate, null, '%'],
      ['Postes proposés', s.quality.positionsProposed, null, ''],
      ['Postes occupés', s.quality.positionsFilled, null, ''],
      [
        'Premier candidat après la publication',
        s.timing.firstApplicantHours,
        s.timing.firstApplicantHoursPrevious,
        'h',
      ],
      [
        'Votre première réponse à une candidature',
        s.timing.responseHours,
        s.timing.responseHoursPrevious,
        'h',
      ],
      [
        'De la publication au recrutement',
        s.timing.timeToHireDays,
        s.timing.timeToHireDaysPrevious,
        'j',
      ],
      ['Missions terminées', s.quality.missionsEnded, null, ''],
      ['Absences (candidat non venu)', s.quality.noShowRate, null, '%'],
      ['Note que vous avez donnée', s.quality.ratingGiven, null, '/5'],
      ['Note reçue des candidats', s.quality.ratingReceived, null, '/5'],
      [
        'Contacts obtenus',
        s.contacts.unlocked,
        s.contacts.unlockedPrevious,
        '',
      ],
      ['Entretiens proposés', input.interviews.proposed, null, ''],
      ['Entretiens confirmés', input.interviews.confirmed, null, ''],
      ['Entretiens déclinés', input.interviews.declined, null, ''],
      ['CV analysés par l’IA', input.cvAnalysed, null, ''],
      ['Abonnement', input.spend.subscription, null, 'FCFA'],
      ['Contacts obtenus hors formule', input.spend.contacts, null, 'FCFA'],
      ['Autres paiements', input.spend.other, null, 'FCFA'],
      ['Total payé sur la période', input.spend.total, null, 'FCFA'],
      ['Coût par recrutement', costPerHire, null, 'FCFA'],
    ],
  };

  const funnel: ReportTable = {
    name: 'Parcours',
    header: ['Étape', 'Candidatures', '% des reçues'],
    rows: (
      [
        ['Reçues', f.received],
        ['Examinées', f.viewed],
        ['Retenues', f.hired],
        ['En mission', f.started],
        ['Mission terminée', f.completed],
      ] as const
    ).map(([label, n]) => [label, n, share(n, f.received)]),
  };

  const offers: ReportTable = {
    name: 'Offres',
    header: ['Offre', 'Statut', 'Candidatures', 'Recrutés', 'Postes'],
    rows: input.offers.map((o) => [
      o.title,
      OFFER_STATUS_LABEL[o.status],
      o.received,
      o.hired,
      o.positions,
    ]),
  };

  const daily: ReportTable = {
    name: 'Par jour',
    header: ['Date', 'Candidatures', 'Recrutements'],
    rows: (s.series ?? []).map((d) => [d.date, d.applications, d.hires]),
  };

  const sources: ReportTable = {
    name: 'Sources',
    header: ['Source', 'Candidatures', 'Recrutés'],
    rows: (s.sources ?? []).map((r) => [
      sourceLabel(r.source),
      r.received,
      r.hired,
    ]),
  };

  return [summary, funnel, offers, daily, sources];
}

const periodLine = (input: ReportInput) =>
  `Du ${input.stats.period.from.slice(0, 10)} au ${input.stats.period.to.slice(0, 10)} (${input.stats.period.days} jours)`;

export function reportXlsx(input: ReportInput): Promise<Buffer> {
  return tablesXlsx(reportFile(input));
}

export function reportCsv(input: ReportInput): string {
  return tablesCsv(reportFile(input));
}

const reportFile = (input: ReportInput) => ({
  title: `Rapport de recrutement — ${input.businessName}`,
  subtitle: periodLine(input),
  tables: reportTables(input),
  generatedAt: input.generatedAt,
});
