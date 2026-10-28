import {
  AccountStatus,
  EmploymentType,
  PaymentFlow,
  Prisma,
  VerificationStatus,
} from '@prisma/client';
import { OPEN_STATUSES } from '../field-agent/agent-zones';
import { detectContacts } from '../profile-chat/moderation/detect';

/**
 * What the public job pages (`/emplois` on the candidate site) may show of an
 * offer, and how. Pure: no database, no request — the service fetches, these
 * decide, the renderer prints.
 *
 * Public means read by anyone and by search engines, so it shows the offer
 * (title, description, pay, city, type, dates) but never a way to reach the
 * employer around Rabotka: no street address, no phone or e-mail (the ones in
 * a description are masked), and a person posting for themselves stays
 * « Employeur particulier ». A verified business shows as itself.
 */

export const PAGE_SIZE = 20;

/** An offer with no closing date retires 30 days after it was posted. */
const OPEN_DAYS_WITHOUT_DATE = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export const PUBLIC_OFFER_SELECT = {
  id: true,
  reference: true,
  title: true,
  description: true,
  employment_type: true,
  scheduled_at: true,
  amount: true,
  payment_flow: true,
  is_remote: true,
  country_code: true,
  country_name: true,
  city: true,
  quantity: true,
  status: true,
  created_at: true,
  updated_at: true,
  deleted_at: true,
  category: { select: { name: true, slug: true } },
  employer: {
    select: {
      is_business: true,
      avatar_url: true,
      city: true,
      country_code: true,
      status: true,
      deleted_at: true,
      business: {
        select: { name: true, verification_status: true, deleted_at: true },
      },
    },
  },
} as const satisfies Prisma.JobOfferSelect;

export type PublicOfferRow = Prisma.JobOfferGetPayload<{
  select: typeof PUBLIC_OFFER_SELECT;
}>;

const CLOSED_ACCOUNTS: AccountStatus[] = [
  AccountStatus.SUSPENDED,
  AccountStatus.BANNED,
];

/**
 * Offers a public page lists: open, not past their closing date, from an
 * employer still in good standing.
 */
export function openOffersWhere(now: Date): Prisma.JobOfferWhereInput {
  return {
    deleted_at: null,
    status: { in: OPEN_STATUSES },
    OR: [
      { scheduled_at: { gt: now } },
      {
        scheduled_at: null,
        created_at: {
          gt: new Date(now.getTime() - OPEN_DAYS_WITHOUT_DATE * DAY_MS),
        },
      },
    ],
    employer: { deleted_at: null, status: { notIn: CLOSED_ACCOUNTS } },
  };
}

/** Same test as `openOffersWhere`, for one offer already in hand. */
export function isOpen(o: PublicOfferRow, now: Date): boolean {
  return (
    !o.deleted_at &&
    OPEN_STATUSES.includes(o.status) &&
    validThrough(o).getTime() > now.getTime() &&
    !o.employer.deleted_at &&
    !CLOSED_ACCOUNTS.includes(o.employer.status)
  );
}

/** When the offer stops taking applications. */
export function validThrough(o: {
  scheduled_at: Date | null;
  created_at: Date;
}): Date {
  return (
    o.scheduled_at ??
    new Date(o.created_at.getTime() + OPEN_DAYS_WITHOUT_DATE * DAY_MS)
  );
}

/** « Pointe-Noire » → `pointe-noire`; « Électricité & froid » → `electricite-froid`. */
export function slugify(text: string, max = 80): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

/** Where the job is done; null for a job done from anywhere. */
export function cityOf(o: {
  is_remote: boolean;
  city: string | null;
  employer: { city: string | null };
}): string | null {
  if (o.is_remote) return null;
  return o.city?.trim() || o.employer.city?.trim() || null;
}

export function countryOf(o: {
  country_code: string | null;
  employer: { country_code: string | null };
}): string | null {
  return (o.country_code ?? o.employer.country_code)?.toUpperCase() ?? null;
}

const UUID_TAIL =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** `/emplois/offre/chauffeur-livreur-brazzaville-<id>`: words for people, the id for us. */
export function offerPath(o: {
  id: string;
  title: string;
  is_remote: boolean;
  city: string | null;
  employer: { city: string | null };
}): string {
  const title = slugify(o.title, 70);
  const city = slugify(cityOf(o) ?? '');
  // « … de Pointe-Noire » already says where.
  const words =
    city && !`-${title}-`.includes(`-${city}-`)
      ? slugify(`${title} ${city}`, 70)
      : title;
  return `/emplois/offre/${words ? `${words}-` : ''}${o.id}`;
}

/** The offer id at the end of the path segment, whatever words precede it. */
export function offerIdFromParam(param: string): string | null {
  return UUID_TAIL.exec(param)?.[1]?.toLowerCase() ?? null;
}

export type PublicEmployer = {
  name: string;
  logoUrl: string | null;
  verifiedBusiness: boolean;
};

/** A verified business as itself; anyone else without a name to look up. */
export function publicEmployer(o: PublicOfferRow): PublicEmployer {
  const b = o.employer.business;
  if (
    o.employer.is_business &&
    b &&
    !b.deleted_at &&
    b.verification_status === VerificationStatus.VERIFIED
  ) {
    return {
      name: b.name,
      logoUrl: o.employer.avatar_url,
      verifiedBusiness: true,
    };
  }
  return {
    name: o.employer.is_business ? 'Entreprise' : 'Employeur particulier',
    logoUrl: null,
    verifiedBusiness: false,
  };
}

