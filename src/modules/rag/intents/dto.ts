import type { Projection } from './projections';

export const PROFILE_STATE: Projection = {
  owner: [
    'first_name',
    'profile_type',
    'status',
    'billing_status',
    'verification_status',
    // Why a KYC submission was refused, in the admin's own words. Without it the
    // assistant can only say "it was refused", which helps nobody.
    'rejection_reason',
    'kyc_verification_note',
    'whatsapp_connected',
    'reliability_score',
    'rating_avg',
    'rating_count',
    'city',
    'country_name',
    'avatar_url',
    'description',
    'categories',
    'portfolio_slug',
  ],
  public: [],
};

const JOB_OFFER_FIELDS = [
  'id',
  'reference',
  'title',
  'description',
  'employment_type',
  'amount',
  'payment_flow',
  'city',
  'country_name',
  'is_remote',
  'scheduled_at',
  'quantity',
  'status',
  'category',
] as const;

export const JOB_OFFER_SUMMARY: Projection = {
  owner: JOB_OFFER_FIELDS,
  public: JOB_OFFER_FIELDS,
};

export const APPLICATION_SUMMARY: Projection = {
  owner: ['id', 'status', 'created_at', 'updated_at', 'job_offer'],
  public: [],
};

export const UNLOCK_STATE: Projection = {
  owner: [
    'status',
    'employer_paid_at',
    'worker_paid_at',
    'expires_at',
    'created_at',
    'job_offer',
  ],
  public: [],
};

export const WALLET_BALANCE: Projection = {
  owner: ['balance', 'currency', 'owner_type'],
  public: [],
};

export const PENALTY_SUMMARY: Projection = {
  owner: ['id', 'amount', 'reason', 'status', 'created_at', 'job_offer'],
  public: [],
};

export const JOB_CATEGORY: Projection = {
  owner: ['slug', 'name', 'description', 'icon'],
  public: ['slug', 'name', 'description', 'icon'],
};
