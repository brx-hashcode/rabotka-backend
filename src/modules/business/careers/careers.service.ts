import { Injectable, NotFoundException } from '@nestjs/common';
import { JobOfferStatus, VerificationStatus } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { candidateQuestion } from '../../job-offer/offer-questions';
import { BUSINESS_CATEGORY_LABELS } from '../business-catalog';

const OPEN: JobOfferStatus[] = [
  JobOfferStatus.ACTIVE,
  JobOfferStatus.PARTIALLY_FILLED,
];

const COMPANY_SELECT = {
  profile_id: true,
  public_slug: true,
  name: true,
  category: true,
  city: true,
  website: true,
  description: true,
  profile: { select: { avatar_url: true } },
} as const;

const OFFER_SELECT = {
  reference: true,
  title: true,
  employment_type: true,
  scheduled_at: true,
  is_remote: true,
  city: true,
  country_name: true,
  quantity: true,
} as const;

/**
 * A business's public careers page, for candidates who are not on Rabotka:
 * who it is and what it has open. Nothing here needs a session, so everything
 * goes through an explicit select: never an address, a contact, or the
 * answers a question accepts. An unverified business has no page.
 */
@Injectable()
export class CareersService {
  constructor(private readonly prisma: PrismaService) {}

  async company(slug: string) {
    const business = await this.business(slug);
    const offers = await this.prisma.jobOffer.findMany({
      where: this.openOffers(business.profile_id),
      orderBy: { created_at: 'desc' },
      select: OFFER_SELECT,
    });
    return {
      company: this.companyView(business),
      offers: offers.map((o) => this.offerView(o)),
    };
  }

  async offer(slug: string, reference: string) {
    const business = await this.business(slug);
    const offer = await this.prisma.jobOffer.findFirst({
      where: { ...this.openOffers(business.profile_id), reference },
      select: {
        ...OFFER_SELECT,
        description: true,
        amount: true,
        payment_flow: true,
        category: { select: { name: true } },
        questions: { orderBy: { position: 'asc' } },
      },
    });
    if (!offer) throw new NotFoundException('Cette offre est fermée.');
    return {
      company: this.companyView(business),
      offer: {
        ...this.offerView(offer),
        description: offer.description,
        amount: offer.amount === null ? null : Number(offer.amount),
        paymentFlow: offer.payment_flow,
        categoryName: offer.category?.name ?? null,
        questions: offer.questions.map(candidateQuestion),
      },
    };
  }

  private async business(slug: string) {
    const business = await this.prisma.business.findFirst({
      where: {
        public_slug: slug,
        deleted_at: null,
        verification_status: VerificationStatus.VERIFIED,
      },
      select: COMPANY_SELECT,
    });
    if (!business) throw new NotFoundException('Page introuvable.');
    return business;
  }

  /** Open and not past its closing date, which the expiry job may not have reached. */
  private openOffers(employerId: string) {
    return {
      employer_id: employerId,
      status: { in: OPEN },
      deleted_at: null,
      OR: [{ scheduled_at: null }, { scheduled_at: { gte: new Date() } }],
    };
  }

  private companyView(b: {
    public_slug: string | null;
    name: string;
    category: keyof typeof BUSINESS_CATEGORY_LABELS;
    city: string | null;
    website: string | null;
    description: string | null;
    profile: { avatar_url: string | null };
  }) {
    return {
      slug: b.public_slug,
      name: b.name,
      logoUrl: b.profile.avatar_url,
      categoryLabel: BUSINESS_CATEGORY_LABELS[b.category],
      city: b.city,
      website: b.website,
      description: b.description,
    };
  }

  private offerView(o: {
    reference: string;
    title: string;
    employment_type: string;
    scheduled_at: Date | null;
    is_remote: boolean;
    city: string | null;
    country_name: string | null;
    quantity: number;
  }) {
    return {
      reference: o.reference,
      title: o.title,
      employmentType: o.employment_type,
      closesAt: o.scheduled_at?.toISOString() ?? null,
      isRemote: o.is_remote,
      city: o.city,
      countryName: o.country_name,
      quantity: o.quantity,
    };
  }
}
