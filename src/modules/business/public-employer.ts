/**
 * How an employer shows to a worker. A business account is its owner's
 * profile underneath — but to the people it hires it is the organisation:
 * its name (the profile picture is already its logo), never the person who
 * opened the account.
 *
 * Applied where a worker reads an employer: an offer, the job feed, their
 * missions, a conversation, what reaches them when a contact is exchanged.
 * Not in the business's own session, nor in admin, where the person matters.
 */

/** Add to an employer `select` so the helpers below can tell. */
export const BUSINESS_IDENTITY_SELECT = {
  is_business: true,
  business: {
    select: { name: true, phone: true, email: true, deleted_at: true },
  },
} as const;

type Identity = {
  first_name: string;
  last_name: string;
  is_business?: boolean | null;
  business?: {
    name: string;
    phone?: string | null;
    email?: string | null;
    deleted_at?: Date | null;
  } | null;
};

function liveBusiness(e: Identity) {
  return e.is_business && e.business && !e.business.deleted_at
    ? e.business
    : null;
}

/** The name a worker reads: the organisation's, or the person's. */
export function publicEmployerName(e: Identity): {
  first_name: string;
  last_name: string;
} {
  const business = liveBusiness(e);
  return business
    ? { first_name: business.name, last_name: '' }
    : { first_name: e.first_name, last_name: e.last_name };
}

/** One line: « LOVE LIFE WITH US », or « Jean Luc ». */
export function publicEmployerFullName(e: Identity): string {
  const { first_name, last_name } = publicEmployerName(e);
  return `${first_name} ${last_name}`.trim();
}

/**
 * The phone and e-mail a worker gets once a contact is exchanged: the
 * organisation's own when it gave them, else the account's.
 */
export function publicEmployerContact(
  e: Identity & { phone: string; email: string | null },
): { phone: string; email: string | null } {
  const business = liveBusiness(e);
  return {
    phone: business?.phone?.trim() || e.phone,
    email: business?.email?.trim() || e.email,
  };
}
