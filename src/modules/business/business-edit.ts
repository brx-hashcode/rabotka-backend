import { BadRequestException } from '@nestjs/common';
import { BusinessCategory, BusinessLegalForm } from '@prisma/client';
import { legalFormFits } from './business-catalog';

/**
 * The fields the review is about: the organisation's identity, checked
 * against its papers. Changing one of them on a verified business sends it
 * back to review; contact details (email, phone, website, address…) do not.
 */
export const REVIEWED_BUSINESS_FIELDS = [
  'name',
  'category',
  'legalForm',
  'registrationNumber',
  'taxId',
  'statisticalId',
] as const;

type ReviewedField = (typeof REVIEWED_BUSINESS_FIELDS)[number];

/** Which reviewed fields an edit actually changes (a same value is no change). */
export function changedReviewedFields(
  current: Record<ReviewedField, string | null>,
  edit: Partial<Record<ReviewedField, string | null>>,
): ReviewedField[] {
  return REVIEWED_BUSINESS_FIELDS.filter(
    (field) => edit[field] !== undefined && edit[field] !== current[field],
  );
}

/**
 * The legal form after an edit must still fit the category after it. A
 * category change that leaves an unfitting form clears the form rather than
 * failing: the business picks the type first, the form second.
 */
export function legalFormAfterEdit(
  category: BusinessCategory,
  current: BusinessLegalForm | null,
  edit: { category?: BusinessCategory; legalForm?: BusinessLegalForm | null },
): BusinessLegalForm | null {
  if (edit.legalForm !== undefined && edit.legalForm !== null) {
    if (!legalFormFits(category, edit.legalForm)) {
      throw new BadRequestException(
        'Cette forme juridique ne correspond pas à ce type d’organisation.',
      );
    }
    return edit.legalForm;
  }
  if (edit.legalForm === null) return null;
  if (current && edit.category && !legalFormFits(category, current)) {
    return null;
  }
  return current;
}
