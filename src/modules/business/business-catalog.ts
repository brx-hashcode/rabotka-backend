import {
  BusinessCategory,
  BusinessDocumentType,
  BusinessLegalForm,
} from '@prisma/client';

/**
 * Business categories, legal forms and documents, with their French labels and
 * which papers each category is recommended to send, per country. A fixed list
 * (product decision): adding a value is a migration plus an entry here.
 *
 * Rabotka Business is open in the CEMAC and the RDC only: seven OHADA
 * countries, so the legal forms (OHADA uniform act) are the same everywhere;
 * the papers' names and a few of the papers differ. No paper is required: an
 * organisation sends what it has, the review asks for the rest.
 */

/** Headcount brackets offered at sign-up. */
export const BUSINESS_SIZES = ['1-5', '6-20', '21-100', '100+'] as const;

export const BUSINESS_CATEGORY_LABELS: Record<BusinessCategory, string> = {
  INDIVIDUAL_BUSINESS: 'Entreprise individuelle / établissement',
  TPE: 'Très petite entreprise (TPE)',
  PME: 'Petite et moyenne entreprise (PME)',
  LARGE_COMPANY: 'Grande entreprise',
  STARTUP: 'Startup',
  COOPERATIVE: 'Coopérative',
  GIE: "Groupement d'intérêt économique (GIE)",
  ASSOCIATION: 'Association',
  NGO: 'ONG nationale',
  INTERNATIONAL_NGO: 'ONG internationale',
  FOUNDATION: 'Fondation',
  RELIGIOUS: 'Confession religieuse (église, paroisse, mosquée…)',
  SCHOOL: 'École privée (maternelle, primaire, collège, lycée)',
  HIGHER_EDUCATION: 'Enseignement supérieur (université, institut)',
  TRAINING_CENTER: 'Centre de formation professionnelle',
  HEALTH: 'Santé (clinique, cabinet, pharmacie, laboratoire)',
  PUBLIC_ADMINISTRATION: 'Administration publique / collectivité locale',
  PUBLIC_ENTERPRISE: 'Établissement ou entreprise publique',
  INTERNATIONAL_ORG: 'Organisation internationale / ambassade',
  OTHER: 'Autre organisation',
};

export const BUSINESS_LEGAL_FORM_LABELS: Record<BusinessLegalForm, string> = {
  EI: 'Entreprise individuelle (EI)',
  SARL: 'SARL',
  SARLU: 'SARL unipersonnelle (SARLU)',
  SA: 'Société anonyme (SA)',
  SAS: 'Société par actions simplifiée (SAS)',
  SASU: 'SAS unipersonnelle (SASU)',
  SNC: 'Société en nom collectif (SNC)',
  SCS: 'Société en commandite simple (SCS)',
  GIE: "Groupement d'intérêt économique (GIE)",
  SCOOPS: 'Société coopérative simplifiée (SCOOPS)',
  COOP_CA: "Coopérative avec conseil d'administration",
  BRANCH: "Succursale d'une société étrangère",
  ASSOCIATION: 'Association déclarée',
  FOUNDATION: 'Fondation',
  PUBLIC_ENTITY: 'Établissement public / administration',
  OTHER: 'Autre',
};

export const BUSINESS_DOCUMENT_LABELS: Record<BusinessDocumentType, string> = {
  RCCM: 'Extrait du RCCM',
  NIU: 'Attestation NIU',
  STATUTS: 'Statuts',
  PATENTE: "Patente / licence d'exploitation",
  CNSS: "Attestation d'immatriculation CNSS",
  SCIEN_SCIET: 'Certificat SCIEN / SCIET (CNSEE)',
  RECEPISSE: 'Récépissé de déclaration',
  AGREMENT: 'Agrément',
  AUTORISATION_OUVERTURE: "Autorisation d'ouverture",
  ARRETE: 'Arrêté / acte de création',
  MANDATE: 'Mandat ou procuration du représentant',
  OTHER: 'Autre document',
};

