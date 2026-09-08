import type { Projection } from './projections';

/**
 * What `etat_du_profil` may show the account owner.
 *
 * KEYS ARE camelCase, and that is not cosmetic. This projection is applied to
 * `ProfileService.findById`, which returns `ProfileMeResponse` — a camelCase
 * DTO. The list used to be snake_case, and `project()` skips a field that is
 * absent from the source WITHOUT a word, so fourteen of the seventeen entries
 * were dropped on every call: no verification status, no reliability score, no
 * categories, no refusal reason. Only `status`, `city` and `description`
 * happened to spell the same in both.
 *
 * The tool's own description promises the model "statut de vérification et
 * MOTIF DE REFUS éventuel, score de fiabilité, note, ville, domaines" and tells
 * it never to state those without calling the tool. It was asking for facts the
 * tool could not return. `profile-projection.spec.ts` now pins every key here
 * against the DTO so this cannot rot again.
 *
 * Five fields were declared and have no counterpart on `ProfileMeResponse` at
 * all — `billing_status`, `kyc_verification_note`, `rating_avg`, `rating_count`,
 * `portfolio_slug`. They were never delivered, so dropping them changes no
 * behaviour; add them to `findById` first if the assistant should have them.
 */
export const PROFILE_STATE: Projection = {
  owner: [
    'firstName',
    'profileType',
    'status',
    'verificationStatus',
    // Why a KYC submission was refused, and why an account was suspended, in
    // the admin's own words. Without them the assistant can only say "it was
    // refused", which helps nobody — and the user has already received this
    // exact text by WhatsApp, so repeating it discloses nothing new.
    'rejectionReason',
    'suspensionReason',
    'whatsappConnected',
    'reliabilityScore',
    'city',
    'countryName',
    'avatarUrl',
    'description',
    'categoryNames',
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