const MASK = '[coordonnées masquées]';

/** The description with every phone, e-mail, link or handle in it masked. */
export function maskContacts(text: string): string {
  const spans = detectContacts(text);
  if (spans.length === 0) return text;
  let out = '';
  let at = 0;
  for (const s of spans) {
    out += text.slice(at, s.start) + MASK;
    at = s.end;
  }
  return out + text.slice(at);
}

export function excerpt(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

export const EMPLOYMENT_LABEL: Record<EmploymentType, string> = {
  MISSION: 'Mission',
  CDD: 'CDD',
  CDI: 'CDI',
  STAGE: 'Stage',
};

/** schema.org `employmentType` values. */
const EMPLOYMENT_SCHEMA: Record<EmploymentType, string[]> = {
  MISSION: ['TEMPORARY'],
  CDD: ['FULL_TIME', 'TEMPORARY'],
  CDI: ['FULL_TIME'],
  STAGE: ['INTERN'],
};

const FLOW_LABEL: Record<PaymentFlow, string> = {
  HOURLY: 'par heure',
  DAILY: 'par jour',
  MONTHLY: 'par mois',
  TASK: 'la tâche',
};

/** schema.org `unitText`; a fixed price has none. */
const FLOW_UNIT: Partial<Record<PaymentFlow, string>> = {
  HOURLY: 'HOUR',
  DAILY: 'DAY',
  MONTHLY: 'MONTH',
};

/** CFA franc zones: Central (XAF) and West (XOF) Africa. */
const XAF = new Set(['CG', 'CM', 'GA', 'TD', 'CF', 'GQ']);
const XOF = new Set(['BJ', 'BF', 'CI', 'GW', 'ML', 'NE', 'SN', 'TG']);

/** « 10 000 FCFA par jour », or null when the pay is to be agreed. */
export function payLabel(o: {
  amount: Prisma.Decimal | null;
  payment_flow: PaymentFlow | null;
}): string | null {
  const amount = o.amount == null ? 0 : Number(o.amount);
  if (!amount) return null;
  const flow = o.payment_flow ? ` ${FLOW_LABEL[o.payment_flow]}` : '';
  return `${amount.toLocaleString('fr-FR')} FCFA${flow}`;
}

export function frDate(d: Date): string {
  return d.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Africa/Brazzaville',
  });
}

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * The schema.org JobPosting that puts the offer in Google's job search.
 * https://developers.google.com/search/docs/appearance/structured-data/job-posting
 */
export function jobPostingLd(o: PublicOfferRow, site: string) {
  const employer = publicEmployer(o);
  const city = cityOf(o);
  const country = countryOf(o) ?? 'CG';
  const description = maskContacts(o.description);
  const amount = o.amount == null ? 0 : Number(o.amount);
  const unit = o.payment_flow ? FLOW_UNIT[o.payment_flow] : undefined;
  const currency = XAF.has(country) ? 'XAF' : XOF.has(country) ? 'XOF' : null;

  return {
    '@context': 'https://schema.org/',
    '@type': 'JobPosting',
    title: o.title,
    description: esc(description).replace(/\r?\n/g, '<br>'),
    identifier: {
      '@type': 'PropertyValue',
      name: 'Rabotka',
      value: o.reference,
    },
    datePosted: o.created_at.toISOString(),
    validThrough: validThrough(o).toISOString(),
    employmentType: EMPLOYMENT_SCHEMA[o.employment_type],
    hiringOrganization: {
      '@type': 'Organization',
      name: employer.name,
      ...(employer.logoUrl ? { logo: employer.logoUrl } : {}),
    },
    ...(o.is_remote
      ? {
          jobLocationType: 'TELECOMMUTE',
          applicantLocationRequirements: { '@type': 'Country', name: country },
        }
      : {
          jobLocation: {
            '@type': 'Place',
            address: {
              '@type': 'PostalAddress',
              ...(city ? { addressLocality: city } : {}),
              addressCountry: country,
            },
          },
        }),
    ...(amount > 0 && unit && currency
      ? {
          baseSalary: {
            '@type': 'MonetaryAmount',
            currency,
            value: {
              '@type': 'QuantitativeValue',
              value: amount,
              unitText: unit,
            },
          },
        }
      : {}),
    ...(o.quantity > 1 ? { totalJobOpenings: o.quantity } : {}),
    directApply: false,
    url: `${site}${offerPath(o)}`,
  };
}

export type CityFacet = { slug: string; name: string; count: number };

/**
 * Cities with open offers, by slug — « Pointe-Noire » and « pointe noire » are
 * one page — named after their most frequent spelling, busiest first.
 */
export function cityFacets(cities: (string | null)[]): (CityFacet & {
  spellings: string[];
})[] {
  const bySlug = new Map<string, Map<string, number>>();
  for (const raw of cities) {
    const name = raw?.trim();
    if (!name) continue;
    const slug = slugify(name);
    if (!slug) continue;
    const spellings = bySlug.get(slug) ?? new Map<string, number>();
    spellings.set(name, (spellings.get(name) ?? 0) + 1);
    bySlug.set(slug, spellings);
  }
  return [...bySlug.entries()]
    .map(([slug, spellings]) => {
      const ranked = [...spellings.entries()].sort((a, b) => b[1] - a[1]);
      return {
        slug,
        name: ranked[0][0],
        count: ranked.reduce((n, [, c]) => n + c, 0),
        spellings: ranked.map(([s]) => s),
      };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'fr'));
}