const COMPANY_FORMS: BusinessLegalForm[] = [
  'EI',
  'SARL',
  'SARLU',
  'SA',
  'SAS',
  'SASU',
  'SNC',
  'SCS',
  'BRANCH',
  'OTHER',
];

/** The legal forms worth offering for a category; the first is the usual one. */
export const LEGAL_FORMS_BY_CATEGORY: Record<
  BusinessCategory,
  BusinessLegalForm[]
> = {
  INDIVIDUAL_BUSINESS: ['EI', 'OTHER'],
  TPE: COMPANY_FORMS,
  PME: COMPANY_FORMS,
  LARGE_COMPANY: ['SA', 'SAS', 'SARL', 'BRANCH', 'OTHER'],
  STARTUP: ['SAS', 'SASU', 'SARL', 'SARLU', 'OTHER'],
  COOPERATIVE: ['SCOOPS', 'COOP_CA', 'OTHER'],
  GIE: ['GIE'],
  ASSOCIATION: ['ASSOCIATION'],
  NGO: ['ASSOCIATION', 'FOUNDATION', 'OTHER'],
  INTERNATIONAL_NGO: ['ASSOCIATION', 'FOUNDATION', 'BRANCH', 'OTHER'],
  FOUNDATION: ['FOUNDATION'],
  RELIGIOUS: ['ASSOCIATION', 'OTHER'],
  SCHOOL: ['ASSOCIATION', ...COMPANY_FORMS],
  HIGHER_EDUCATION: ['ASSOCIATION', 'PUBLIC_ENTITY', ...COMPANY_FORMS],
  TRAINING_CENTER: ['ASSOCIATION', ...COMPANY_FORMS],
  HEALTH: ['ASSOCIATION', 'PUBLIC_ENTITY', ...COMPANY_FORMS],
  PUBLIC_ADMINISTRATION: ['PUBLIC_ENTITY'],
  PUBLIC_ENTERPRISE: ['PUBLIC_ENTITY', 'SA', 'OTHER'],
  INTERNATIONAL_ORG: ['OTHER'],
  OTHER: Object.values(BusinessLegalForm),
};

/** The countries an organisation can sign up in: the CEMAC and the RDC. */
export const BUSINESS_COUNTRIES = [
  'CG',
  'CD',
  'CM',
  'GA',
  'TD',
  'CF',
  'GQ',
] as const;
export type BusinessCountry = (typeof BUSINESS_COUNTRIES)[number];

/** Where an organisation with no (or an older, other) country is read from. */
export const DEFAULT_BUSINESS_COUNTRY: BusinessCountry = 'CG';

export const BUSINESS_COUNTRY_NAMES: Record<BusinessCountry, string> = {
  CG: 'Congo-Brazzaville',
  CD: 'Congo-Kinshasa (RDC)',
  CM: 'Cameroun',
  GA: 'Gabon',
  TD: 'Tchad',
  CF: 'République centrafricaine',
  GQ: 'Guinée équatoriale',
};

export const BUSINESS_COUNTRIES_SENTENCE =
  'Rabotka Business est disponible au Congo-Brazzaville, en RDC, au Cameroun, au Gabon, au Tchad, en Centrafrique et en Guinée équatoriale.';

export function isBusinessCountry(
  code: string | null | undefined,
): code is BusinessCountry {
  return (
    !!code &&
    (BUSINESS_COUNTRIES as readonly string[]).includes(code.toUpperCase())
  );
}

/** The papers shown for a category: the usual ones first, then the others. */
export type DocumentList = {
  recommended: BusinessDocumentType[];
  optional: BusinessDocumentType[];
};

/** One official identifier field of the form; null: the country has none. */
export type IdentifierField = { label: string; placeholder?: string } | null;

export type BusinessIdentifiers = {
  registrationNumber: IdentifierField;
  taxId: IdentifierField;
  statisticalId: IdentifierField;
};

type CountryRules = {
  /** Each paper's local name, over the Congo-Brazzaville one. */
  documentLabels: Partial<Record<BusinessDocumentType, string>>;
  identifiers: BusinessIdentifiers;
  /** Categories whose papers differ from the OHADA base. */
  documents: Partial<Record<BusinessCategory, DocumentList>>;
  /** Papers that do not exist there (no SCIEN / SCIET outside the Congo). */
  without: BusinessDocumentType[];
};

