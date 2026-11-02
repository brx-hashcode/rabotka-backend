import { EmploymentType, type PaymentFlow } from '@prisma/client';

/**
 * The open offers as one XML feed, in the layout Indeed made common and most
 * aggregators read (Jooble, Careerjet, Talent.com, Jora…). Each job links back
 * to its careers page with `?source=<site>`, so applications say where they
 * came from. Never an address or a contact detail.
 */

export type FeedJob = {
  slug: string;
  company: string;
  reference: string;
  title: string;
  description: string;
  employmentType: EmploymentType;
  createdAt: Date;
  closesAt: Date | null;
  city: string | null;
  countryName: string | null;
  isRemote: boolean;
  amount: number | null;
  paymentFlow: PaymentFlow | null;
};

/** Aggregators drop a job past 45 days; an open-ended offer is still open. */
const MAX_AGE_DAYS = 40;
const DAY_MS = 24 * 60 * 60 * 1000;

const JOB_TYPE: Record<EmploymentType, string> = {
  MISSION: 'temporary',
  CDD: 'contract',
  CDI: 'fulltime',
  STAGE: 'internship',
};

const PER: Partial<Record<PaymentFlow, string>> = {
  TASK: 'la mission',
  HOURLY: 'heure',
  DAILY: 'jour',
  MONTHLY: 'mois',
};

/** A site's key in links and stats: lower-case letters, digits and dashes. */
export function feedSite(raw: unknown): string {
  return typeof raw === 'string' && /^[a-z0-9-]{1,30}$/.test(raw)
    ? raw
    : 'feed';
}

const cdata = (s: string) =>
  `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
const xmlText = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function salary(job: FeedJob): string | null {
  if (job.amount === null) return null;
  const amount = `${job.amount.toLocaleString('fr-FR')} FCFA`;
  const per = job.paymentFlow ? PER[job.paymentFlow] : undefined;
  return per ? `${amount} / ${per}` : amount;
}

export function jobsFeedXml(
  jobs: FeedJob[],
  options: { site: string; baseUrl: string; now: Date },
): string {
  const { site, baseUrl, now } = options;
  const oldest = new Date(now.getTime() - MAX_AGE_DAYS * DAY_MS);
  const items = jobs.map((job) => {
    const url = `${baseUrl}/carrieres/${encodeURIComponent(job.slug)}/${encodeURIComponent(job.reference)}?source=${site}`;
    const date = job.createdAt < oldest ? oldest : job.createdAt;
    const pay = salary(job);
    return [
      '  <job>',
      `    <title>${cdata(job.title)}</title>`,
      `    <date>${cdata(date.toUTCString())}</date>`,
      `    <referencenumber>${cdata(job.reference)}</referencenumber>`,
      `    <url>${cdata(url)}</url>`,
      `    <company>${cdata(job.company)}</company>`,
      `    <city>${cdata(job.isRemote ? 'Télétravail' : (job.city ?? ''))}</city>`,
      `    <country>${cdata(job.countryName ?? 'Congo')}</country>`,
      `    <description>${cdata(job.description)}</description>`,
      `    <jobtype>${cdata(JOB_TYPE[job.employmentType])}</jobtype>`,
      ...(pay ? [`    <salary>${cdata(pay)}</salary>`] : []),
      ...(job.closesAt
        ? [
            `    <expirationdate>${cdata(job.closesAt.toUTCString())}</expirationdate>`,
          ]
        : []),
      '  </job>',
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<source>',
    '  <publisher>Rabotka</publisher>',
    `  <publisherurl>${xmlText(baseUrl)}</publisherurl>`,
    `  <lastBuildDate>${now.toUTCString()}</lastBuildDate>`,
    ...items,
    '</source>',
    '',
  ].join('\n');
}
