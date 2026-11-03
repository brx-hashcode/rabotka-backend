import {
  AccountStatus,
  DeliveryChannel,
  Prisma,
  ProfileType,
  VerificationStatus,
} from '@prisma/client';

/**
 * Who a broadcast is for.
 *
 * Stored on the row as Json rather than as columns: the filter set will grow,
 * and a broadcast is read far more often by its counters than by its criteria.
 * `AudienceFiltersDto` is the validated shape of the same thing.
 */
export type AudienceFilters = {
  profile_types?: ProfileType[];
  statuses?: AccountStatus[];
  verification_statuses?: VerificationStatus[];
  country_codes?: string[];
  cities?: string[];
  category_ids?: string[];
  /** Signed up on or after this instant. */
  created_from?: Date;
  created_to?: Date;
  /** Signed in within the last N days — the closest thing to "still around". */
  active_within_days?: number;
  whatsapp_connected?: boolean;
  has_email?: boolean;
  /** Always included, whatever the filters say. */
  include_profile_ids?: string[];
  /** Never included, whatever the filters say. Wins over the line above. */
  exclude_profile_ids?: string[];
};

/**
 * Turn audience filters into a Prisma `where`.
 *
 * Two rules are not the caller's to choose, which is why they live here rather
 * than in the DTO:
 *
 * 1. DELETED PROFILES ARE NEVER INCLUDED. A deleted account is not an audience
 *    member, and no admin should have to remember to say so.
 * 2. OPTED-OUT PROFILES ARE NEVER INCLUDED — that is what `respectOptOut`
 *    enforces, and it defaults to on. An announcement is exactly the kind of
 *    message someone opts out of, and a broadcast is the one place where
 *    forgetting that check reaches thousands of people at once.
 *
 * `include_profile_ids` is an OR against the rest of the filters, so an admin
 * can add a handful of people to a segment without widening it. Exclusions are
 * applied after, and win.
 *
 * Written to be reusable: `ad-targeting.service.ts` selects its audience with
 * `ORDER BY RANDOM()` and ignores the filters it was given, and this is the
 * function that fixes it.
 */
export function buildAudienceWhere(
  filters: AudienceFilters,
  opts: { respectOptOut?: boolean } = {},
): Prisma.ProfileWhereInput {
  const respectOptOut = opts.respectOptOut ?? true;

  const criteria: Prisma.ProfileWhereInput = {};

  if (filters.profile_types?.length) {
    criteria.profile_type = { in: filters.profile_types };
  }

  // ACTIVE unless the admin says otherwise: a PENDING_ACTIVATION profile has
  // not finished signing up, and a SUSPENDED one should not be marketed to.
  criteria.status = filters.statuses?.length
    ? { in: filters.statuses }
    : AccountStatus.ACTIVE;

  if (filters.verification_statuses?.length) {
    criteria.verification_status = { in: filters.verification_statuses };
  }
  if (filters.country_codes?.length) {
    criteria.country_code = { in: filters.country_codes };
  }
  // Each multi-value condition contributes its own OR group to this list.
  // Assigning `criteria.OR` directly, as this once did, means the last writer
  // wins: cities silently replaced trades, and a segment filtered on both
  // ignored one of them.
  const anyOf: Prisma.ProfileWhereInput[] = [];

  if (filters.cities?.length) {
    // Case-insensitive: cities are free text on the profile, so "Poto-Poto" and
    // "poto-poto" are the same neighbourhood to everyone except a SQL equality.
    anyOf.push({
      OR: filters.cities.map((city) => ({
        city: { equals: city, mode: Prisma.QueryMode.insensitive },
      })),
    });
  }
  if (filters.category_ids?.length) {
    // BOTH places a trade can live. `Profile.category_id` is the single
    // headline trade; `profile_categories` is the list someone actually picks
    // in the app, and it is where most trades are — a profile with five trades
    // and no headline one was invisible to this filter, which is precisely the
    // case that exposed it.
    anyOf.push({
      OR: [
        { category_id: { in: filters.category_ids } },
        {
          categories: {
            some: { category_id: { in: filters.category_ids } },
          },
        },
      ],
    });
  }
  if (filters.created_from || filters.created_to) {
    criteria.created_at = {
      ...(filters.created_from ? { gte: filters.created_from } : {}),
      ...(filters.created_to ? { lte: filters.created_to } : {}),
    };
  }
  if (filters.active_within_days != null) {
    criteria.last_login_at = {
      gte: new Date(
        Date.now() - filters.active_within_days * 24 * 60 * 60 * 1000,
      ),
    };
  }
  if (filters.whatsapp_connected != null) {
    criteria.whatsapp_connected = filters.whatsapp_connected;
  }
  if (filters.has_email != null) {
    criteria.email = filters.has_email ? { not: null } : null;
  }

  const narrowed: Prisma.ProfileWhereInput =
    anyOf.length > 0 ? { AND: [criteria, ...anyOf] } : criteria;

  const included = filters.include_profile_ids?.length
    ? { OR: [narrowed, { id: { in: filters.include_profile_ids } }] }
    : narrowed;

  const where: Prisma.ProfileWhereInput = {
    AND: [
      included,
      { deleted_at: null },
      ...(respectOptOut ? [{ marketing_opt_out_at: null }] : []),
      ...(filters.exclude_profile_ids?.length
        ? [{ id: { notIn: filters.exclude_profile_ids } }]
        : []),
    ],
  };

  return where;
}

/** What a profile needs to be reached on a channel, as read from the row. */
export type ReachFields = {
  email: string | null;
  whatsapp_connected: boolean;
  is_business: boolean;
};

/**
 * Who a channel can reach at all, as a `where`: an email needs an address,
 * WhatsApp a connected number and never a business account (business
 * accounts get email and in-app only). In-app reaches everyone.
 *
 * The preview counts with this and the snapshot writes rows with
 * `isReachable`, the same rule: a profile with no address gets no email row,
 * instead of a row that can only fail.
 */
export function reachableWhere(
  channel: DeliveryChannel,
): Prisma.ProfileWhereInput {
  switch (channel) {
    case DeliveryChannel.EMAIL:
      return { AND: [{ email: { not: null } }, { email: { not: '' } }] };
    case DeliveryChannel.WHATSAPP:
      return { whatsapp_connected: true, is_business: false };
    default:
      return {};
  }
}

/** `reachableWhere`, on a profile already read. */
export function isReachable(
  profile: ReachFields,
  channel: DeliveryChannel,
): boolean {
  switch (channel) {
    case DeliveryChannel.EMAIL:
      return !!profile.email?.trim();
    case DeliveryChannel.WHATSAPP:
      return profile.whatsapp_connected && !profile.is_business;
    default:
      return true;
  }
}

export type AudiencePreview = {
  total: number;
  reachable: { IN_APP: number; WHATSAPP: number; EMAIL: number };
  /** Of the WhatsApp-reachable, how many are inside the free 24h window. */
  freeWhatsapp: number;
  /** The rest — the ones a template must be paid for. */
  billableWhatsapp: number;
  sample: {
    id: string;
    firstName: string;
    lastName: string;
    city: string | null;
  }[];
};