const COMPANY_DOCS: DocumentList = {
  recommended: ['RCCM', 'NIU'],
  optional: ['STATUTS', 'PATENTE', 'SCIEN_SCIET', 'CNSS', 'MANDATE'],
};
const REGISTERED_GROUP_DOCS: DocumentList = {
  recommended: ['RCCM', 'NIU'],
  optional: ['STATUTS', 'MANDATE'],
};
const DECLARED_DOCS: DocumentList = {
  recommended: ['RECEPISSE', 'STATUTS'],
  optional: ['AGREMENT', 'NIU', 'MANDATE'],
};
const AUTHORISED_DOCS: DocumentList = {
  recommended: ['AUTORISATION_OUVERTURE', 'AGREMENT'],
  optional: ['RCCM', 'NIU', 'MANDATE'],
};

/**
 * The OHADA base: companies and GIE at the RCCM with a tax number,
 * associations declared (récépissé) with their statuts, schools and health
 * authorised by their ministry, public bodies created by an act.
 */
const BASE_DOCUMENTS: Record<BusinessCategory, DocumentList> = {
  INDIVIDUAL_BUSINESS: COMPANY_DOCS,
  TPE: COMPANY_DOCS,
  PME: COMPANY_DOCS,
  LARGE_COMPANY: COMPANY_DOCS,
  STARTUP: COMPANY_DOCS,
  COOPERATIVE: REGISTERED_GROUP_DOCS,
  GIE: REGISTERED_GROUP_DOCS,
  ASSOCIATION: DECLARED_DOCS,
  NGO: DECLARED_DOCS,
  FOUNDATION: DECLARED_DOCS,
  RELIGIOUS: { recommended: ['RECEPISSE', 'STATUTS'], optional: ['MANDATE'] },
  INTERNATIONAL_NGO: {
    recommended: ['AGREMENT'],
    optional: ['NIU', 'MANDATE'],
  },
  INTERNATIONAL_ORG: { recommended: ['AGREMENT'], optional: ['MANDATE'] },
  SCHOOL: AUTHORISED_DOCS,
  HIGHER_EDUCATION: AUTHORISED_DOCS,
  TRAINING_CENTER: AUTHORISED_DOCS,
  HEALTH: AUTHORISED_DOCS,
  PUBLIC_ADMINISTRATION: {
    recommended: ['ARRETE'],
    optional: ['NIU', 'MANDATE'],
  },
  PUBLIC_ENTERPRISE: {
    recommended: ['ARRETE'],
    optional: ['NIU', 'RCCM', 'MANDATE'],
  },
  OTHER: { recommended: [], optional: Object.values(BusinessDocumentType) },
};

const COMPANIES: BusinessCategory[] = [
  'INDIVIDUAL_BUSINESS',
  'TPE',
  'PME',
  'LARGE_COMPANY',
  'STARTUP',
];
const DECLARED: BusinessCategory[] = [
  'ASSOCIATION',
  'NGO',
  'FOUNDATION',
  'RELIGIOUS',
];

/** One list of papers for several categories. */
function sameFor(
  categories: BusinessCategory[],
  list: DocumentList,
): Partial<Record<BusinessCategory, DocumentList>> {
  return Object.fromEntries(categories.map((c) => [c, list]));
}

/** The OHADA register number, in each country's usual shape. */
const rccm = (placeholder: string): IdentifierField => ({
  label: 'N° RCCM',
  placeholder,
});
const NIF: IdentifierField = { label: 'NIF' };

/**
 * What changes from one country to the next. Sources: OHADA uniform acts
 * (RCCM everywhere); tax numbers (NIU in the Congo and Cameroon, NIF
 * elsewhere); social security (CNSS, CNPS in Cameroon and Chad, INSESO in
 * Equatorial Guinea); associations — Congo and Gabon declare under the 1901
 * model (récépissé), Cameroon at the préfecture (loi 90/053) with an agrément
 * for NGOs (loi 99/014), Chad's récépissé is followed by an authorisation to
 * operate (ordonnance 023/PR/2018), the RDC grants legal personality by
 * ministerial arrêté (loi 004/2001) and adds the identification nationale.
 */
