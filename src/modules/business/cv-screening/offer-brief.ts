import type { Prisma } from '@prisma/client';
import { EMPLOYMENT_LABEL } from '../../job-offer/utils/employment-type.util';

/** What of an offer its candidates are measured against. */
export const OFFER_BRIEF = {
  id: true,
  title: true,
  description: true,
  employment_type: true,
  city: true,
  country_name: true,
  is_remote: true,
  note: true,
  category: { select: { name: true } },
} satisfies Prisma.JobOfferSelect;

type Offer = Prisma.JobOfferGetPayload<{ select: typeof OFFER_BRIEF }>;

/** The offer as the AI reads it. */
export function offerBrief(offer: Offer): {
  title: string;
  text: string;
  remote: boolean;
} {
  const place = offer.is_remote
    ? 'À distance'
    : [offer.city, offer.country_name].filter(Boolean).join(', ');
  const lines = [
    `Type : ${EMPLOYMENT_LABEL[offer.employment_type] ?? offer.employment_type}`,
    offer.category?.name ? `Métier : ${offer.category.name}` : null,
    place ? `Lieu : ${place}` : null,
    '',
    offer.description,
    offer.note ? `\n${offer.note}` : null,
  ].filter((l) => l !== null);
  return {
    title: offer.title,
    text: lines.join('\n').slice(0, 8000),
    remote: offer.is_remote,
  };
}
