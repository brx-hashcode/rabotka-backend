import {
  BusinessCategory,
  BusinessDocumentType,
  BusinessLegalForm,
} from '@prisma/client';
import {
  acceptedDocuments,
  BUSINESS_CATEGORY_LABELS,
  BUSINESS_COUNTRIES,
  BUSINESS_DOCUMENT_LABELS,
  BUSINESS_LEGAL_FORM_LABELS,
  businessCatalog,
  documentLabel,
  documentsFor,
  isBusinessCountry,
  LEGAL_FORMS_BY_CATEGORY,
  legalFormFits,
  missingRecommendedDocuments,
} from '../business-catalog';

/**
 * The fixed list must stay complete: a value added to an enum without a
 * label, legal forms or documents would show up blank in the dashboard.
 */
describe('business catalog', () => {
  it('labels every category, legal form and document type', () => {
    for (const c of Object.values(BusinessCategory)) {
      expect(BUSINESS_CATEGORY_LABELS[c]).toBeTruthy();
      expect(LEGAL_FORMS_BY_CATEGORY[c].length).toBeGreaterThan(0);
    }
    for (const f of Object.values(BusinessLegalForm)) {
      expect(BUSINESS_LEGAL_FORM_LABELS[f]).toBeTruthy();
    }
    for (const d of Object.values(BusinessDocumentType)) {
      expect(BUSINESS_DOCUMENT_LABELS[d]).toBeTruthy();
    }
  });

  it('gives every category of every country its papers, each listed once', () => {
    for (const country of BUSINESS_COUNTRIES) {
      for (const c of Object.values(BusinessCategory)) {
        const { recommended, optional } = documentsFor(country, c);
        const all = [...recommended, ...optional];
        expect(new Set(all).size).toBe(all.length);
        if (c !== 'OTHER') expect(recommended.length).toBeGreaterThan(0);
      }
    }
  });

  it('is open in the CEMAC and the RDC only', () => {
    expect(BUSINESS_COUNTRIES).toEqual([
      'CG',
      'CD',
      'CM',
      'GA',
      'TD',
      'CF',
      'GQ',
    ]);
    expect(isBusinessCountry('cd')).toBe(true);
    expect(isBusinessCountry('NG')).toBe(false);
    expect(isBusinessCountry(null)).toBe(false);
  });

  it('recommends a Congolese PME its RCCM and NIU', () => {
    expect(documentsFor('CG', 'PME').recommended).toEqual(['RCCM', 'NIU']);
    expect(missingRecommendedDocuments('CG', 'PME', ['RCCM'])).toEqual(['NIU']);
    expect(documentLabel('CG', 'NIU')).toBe('Attestation NIU');
  });

  it('names the RDC papers: NIF, Id. Nat., and the arrêté of an ASBL', () => {
    expect(documentsFor('CD', 'PME').recommended).toEqual([
      'RCCM',
      'SCIEN_SCIET',
      'NIU',
    ]);
    expect(documentLabel('CD', 'NIU')).toMatch(/NIF/);
    expect(documentLabel('CD', 'SCIEN_SCIET')).toMatch(/Id\. Nat\./);
    expect(documentsFor('CD', 'ASSOCIATION').recommended).toEqual([
      'ARRETE',
      'STATUTS',
    ]);
    expect(documentLabel('CD', 'ARRETE')).toMatch(/personnalité juridique/);
  });

  it('asks a Cameroonian NGO for its agrément, and has no SCIEN outside the Congo', () => {
    expect(documentsFor('CM', 'NGO').recommended).toContain('AGREMENT');
    expect(documentLabel('CM', 'CNSS')).toMatch(/CNPS/);
    for (const country of ['CM', 'GA', 'TD', 'CF', 'GQ']) {
      expect(acceptedDocuments(country, 'PME')).not.toContain('SCIEN_SCIET');
    }
  });

  it('reads an organisation from before the list as Congolese', () => {
    expect(documentsFor(null, 'PME')).toEqual(documentsFor('CG', 'PME'));
    expect(documentLabel('FR', 'NIU')).toBe('Attestation NIU');
  });

  it('matches legal forms to categories', () => {
    expect(legalFormFits('PME', 'SARL')).toBe(true);
    expect(legalFormFits('ASSOCIATION', 'SARL')).toBe(false);
    expect(legalFormFits('GIE', 'GIE')).toBe(true);
  });
});

describe('businessCatalog', () => {
  it('lists every category with its forms and its papers, none required', () => {
    const catalog = businessCatalog();
    expect(catalog.country).toBe('CG');
    expect(catalog.categories.map((c) => c.value)).toEqual(
      Object.values(BusinessCategory),
    );
    const school = catalog.categories.find((c) => c.value === 'SCHOOL')!;
    expect(school.documents.required).toEqual([]);
    expect(school.documents.recommended).toEqual([
      'AUTORISATION_OUVERTURE',
      'AGREMENT',
    ]);
    expect(school.legalForms).toContain('ASSOCIATION');
  });

  it('speaks the country: its papers, its identifiers, the seven countries', () => {
    const gabon = businessCatalog('GA');
    expect(gabon.identifiers.taxId?.label).toBe('NIF');
    expect(gabon.identifiers.statisticalId).toBeNull();
    expect(gabon.documentTypes.find((d) => d.value === 'NIU')?.label).toBe(
      'Attestation NIF',
    );
    expect(gabon.countries.map((c) => c.code)).toEqual([...BUSINESS_COUNTRIES]);
    expect(businessCatalog('CG').identifiers.statisticalId?.label).toBe(
      'SCIEN / SCIET',
    );
  });

  it('labels every legal form and document type', () => {
    const catalog = businessCatalog('TD');
    expect(catalog.legalForms).toHaveLength(
      Object.values(BusinessLegalForm).length,
    );
    expect(catalog.documentTypes.every((d) => d.label.length > 0)).toBe(true);
    expect(catalog.sizes).toEqual(['1-5', '6-20', '21-100', '100+']);
  });
});
