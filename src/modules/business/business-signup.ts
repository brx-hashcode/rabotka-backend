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
  BUSINESS_DOCUMENT_LABELS,
  BUSINESS_LEGAL_FORM_LABELS,
  legalFormFits,
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
 * - a business token must match `email`, must carry a `business`, and may not
 *   ask for a worker account.
 */
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
 * form that does not fit the category, or a required document missing, is a
 * 400 that says which.
 */
export function assertBusinessSignupComplete(business: {
  category: BusinessCategory;
  legalForm?: BusinessLegalForm;
  documents: { documentType: BusinessDocumentType }[];
}): void {
  if (
    business.legalForm &&
    !legalFormFits(business.category, business.legalForm)
  ) {
    throw new BadRequestException(
      `La forme juridique « ${BUSINESS_LEGAL_FORM_LABELS[business.legalForm]} » ne correspond pas à « ${BUSINESS_CATEGORY_LABELS[business.category]} ».`,
    );
  }
  const missing = missingRequiredDocuments(
    business.category,
    business.documents.map((d) => d.documentType),
  );
  if (missing.length > 0) {
    const names = missing
      .map((group) =>
        group.map((t) => BUSINESS_DOCUMENT_LABELS[t]).join(' ou '),
      )
      .join(', ');
    throw new BadRequestException(`Document manquant : ${names}.`);
  }
}
