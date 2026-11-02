import ExcelJS from 'exceljs';
import type { ReportInput } from './business-report';
import { OFFER_STATUS_LABEL } from './business-report';

/**
 * The recruitment report as data: the PDF's sections as tables, for Excel
 * (one sheet each) and CSV (one after the other). Values stay raw numbers so
 * they can be summed and charted; empty means « not enough data ».
 */

export type Cell = string | number | null;
export type ReportTable = {
  /** The sheet's name (31 characters at most, Excel's limit). */
  name: string;
  header: string[];
  rows: Cell[][];
};

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

const sourceLabel = (s: string) =>
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

/** One sheet per table, a styled header, numbers kept as numbers. */
export async function reportXlsx(input: ReportInput): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Rabotka';
  workbook.created = input.generatedAt;

  for (const table of reportTables(input)) {
    const sheet = workbook.addWorksheet(table.name.slice(0, 31));
    const title = sheet.addRow([
      `Rapport de recrutement — ${input.businessName}`,
    ]);
    title.font = { bold: true, size: 14 };
    sheet.addRow([periodLine(input)]).font = {
      color: { argb: 'FF5A655F' },
    };
    sheet.addRow([]);

    const head = sheet.addRow(table.header);
    head.height = 22;
    head.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF0FA84C' },
      };
      cell.alignment = { vertical: 'middle' };
    });
    for (const row of table.rows) sheet.addRow(row);
    if (!table.rows.length) {
      sheet.addRow(['Aucune donnée sur la période.']).font = {
        italic: true,
        color: { argb: 'FF7A857F' },
      };
    }

    sheet.views = [{ state: 'frozen', ySplit: head.number }];
    table.header.forEach((label, i) => {
      const longest = Math.max(
        label.length,
        ...table.rows.map((r) => String(r[i] ?? '').length),
      );
      sheet.getColumn(i + 1).width = Math.min(Math.max(longest + 2, 12), 60);
    });
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/**
 * The tables one after the other, each under its name, in the format a
 * French spreadsheet opens as is: `;` between cells, a decimal comma, and a
 * BOM so the accents survive.
 */
export function reportCsv(input: ReportInput): string {
  const cell = (v: Cell) => {
    if (v === null) return '';
    const text = typeof v === 'number' ? String(v).replace('.', ',') : v;
    return /[;"\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const line = (cells: Cell[]) => cells.map(cell).join(';');

  const blocks = reportTables(input).map((t) =>
    [line([t.name]), line(t.header), ...t.rows.map(line)].join('\r\n'),
  );
  const BOM = '\uFEFF';
  return `${BOM}${[
    line([`Rapport de recrutement — ${input.businessName}`]),
    line([periodLine(input)]),
    '',
    blocks.join('\r\n\r\n'),
  ].join('\r\n')}\r\n`;
}
