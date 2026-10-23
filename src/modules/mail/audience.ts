import { ProfileType } from '@prisma/client';

/**
 * Who an email is for. Workers and employers use the client app (and
 * WhatsApp); a business uses its own dashboard, by email only — so the copy,
 * the links and the sign-off differ, and nothing sent to a business may point
 * to WhatsApp or to the client app.
 */
export type EmailAudience = 'worker' | 'employer' | 'business';

export function audienceOf(profile: {
  profile_type: ProfileType | string;
  is_business?: boolean | null;
}): EmailAudience {
  if (profile.is_business) return 'business';
  return profile.profile_type === ProfileType.EMPLOYER ? 'employer' : 'worker';
}

/** The business dashboard's space (BUSINESS_DASHBOARD_URL, else production's). */
export function businessDashboardUrl(): string {
  return `${(process.env.BUSINESS_DASHBOARD_URL ?? 'https://business.rabotka.work').replace(/\/+$/, '')}/espace`;
}

/** Where a business fixes its details and papers. */
export function businessOrganisationUrl(): string {
  return `${businessDashboardUrl()}/organisation`;
}

/** The client app (FRONTEND_URL, else production's). */
export function clientAppUrl(): string {
  return (process.env.FRONTEND_URL ?? 'https://www.rabotka.work').replace(
    /\/+$/,
    '',
  );
}

/** Where a link in an email for this audience lands. */
export function appUrlFor(audience: EmailAudience): string {
  return audience === 'business' ? businessDashboardUrl() : clientAppUrl();
}

/** The closing line's team name. */
export function signOff(audience: EmailAudience): string {
  return audience === 'business'
    ? "L'équipe Rabotka Business"
    : "L'équipe Rabotka";
}

/** The layout's product label: « Business » next to the logo, or none. */
export function productOf(audience: EmailAudience): 'business' | undefined {
  return audience === 'business' ? 'business' : undefined;
}
