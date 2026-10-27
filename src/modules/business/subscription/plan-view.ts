import type { BusinessPlan } from '@prisma/client';

/** A plan for the API: camelCase, as every other business payload. */
export function planView(p: BusinessPlan) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
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
    includesPreselection: p.includes_preselection,
    includesFieldAgents: p.includes_field_agents,
    priorityVisibility: p.priority_visibility,
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
  includesPreselection?: boolean;
  includesFieldAgents?: boolean;
  priorityVisibility?: boolean;
  isActive?: boolean;
  sortOrder?: number;
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
    includes_preselection: dto.includesPreselection,
    includes_field_agents: dto.includesFieldAgents,
    priority_visibility: dto.priorityVisibility,
    is_active: dto.isActive,
    sort_order: dto.sortOrder,
  };
}
