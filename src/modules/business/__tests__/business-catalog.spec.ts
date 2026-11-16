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
  isKnownBusinessCountry,
  LEGAL_FORMS_BY_CATEGORY,
  legalFormFits,
  identifiersFor,
  legalFormsFor,
  missingRecommendedDocuments,
  missingRequiredDocuments,
  requiredDocumentsFor,
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

  it('is open where pawaPay collects mobile money', () => {
    expect([...BUSINESS_COUNTRIES].sort()).toEqual(
      [
        'BJ',
        'CD',
        'CG',
        'CI',
        'CM',
        'GA',
        'KE',
        'MZ',
        'RW',
        'SL',
        'SN',
        'UG',
        'ZM',
      ].sort(),
    );
    expect(isBusinessCountry('cd')).toBe(true);
    expect(isBusinessCountry('ke')).toBe(true);
    expect(isBusinessCountry('NG')).toBe(false);
    expect(isBusinessCountry(null)).toBe(false);
  });

  it('closes Chad, CAR and Equatorial Guinea to sign-up, keeping their rules', () => {
    for (const code of ['TD', 'CF', 'GQ']) {
      expect(isBusinessCountry(code)).toBe(false);
      expect(isKnownBusinessCountry(code)).toBe(true);
    }
    expect(businessCatalog('TD').countries.map((c) => c.code)).not.toContain(
      'TD',
    );
    expect(documentLabel('GQ', 'CNSS')).toBe(
      "Attestation d'immatriculation INSESO",
    );
  });

  it('names the papers, numbers and forms of a country outside OHADA', () => {
    const kenya = businessCatalog('KE');
    expect(kenya.identifiers.taxId?.label).toBe('KRA PIN');
    expect(documentLabel('KE', 'RCCM')).toBe(
      "Certificat d'immatriculation (BRS)",
    );
    expect(
      kenya.categories.find((c) => c.value === 'STARTUP')?.legalForms,
    ).toEqual(['SARL', 'OTHER']);
    expect(kenya.legalForms.find((f) => f.value === 'SARL')?.label).toBe(
      'Société privée à responsabilité limitée (Ltd)',
    );
    // A GIE has no form of its own there: « Autre ».
    expect(kenya.categories.find((c) => c.value === 'GIE')?.legalForms).toEqual(
      ['OTHER'],
    );
    expect(legalFormFits('STARTUP', 'SAS', 'KE')).toBe(false);
    expect(legalFormFits('STARTUP', 'SAS')).toBe(true);
  });

  it('keeps the OHADA forms in West Africa, with the local tax number', () => {
    expect(businessCatalog('SN').identifiers.taxId?.label).toBe('NINEA');
    expect(
      businessCatalog('CI').categories.find((c) => c.value === 'STARTUP')
        ?.legalForms,
    ).toContain('SAS');
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
  it('lists every category with its forms, its papers and those it must send', () => {
    const catalog = businessCatalog();
    expect(catalog.country).toBe('CG');
    expect(catalog.categories.map((c) => c.value)).toEqual(
      Object.values(BusinessCategory),
    );
    const school = catalog.categories.find((c) => c.value === 'SCHOOL')!;
    expect(school.documents.required).toEqual([
      ['AUTORISATION_OUVERTURE', 'AGREMENT'],
      ['RCCM', 'RECEPISSE', 'ARRETE'],
    ]);
    expect(school.documents.requiredByLegalForm?.ASSOCIATION).toEqual([
      ['AUTORISATION_OUVERTURE', 'AGREMENT'],
      ['RECEPISSE', 'ARRETE'],
    ]);
    expect(school.documents.recommended).toEqual([
      'AUTORISATION_OUVERTURE',
      'AGREMENT',
    ]);
    expect(school.legalForms).toContain('ASSOCIATION');
    const pme = catalog.categories.find((c) => c.value === 'PME')!;
    expect(pme.documents.required).toEqual([['RCCM'], ['NIU']]);
    expect(pme.documents.requiredByLegalForm).toBeUndefined();
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

/**
 * What each open country asks, the sources in
 * hashcode/docs/rabotka-backend/business-documents.md.
 */
describe('required documents', () => {
  const OPEN = [...BUSINESS_COUNTRIES];

  it('covers all 13 open countries', () => {
    expect(OPEN).toHaveLength(13);
  });

  it('asks every category in every country for something it can send', () => {
    for (const country of OPEN) {
      for (const category of Object.values(BusinessCategory)) {
        const accepted = new Set(acceptedDocuments(country, category));
        for (const form of [undefined, ...legalFormsFor(country, category)]) {
          const required = requiredDocumentsFor(country, category, form);
          expect(required.length).toBeGreaterThan(0);
          for (const group of required) {
            expect(group.length).toBeGreaterThan(0);
            for (const t of group) {
              // Sendable at sign-up and from the dashboard, and exists there.
              expect([country, category, form, t, accepted.has(t)]).toEqual([
                country,
                category,
                form,
                t,
                true,
              ]);
            }
          }
          // Sending one paper of each group is enough.
          expect(
            missingRequiredDocuments(
              country,
              category,
              form,
              required.map((g) => g[0]),
            ),
          ).toEqual([]);
        }
      }
    }
  });

  it('asks a company for its registration and its tax number', () => {
    for (const country of OPEN.filter((c) => c !== 'RW')) {
      expect(requiredDocumentsFor(country, 'PME')).toEqual([['RCCM'], ['NIU']]);
    }
    // The RDB certificate carries the company code, which is the TIN.
    expect(requiredDocumentsFor('RW', 'PME')).toEqual([['RCCM']]);
    expect(documentsFor('RW', 'PME').optional).toContain('NIU');
  });

  it('asks an association for its declaration and its statuts', () => {
    for (const country of OPEN.filter((c) => c !== 'CD')) {
      expect(requiredDocumentsFor(country, 'ASSOCIATION')).toEqual([
        ['RECEPISSE'],
        ['STATUTS'],
      ]);
    }
    expect(requiredDocumentsFor('CD', 'ASSOCIATION')).toEqual([
      ['ARRETE', 'RECEPISSE'],
      ['STATUTS'],
    ]);
  });

  it('asks an NGO for its agrément or permit where the law does', () => {
    for (const country of ['CM', 'SN', 'UG'] as const) {
      expect(requiredDocumentsFor(country, 'NGO')).toEqual([
        ['RECEPISSE'],
        ['AGREMENT'],
        ['STATUTS'],
      ]);
      expect(documentsFor(country, 'NGO').recommended).toContain('AGREMENT');
    }
    expect(requiredDocumentsFor('CG', 'NGO')).toEqual([
      ['RECEPISSE'],
      ['STATUTS'],
    ]);
  });

  it('asks public bodies and embassies for a mandate', () => {
    for (const country of OPEN) {
      expect(requiredDocumentsFor(country, 'INTERNATIONAL_ORG')).toEqual([
        ['MANDATE'],
      ]);
      expect(requiredDocumentsFor(country, 'PUBLIC_ADMINISTRATION')).toEqual([
        ['MANDATE'],
      ]);
      expect(requiredDocumentsFor(country, 'PUBLIC_ENTERPRISE')).toEqual([
        ['ARRETE', 'RCCM'],
        ['MANDATE'],
      ]);
      expect(requiredDocumentsFor(country, 'INTERNATIONAL_NGO')).toEqual([
        ['AGREMENT', 'RECEPISSE'],
        ['MANDATE'],
      ]);
    }
  });

  it('asks a school or a clinic for its licence and its legal paper', () => {
    expect(requiredDocumentsFor('KE', 'HEALTH', 'SARL')).toEqual([
      ['AUTORISATION_OUVERTURE', 'AGREMENT'],
      ['RCCM'],
    ]);
    expect(requiredDocumentsFor('SN', 'SCHOOL', 'PUBLIC_ENTITY')).toEqual([
      ['AUTORISATION_OUVERTURE', 'AGREMENT'],
      ['ARRETE'],
    ]);
  });

  it('accepts any paper from « Autre organisation »', () => {
    expect(missingRequiredDocuments('ZM', 'OTHER', null, ['OTHER'])).toEqual(
      [],
    );
    expect(missingRequiredDocuments('ZM', 'OTHER', null, [])).toHaveLength(1);
  });

  it("names each paper in the country's words", () => {
    expect(documentLabel('CI', 'NIU')).toMatch(/DFE/);
    expect(documentLabel('GA', 'RECEPISSE')).toMatch(/définitif/);
    expect(documentLabel('UG', 'AGREMENT')).toMatch(/NGO permit/);
    expect(documentLabel('RW', 'RCCM')).toMatch(/RDB, avec le TIN/);
    expect(documentLabel('MZ', 'RECEPISSE')).toMatch(/Boletim da República/);
    expect(documentLabel('KE', 'RECEPISSE')).toMatch(/PBO Authority/);
    expect(documentLabel('SL', 'RECEPISSE')).toMatch(/MoPED/);
  });

  it("keeps the closed countries' rules for those registered there", () => {
    expect(requiredDocumentsFor('TD', 'ASSOCIATION')).toEqual([
      ['RECEPISSE'],
      ['AGREMENT'],
      ['STATUTS'],
    ]);
  });
});

describe('identifiersFor', () => {
  it("requires a company's numbers where its papers are required", () => {
    const cg = identifiersFor('CG', 'PME', 'SARL');
    expect(cg.registrationNumber).toMatchObject({
      label: 'N° RCCM',
      required: true,
    });
    expect(cg.taxId).toMatchObject({ label: 'NIU', required: true });
    expect(cg.statisticalId).toMatchObject({ required: false });
    // Rwanda: the TIN is the company code, on the RDB certificate.
    expect(identifiersFor('RW', 'PME').taxId).toMatchObject({
      required: false,
    });
    expect(identifiersFor('RW', 'PME').registrationNumber?.required).toBe(true);
  });

  it('asks no N° RCCM of an association or an embassy', () => {
    expect(identifiersFor('CG', 'ASSOCIATION').registrationNumber).toBeNull();
    expect(identifiersFor('CG', 'ASSOCIATION').taxId?.required).toBe(false);
    expect(identifiersFor('SN', 'INTERNATIONAL_ORG')).toEqual({
      registrationNumber: null,
      taxId: null,
      statisticalId: null,
    });
  });

  it("follows a school's legal form", () => {
    expect(
      identifiersFor('CM', 'SCHOOL', 'SARL').registrationNumber?.required,
    ).toBe(true);
    expect(
      identifiersFor('CM', 'SCHOOL', 'ASSOCIATION').registrationNumber
        ?.required,
    ).toBe(false);
  });
});
