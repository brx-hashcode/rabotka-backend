import type { BusinessPlan } from '@prisma/client';

/** A plan for the API: camelCase, as every other business payload. */
export function planView(
  p: BusinessPlan & {
    business?: { id: string; name: string; profile_id: string } | null;
  },
) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    /** Made for one business alone (« sur mesure »). */
    custom: p.business_id !== null,
    businessId: p.business_id,
    /** Who it is made for: admin reads only (the list includes it). */
    ...(p.business
      ? {
          business: {
            id: p.business.id,
            name: p.business.name,
            profileId: p.business.profile_id,
          },
        }
      : {}),
    description: p.description,
    monthlyPriceFcfa: p.monthly_price_fcfa,
    annualPriceFcfa: p.annual_price_fcfa,
    unlocksPerPeriod: p.unlocks_per_period,
    activeOffersLimit: p.active_offers_limit,
    cvScreeningsPerPeriod: p.cv_screenings_per_period,
    cvBatchMax: p.cv_batch_max,
    cvFileMaxMb: p.cv_file_max_mb,
    cvRetentionDays: p.cv_retention_days,
    cvChatQuestions: p.cv_chat_questions,
    offerDraftsPerPeriod: p.offer_drafts_per_period,
    recruitersLimit: p.recruiters_limit,
    reviewersLimit: p.reviewers_limit,
    includesPreselection: p.includes_preselection,
    priorityVisibility: p.priority_visibility,
    linkedinPosting: p.linkedin_posting,
    isActive: p.is_active,
    sortOrder: p.sort_order,
  };
}

/** The columns of a plan from its DTO (undefined keys are left alone). */
export function planData(dto: {
  code?: string;
  name?: string;
  description?: string | null;
  monthlyPriceFcfa?: number;
  annualPriceFcfa?: number;
  unlocksPerPeriod?: number | null;
  activeOffersLimit?: number | null;
  cvScreeningsPerPeriod?: number | null;
  cvBatchMax?: number;
  cvFileMaxMb?: number;
  cvRetentionDays?: number;
  cvChatQuestions?: number;
  offerDraftsPerPeriod?: number | null;
  recruitersLimit?: number | null;
  reviewersLimit?: number | null;
  includesPreselection?: boolean;
  priorityVisibility?: boolean;
  linkedinPosting?: boolean;
  isActive?: boolean;
  sortOrder?: number;
  businessId?: string | null;
}) {
  return {
    code: dto.code,
    name: dto.name,
    description: dto.description,
    monthly_price_fcfa: dto.monthlyPriceFcfa,
    annual_price_fcfa: dto.annualPriceFcfa,
    unlocks_per_period: dto.unlocksPerPeriod,
    active_offers_limit: dto.activeOffersLimit,
    cv_screenings_per_period: dto.cvScreeningsPerPeriod,
    cv_batch_max: dto.cvBatchMax,
    cv_file_max_mb: dto.cvFileMaxMb,
    cv_retention_days: dto.cvRetentionDays,
    cv_chat_questions: dto.cvChatQuestions,
    offer_drafts_per_period: dto.offerDraftsPerPeriod,
    recruiters_limit: dto.recruitersLimit,
    reviewers_limit: dto.reviewersLimit,
    includes_preselection: dto.includesPreselection,
    priority_visibility: dto.priorityVisibility,
    linkedin_posting: dto.linkedinPosting,
    is_active: dto.isActive,
    sort_order: dto.sortOrder,
    business_id: dto.businessId,
  };
}
