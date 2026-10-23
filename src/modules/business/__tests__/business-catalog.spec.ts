import {
  BusinessCategory,
  BusinessDocumentType,
  BusinessLegalForm,
} from '@prisma/client';
import {
  BUSINESS_CATEGORY_LABELS,
  BUSINESS_DOCUMENT_LABELS,
  BUSINESS_LEGAL_FORM_LABELS,
  businessCatalog,
  DOCUMENTS_BY_CATEGORY,
  LEGAL_FORMS_BY_CATEGORY,
  legalFormFits,
  missingRequiredDocuments,
} from '../business-catalog';

/**
 * The fixed list must stay complete: a value added to an enum without a
 * label, legal forms or documents would show up blank in the dashboard.
 */
describe('business catalog (Congo-Brazzaville)', () => {
  it('labels every category, legal form and document type', () => {
    for (const c of Object.values(BusinessCategory)) {
      expect(BUSINESS_CATEGORY_LABELS[c]).toBeTruthy();
      expect(LEGAL_FORMS_BY_CATEGORY[c].length).toBeGreaterThan(0);
      expect(DOCUMENTS_BY_CATEGORY[c]).toBeDefined();
    }
    for (const f of Object.values(BusinessLegalForm)) {
      expect(BUSINESS_LEGAL_FORM_LABELS[f]).toBeTruthy();
    }
    for (const d of Object.values(BusinessDocumentType)) {
      expect(BUSINESS_DOCUMENT_LABELS[d]).toBeTruthy();
    }
  });

  it('asks a PME for its RCCM and NIU', () => {
    expect(missingRequiredDocuments('PME', ['RCCM'])).toEqual([['NIU']]);
    expect(missingRequiredDocuments('PME', ['RCCM', 'NIU'])).toEqual([]);
  });

  it('accepts either an autorisation d’ouverture or an agrément for a school', () => {
    expect(missingRequiredDocuments('SCHOOL', ['AGREMENT'])).toEqual([]);
    expect(missingRequiredDocuments('SCHOOL', ['AUTORISATION_OUVERTURE'])).toEqual(
      [],
    );
    expect(missingRequiredDocuments('SCHOOL', [])).toHaveLength(1);
  });

  it('asks an association for its récépissé and statuts', () => {
    expect(missingRequiredDocuments('ASSOCIATION', ['STATUTS'])).toEqual([
      ['RECEPISSE'],
    ]);
  });

  it('matches legal forms to categories', () => {
    expect(legalFormFits('PME', 'SARL')).toBe(true);
    expect(legalFormFits('ASSOCIATION', 'SARL')).toBe(false);
    expect(legalFormFits('GIE', 'GIE')).toBe(true);
  });
});

describe('businessCatalog', () => {
  const catalog = businessCatalog();

  it('lists every category with its forms and documents, as the server checks them', () => {
    expect(catalog.categories.map((c) => c.value)).toEqual(
      Object.values(BusinessCategory),
    );
    const school = catalog.categories.find((c) => c.value === 'SCHOOL')!;
    expect(school.documents.required).toEqual([
      ['AUTORISATION_OUVERTURE', 'AGREMENT'],
    ]);
    expect(school.legalForms).toContain('ASSOCIATION');
  });

  it('labels every legal form and document type', () => {
    expect(catalog.legalForms).toHaveLength(
      Object.values(BusinessLegalForm).length,
    );
    expect(catalog.documentTypes.every((d) => d.label.length > 0)).toBe(true);
    expect(catalog.sizes).toEqual(['1-5', '6-20', '21-100', '100+']);
  });
});
