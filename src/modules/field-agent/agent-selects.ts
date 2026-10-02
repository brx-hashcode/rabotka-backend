import { Prisma } from '@prisma/client';

/**
 * Every shape the agent app can receive, as whitelisted Prisma selects.
 *
 * The rule this file exists to hold: an agent NEVER sees an employer's contact
 * details. None of the job selects below has an `employer` relation at all —
 * not a narrowed one, none — so there is nothing to forget to strip. Do not
 * build an agent response from ApplicationWithOffer or applicationListInclude
 * (application.service.ts): both carry `employer.phone`.
 *
 * Worker phones are not here either. They reach an agent only through the
 * phone-reveal endpoint, which logs and caps every reveal.
 */

/** The agent's own account, for `GET agent/me` and the login response. */
export const AGENT_SELF_SELECT = {
  id: true,
  first_name: true,
  last_name: true,
  email: true,
  phone: true,
  avatar_url: true,
  status: true,
  zones: {
    select: { country_code: true, city: true },
    orderBy: [{ country_code: 'asc' }, { city: 'asc' }],
  },
} as const satisfies Prisma.AgentSelect;

export type AgentSelfRow = Prisma.AgentGetPayload<{
  select: typeof AGENT_SELF_SELECT;
}>;

export function toAgentSelf(a: AgentSelfRow) {
  return {
    id: a.id,
    firstName: a.first_name,
    lastName: a.last_name,
    email: a.email,
    phone: a.phone,
    avatarUrl: a.avatar_url,
    status: a.status,
    zones: a.zones.map((z) => ({ countryCode: z.country_code, city: z.city })),
  };
}

/**
 * A job as an agent sees it. The site `address` is included — it is where the
 * work happens, which a worker needs to hear before saying yes, and workers see
 * it on the offer anyway. `note` is not: it is the employer's free text, and
 * free text is where a phone number ends up.
 */
export const AGENT_JOB_SELECT = {
  id: true,
  reference: true,
  title: true,
  description: true,
  employment_type: true,
  scheduled_at: true,
  amount: true,
  payment_flow: true,
  address: true,
  is_remote: true,
  country_code: true,
  country_name: true,
  city: true,
  quantity: true,
  status: true,
  created_at: true,
  category: { select: { id: true, name: true, slug: true } },
} as const satisfies Prisma.JobOfferSelect;

export type AgentJobRow = Prisma.JobOfferGetPayload<{
  select: typeof AGENT_JOB_SELECT;
}>;

export function toAgentJob(j: AgentJobRow, filledSeats: number) {
  return {
    id: j.id,
    reference: j.reference,
    title: j.title,
    description: j.description,
    employmentType: j.employment_type,
    scheduledAt: j.scheduled_at,
    amount: j.amount === null ? null : Number(j.amount),
    paymentFlow: j.payment_flow,
    address: j.address,
    isRemote: j.is_remote,
    countryCode: j.country_code,
    countryName: j.country_name,
    city: j.city,
    quantity: j.quantity,
    seatsLeft: Math.max(j.quantity - filledSeats, 0),
    status: j.status,
    createdAt: j.created_at,
    category: j.category,
  };
}

/**
 * A suggested worker. Modelled on the employer's recommended-worker card
 * (WORKER_SELECT in mobile-recommendation.controller.ts) minus the address
 * line: no phone, no email, no street.
 */
export const AGENT_CANDIDATE_SELECT = {
  id: true,
  first_name: true,
  last_name: true,
  avatar_url: true,
  description: true,
  city: true,
  reliability_score: true,
  rating_avg: true,
  rating_count: true,
  verification_status: true,
  categories: { select: { category: { select: { name: true } } } },
} as const satisfies Prisma.ProfileSelect;

export type AgentCandidateRow = Prisma.ProfileGetPayload<{
  select: typeof AGENT_CANDIDATE_SELECT;
}>;

export function toAgentCandidate(p: AgentCandidateRow, score: number) {
  return {
    id: p.id,
    firstName: p.first_name,
    lastName: p.last_name,
    avatarUrl: p.avatar_url,
    description: p.description,
    city: p.city,
    reliabilityScore: p.reliability_score,
    ratingAvg: p.rating_avg,
    ratingCount: p.rating_count,
    verificationStatus: p.verification_status,
    categories: p.categories.map((c) => c.category.name),
    score,
  };
}
