import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  BusinessCategory,
  BusinessDocumentType,
  BusinessLegalForm,
  ProfileType,
} from '@prisma/client';
import type { SignupIdentity } from '../auth/signup-token';
import {
  BUSINESS_CATEGORY_LABELS,
  BUSINESS_COUNTRIES_SENTENCE,
  documentLabel,
  isBusinessCountry,
  legalFormFits,
  legalFormLabel,
  identifiersFor,
  missingRequiredDocuments,
} from './business-catalog';
import { assertBusinessIsEmployer } from './business-rules';

/**
 * The one place a sign-up becomes a business — or not. The answer comes from
 * the signup token, i.e. from what the code proved (an email: a business; a
 * phone: everyone else), never from a field of the request body. The body only
 * has to agree with it:
 *
 * - a WhatsApp token must match `phone`, and may not carry a `business`;
 * - a business token must match `email` and the `phone` its WhatsApp code
 *   proved, must carry a `business`, and may not ask for a worker account.
 */
/** Told apart by the business app, which then asks for the WhatsApp code. */
export const BUSINESS_PHONE_UNPROVEN =
  'Confirmez le numéro de votre organisation avec le code reçu sur WhatsApp.';

export function signupEntryFor(
  identity: SignupIdentity | null,
  body: {
    phone: string;
    email?: string | null;
    profileType: ProfileType;
    business?: unknown;
  },
): SignupIdentity['entry'] {
  if (identity?.entry === 'business') {
    if (!body.email || body.email !== identity.email) {
      throw new ForbiddenException(
        'Vérifiez votre adresse e-mail avant de créer votre compte.',
      );
    }
    if (!body.business) {
      throw new BadRequestException(
        'Renseignez les informations de votre entreprise.',
      );
    }
    // The number becomes the account's phone, which is also a WhatsApp
    // sign-in: only the one whose code was entered.
    if (!identity.phone || identity.phone !== body.phone) {
      throw new ForbiddenException(BUSINESS_PHONE_UNPROVEN);
    }
    assertBusinessIsEmployer(body.profileType, true);
    return 'business';
  }

  if (!identity || identity.phone !== body.phone) {
    throw new ForbiddenException(
      'Vérifiez votre numéro de téléphone avant de créer votre compte.',
    );
  }
  if (body.business !== undefined) {
    throw new BadRequestException(
      'Un compte entreprise s’inscrit avec son adresse e-mail.',
    );
  }
  return 'whatsapp';
}

/**
 * Checks a business against the catalog before anything is written: a legal
 * form that does not fit the category is a 400 that says which; the country
 * is required (an organisation that works only online still has one) and must
 * be one Rabotka Business is open in; and the papers that prove the
 * organisation exists there — its registration, declaration, licence or
 * mandate, by category, country and legal form — must all be sent, with the
 * numbers of those that carry one (N° RCCM, NIU…). A 400 names the ones still
 * missing, in the country's words.
 */
export function assertBusinessSignupComplete(
  business: {
    category: BusinessCategory;
    legalForm?: BusinessLegalForm;
    registrationNumber?: string | null;
    taxId?: string | null;
    statisticalId?: string | null;
    documents: readonly { documentType: BusinessDocumentType }[];
  },
  countryCode: string | null | undefined,
): void {
  if (
    business.legalForm &&
    !legalFormFits(business.category, business.legalForm, countryCode ?? null)
  ) {
    throw new BadRequestException(
      `La forme juridique « ${legalFormLabel(countryCode, business.legalForm)} » ne correspond pas à « ${BUSINESS_CATEGORY_LABELS[business.category]} ».`,
    );
  }
  assertBusinessCountry(countryCode);

  const fields = identifiersFor(
    countryCode,
    business.category,
    business.legalForm,
  );
  const unfilled = (['registrationNumber', 'taxId', 'statisticalId'] as const)
    .map((key) => ({ key, field: fields[key] }))
    .filter(({ key, field }) => field?.required && !business[key]?.trim());
  if (unfilled.length > 0) {
    throw new BadRequestException(
      `Indiquez ${unfilled.map(({ field }) => `le ${field!.label}`).join(' et ')} de votre organisation.`,
    );
  }

  const missing = missingRequiredDocuments(
    countryCode,
    business.category,
    business.legalForm,
    business.documents.map((d) => d.documentType),
  );
  if (missing.length > 0) {
    throw new BadRequestException(
      `Ajoutez ${missing
        .map((group) =>
          group.map((t) => `« ${documentLabel(countryCode, t)} »`).join(' ou '),
        )
        .join(' et ')} pour créer le compte de votre organisation.`,
    );
  }
}

/** The organisation's country: given, and one Rabotka Business is open in. */
export function assertBusinessCountry(
  countryCode: string | null | undefined,
): void {
  if (!countryCode?.trim()) {
    throw new BadRequestException('Choisissez le pays de votre organisation.');
  }
  if (!isBusinessCountry(countryCode.trim())) {
    throw new BadRequestException(BUSINESS_COUNTRIES_SENTENCE);
  }
}