const COUNTRY_RULES: Record<BusinessCountry, CountryRules> = {
  CG: {
    documentLabels: {},
    identifiers: {
      registrationNumber: rccm('CG-BZV-01-2024-B12-00123'),
      taxId: { label: 'NIU', placeholder: 'M2024000123456A' },
      statisticalId: { label: 'SCIEN / SCIET' },
    },
    documents: {},
    without: [],
  },
  CD: {
    documentLabels: {
      NIU: 'Attestation NIF (numéro impôt)',
      SCIEN_SCIET: 'Identification nationale (Id. Nat.)',
      CNSS: "Attestation d'affiliation CNSS",
      RECEPISSE: 'Récépissé de dépôt (demande de personnalité juridique)',
      ARRETE: 'Arrêté ministériel (personnalité juridique ou création)',
    },
    identifiers: {
      registrationNumber: rccm('CD/KNG/RCCM/24-B-01234'),
      taxId: NIF,
      statisticalId: { label: 'Id. Nat.' },
    },
    documents: {
      ...sameFor(COMPANIES, {
        recommended: ['RCCM', 'SCIEN_SCIET', 'NIU'],
        optional: ['STATUTS', 'PATENTE', 'CNSS', 'MANDATE'],
      }),
      ...sameFor(DECLARED, {
        recommended: ['ARRETE', 'STATUTS'],
        optional: ['RECEPISSE', 'AGREMENT', 'NIU', 'MANDATE'],
      }),
    },
    without: [],
  },
  CM: {
    documentLabels: {
      NIU: "Attestation d'immatriculation (NIU)",
      CNSS: "Attestation d'immatriculation CNPS",
      RECEPISSE: 'Récépissé de déclaration (préfecture)',
    },
    identifiers: {
      registrationNumber: rccm('RC/DLA/2024/B/1234'),
      taxId: { label: 'NIU', placeholder: 'M012400012345A' },
      statisticalId: null,
    },
    documents: {
      NGO: {
        recommended: ['RECEPISSE', 'AGREMENT', 'STATUTS'],
        optional: ['NIU', 'MANDATE'],
      },
    },
    without: ['SCIEN_SCIET'],
  },
  GA: {
    documentLabels: {
      NIU: 'Attestation NIF',
      CNSS: "Attestation d'immatriculation CNSS",
    },
    identifiers: {
      registrationNumber: rccm('GA-LBV-01-2024-B12-00123'),
      taxId: NIF,
      statisticalId: null,
    },
    documents: {},
    without: ['SCIEN_SCIET'],
  },
  TD: {
    documentLabels: {
      NIU: 'Attestation NIF',
      CNSS: "Attestation d'immatriculation CNPS",
      AGREMENT: 'Autorisation de fonctionner / agrément',
    },
    identifiers: {
      registrationNumber: rccm('TD-NDJ-01-2024-B12-00123'),
      taxId: NIF,
      statisticalId: null,
    },
    documents: sameFor(DECLARED, {
      recommended: ['RECEPISSE', 'AGREMENT', 'STATUTS'],
      optional: ['NIU', 'MANDATE'],
    }),
    without: ['SCIEN_SCIET'],
  },
  CF: {
    documentLabels: {
      NIU: 'Attestation NIF',
      CNSS: "Attestation d'immatriculation CNSS",
    },
    identifiers: {
      registrationNumber: rccm('CF-BGF-01-2024-B12-00123'),
      taxId: NIF,
      statisticalId: null,
    },
    documents: {},
    without: ['SCIEN_SCIET'],
  },
  GQ: {
    documentLabels: {
      RCCM: 'Extrait du RCCM (Registro Mercantil)',
      NIU: 'Attestation NIF',
      CNSS: "Attestation d'immatriculation INSESO",
      RECEPISSE: 'Inscription au registre des associations',
    },
    identifiers: {
      registrationNumber: rccm('GQ-MAL-01-2024-B12-00123'),
      taxId: NIF,
      statisticalId: null,
    },
    documents: {},
    without: ['SCIEN_SCIET'],
  },
};

