import {
  AccountStatus,
  EmploymentType,
  JobOfferStatus,
  PaymentFlow,
  Prisma,
  VerificationStatus,
} from '@prisma/client';
import type { PublicOfferRow } from '../job-page-model';

export const OFFER_ID = 'a2a59adb-b517-48af-ab5c-b5cff8aa5529';

/** An open offer from a verified business, for the job page specs. */
export function row(over: Partial<PublicOfferRow> = {}): PublicOfferRow {
  return {
    id: OFFER_ID,
    reference: 'RBT-ABCDE',
    title: 'Chauffeur livreur',
    description: 'Livraisons en ville.\nPermis B exigé.',
    employment_type: EmploymentType.MISSION,
    scheduled_at: new Date('2026-11-05T08:00:00Z'),
    amount: new Prisma.Decimal(10000),
    payment_flow: PaymentFlow.DAILY,
    is_remote: false,
    country_code: 'CG',
    country_name: 'Congo',
    city: 'Brazzaville',
    quantity: 1,
    status: JobOfferStatus.ACTIVE,
    created_at: new Date('2026-10-20T08:00:00Z'),
    updated_at: new Date('2026-10-21T08:00:00Z'),
    deleted_at: null,
    category: { name: 'Livraison & Courses', slug: 'livraison-courses' },
    employer: {
      is_business: true,
      avatar_url: 'https://cdn.example/logo.png',
      city: 'Pointe-Noire',
      country_code: 'CG',
      status: AccountStatus.ACTIVE,
      deleted_at: null,
      business: {
        name: 'ZuaFood',
        verification_status: VerificationStatus.VERIFIED,
        deleted_at: null,
      },
    },
    ...over,
  };
}