/** A country's rules; an organisation from before the list reads as Congo's. */
function rulesFor(country: string | null | undefined): CountryRules {
  return COUNTRY_RULES[
    isBusinessCountry(country)
      ? (country.toUpperCase() as BusinessCountry)
      : DEFAULT_BUSINESS_COUNTRY
  ];
}

/** A paper's name in the organisation's country. */
export function documentLabel(
  country: string | null | undefined,
  type: BusinessDocumentType,
): string {
  return (
    rulesFor(country).documentLabels[type] ?? BUSINESS_DOCUMENT_LABELS[type]
  );
}

/** The papers shown to a category in a country: recommended, then optional. */
export function documentsFor(
  country: string | null | undefined,
  category: BusinessCategory,
): DocumentList {
  const rules = rulesFor(country);
  const list = rules.documents[category] ?? BASE_DOCUMENTS[category];
  const exists = (t: BusinessDocumentType) => !rules.without.includes(t);
  return {
    recommended: list.recommended.filter(exists),
    optional: list.optional.filter(exists),
  };
}

/** Every paper an organisation may send (a dashboard upload is checked against it). */
export function acceptedDocuments(
  country: string | null | undefined,
  category: BusinessCategory,
): BusinessDocumentType[] {
  const { recommended, optional } = documentsFor(country, category);
  return [...recommended, ...optional];
}

/** The recommended papers a set of provided ones does not include. */
export function missingRecommendedDocuments(
  country: string | null | undefined,
  category: BusinessCategory,
  provided: readonly BusinessDocumentType[],
): BusinessDocumentType[] {
  const have = new Set(provided);
  return documentsFor(country, category).recommended.filter(
    (t) => !have.has(t),
  );
}

/** Whether a legal form fits a category. */
export function legalFormFits(
  category: BusinessCategory,
  legalForm: BusinessLegalForm,
): boolean {
  return LEGAL_FORMS_BY_CATEGORY[category].includes(legalForm);
}

export type BusinessCatalog = {
  country: BusinessCountry;
  /** The countries an organisation can sign up in, for the form's picker. */
  countries: { code: BusinessCountry; name: string }[];
  categories: {
    value: BusinessCategory;
    label: string;
    legalForms: BusinessLegalForm[];
    /**
     * `required` stays for the forms released before every paper became
     * optional: always empty.
     */
    documents: DocumentList & { required: BusinessDocumentType[][] };
  }[];
  legalForms: { value: BusinessLegalForm; label: string }[];
  documentTypes: { value: BusinessDocumentType; label: string }[];
  identifiers: BusinessIdentifiers;
  sizes: readonly string[];
};

/**
 * Everything a sign-up form needs for one country, in one answer
 * (GET /public/business/catalog?country=CG): the categories in display order,
 * with the legal forms and the papers each one is recommended to send, the
 * papers' and identifiers' local names, and the countries to choose from.
 */
export function businessCatalog(
  country: BusinessCountry = DEFAULT_BUSINESS_COUNTRY,
): BusinessCatalog {
  return {
    country,
    countries: BUSINESS_COUNTRIES.map((code) => ({
      code,
      name: BUSINESS_COUNTRY_NAMES[code],
    })),
    categories: Object.values(BusinessCategory).map((value) => ({
      value,
      label: BUSINESS_CATEGORY_LABELS[value],
      legalForms: LEGAL_FORMS_BY_CATEGORY[value],
      documents: { required: [], ...documentsFor(country, value) },
    })),
    legalForms: Object.values(BusinessLegalForm).map((value) => ({
      value,
      label: BUSINESS_LEGAL_FORM_LABELS[value],
    })),
    documentTypes: Object.values(BusinessDocumentType).map((value) => ({
      value,
      label: documentLabel(country, value),
    })),
    identifiers: COUNTRY_RULES[country].identifiers,
    sizes: BUSINESS_SIZES,
  };
}
