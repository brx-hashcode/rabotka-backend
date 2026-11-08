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
 * Rabotka Business is open where its payment gateway (pawaPay) collects
 * mobile money: an organisation must be able to pay for its plan. Most are
 * OHADA countries, with the same legal forms everywhere and the papers' names
 * differing; the others (Kenya, Uganda, Rwanda, Zambia, Mozambique, Sierra
 * Leone) name their papers, numbers and company forms their own way. No paper
 * is required: an organisation sends what it has, the review asks for the rest.
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

/**
 * The countries an organisation can sign up in: those pawaPay collects mobile
 * money in, so it can pay. Central Africa first, then West, then East and South.
 */
export const BUSINESS_COUNTRIES = [
  'CG',
  'CD',
  'CM',
  'GA',
  'BJ',
  'CI',
  'SN',
  'SL',
  'KE',
  'UG',
  'RW',
  'ZM',
  'MZ',
] as const;
export type OpenBusinessCountry = (typeof BUSINESS_COUNTRIES)[number];

/**
 * Countries no longer open to sign-up (no mobile money the gateway collects),
 * kept so the organisations registered there still read their own rules.
 */
const CLOSED_BUSINESS_COUNTRIES = ['TD', 'CF', 'GQ'] as const;

/** Every country an organisation can be in: open, or registered before it closed. */
export type BusinessCountry =
  OpenBusinessCountry | (typeof CLOSED_BUSINESS_COUNTRIES)[number];

/** Where an organisation with no (or an older, other) country is read from. */
export const DEFAULT_BUSINESS_COUNTRY: BusinessCountry = 'CG';

export const BUSINESS_COUNTRY_NAMES: Record<BusinessCountry, string> = {
  CG: 'Congo-Brazzaville',
  CD: 'Congo-Kinshasa (RDC)',
  CM: 'Cameroun',
  GA: 'Gabon',
  BJ: 'Bénin',
  CI: "Côte d'Ivoire",
  SN: 'Sénégal',
  SL: 'Sierra Leone',
  KE: 'Kenya',
  UG: 'Ouganda',
  RW: 'Rwanda',
  ZM: 'Zambie',
  MZ: 'Mozambique',
  TD: 'Tchad',
  CF: 'République centrafricaine',
  GQ: 'Guinée équatoriale',
};

export const BUSINESS_COUNTRIES_SENTENCE = `Rabotka Business est disponible dans ces pays : ${BUSINESS_COUNTRIES.map(
  (c) => BUSINESS_COUNTRY_NAMES[c],
)
  .sort((a, b) => a.localeCompare(b, 'fr'))
  .join(', ')}.`;

/** One an organisation can sign up in (or move to). */
export function isBusinessCountry(
  code: string | null | undefined,
): code is OpenBusinessCountry {
  return (
    !!code &&
    (BUSINESS_COUNTRIES as readonly string[]).includes(code.toUpperCase())
  );
}

/** Open, or closed with organisations still registered there. */
export function isKnownBusinessCountry(
  code: string | null | undefined,
): code is BusinessCountry {
  return (
    isBusinessCountry(code) ||
    (!!code &&
      (CLOSED_BUSINESS_COUNTRIES as readonly string[]).includes(
        code.toUpperCase(),
      ))
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
  /** Each legal form's local name, over the OHADA one. */
  legalFormLabels?: Partial<Record<BusinessLegalForm, string>>;
  /** OHADA forms the country's law does not have. */
  withoutForms?: BusinessLegalForm[];
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
 * Outside OHADA: companies are incorporated at a registrar (certificate of
 * incorporation, a company number) and taxed under a TIN; the company forms
 * are the private and public limited company, the partnership and the sole
 * trader — no SAS, SCS, SCOOPS or GIE.
 */
const NON_OHADA_FORMS: Pick<CountryRules, 'legalFormLabels' | 'withoutForms'> =
  {
    legalFormLabels: {
      EI: 'Entreprise individuelle (sole proprietorship)',
      SARL: 'Société privée à responsabilité limitée (Ltd)',
      SA: 'Société anonyme publique (PLC)',
      SNC: 'Société de personnes (partnership)',
      COOP_CA: 'Société coopérative',
      ASSOCIATION: 'Association ou ONG enregistrée',
    },
    withoutForms: ['SARLU', 'SAS', 'SASU', 'SCS', 'SCOOPS', 'GIE'],
  };

/** The papers' names outside OHADA, the registrar and the social fund named. */
function nonOhadaLabels(
  registrar: string,
  tax: string,
  social: string,
): Partial<Record<BusinessDocumentType, string>> {
  return {
    RCCM: `Certificat d'immatriculation (${registrar})`,
    NIU: `Attestation d'immatriculation fiscale (${tax})`,
    CNSS: `Attestation d'affiliation ${social}`,
    PATENTE: "Licence d'exploitation (business permit)",
    RECEPISSE: "Certificat d'enregistrement (association / ONG)",
  };
}

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
  BJ: {
    documentLabels: {
      NIU: 'Attestation IFU',
      CNSS: "Attestation d'immatriculation CNSS",
    },
    identifiers: {
      registrationNumber: rccm('RB/COT/24 B 12345'),
      taxId: { label: 'IFU', placeholder: '3202412345678' },
      statisticalId: null,
    },
    documents: {},
    without: ['SCIEN_SCIET'],
  },
  CI: {
    documentLabels: {
      NIU: 'Attestation de compte contribuable (NCC)',
      CNSS: "Attestation d'immatriculation CNPS",
    },
    identifiers: {
      registrationNumber: rccm('CI-ABJ-03-2024-B12-01234'),
      taxId: { label: 'N° compte contribuable (NCC)', placeholder: '2412345A' },
      statisticalId: null,
    },
    documents: {},
    without: ['SCIEN_SCIET'],
  },
  SN: {
    documentLabels: {
      NIU: 'Attestation NINEA',
      CNSS: "Attestation d'immatriculation CSS / IPRES",
    },
    identifiers: {
      registrationNumber: rccm('SN-DKR-2024-B-12345'),
      taxId: { label: 'NINEA', placeholder: '012345678 2G3' },
      statisticalId: null,
    },
    documents: {},
    without: ['SCIEN_SCIET'],
  },
  SL: {
    documentLabels: nonOhadaLabels('CAC', 'TIN, NRA', 'NASSIT'),
    identifiers: {
      registrationNumber: { label: "N° d'immatriculation (CAC)" },
      taxId: { label: 'TIN (NRA)' },
      statisticalId: null,
    },
    documents: {},
    without: ['SCIEN_SCIET'],
    ...NON_OHADA_FORMS,
  },
  KE: {
    documentLabels: nonOhadaLabels('BRS', 'KRA PIN', 'NSSF'),
    identifiers: {
      registrationNumber: {
        label: "N° d'immatriculation (BRS)",
        placeholder: 'PVT-AB1CD2EF',
      },
      taxId: { label: 'KRA PIN', placeholder: 'P051234567X' },
      statisticalId: null,
    },
    documents: {},
    without: ['SCIEN_SCIET'],
    ...NON_OHADA_FORMS,
  },
  UG: {
    documentLabels: nonOhadaLabels('URSB', 'TIN, URA', 'NSSF'),
    identifiers: {
      registrationNumber: { label: "N° d'immatriculation (URSB)" },
      taxId: { label: 'TIN (URA)', placeholder: '1001234567' },
      statisticalId: null,
    },
    documents: {},
    without: ['SCIEN_SCIET'],
    ...NON_OHADA_FORMS,
  },
  RW: {
    documentLabels: nonOhadaLabels('RDB', 'TIN, RRA', 'RSSB'),
    identifiers: {
      registrationNumber: { label: "N° d'entreprise (RDB)" },
      taxId: { label: 'TIN (RRA)', placeholder: '101234567' },
      statisticalId: null,
    },
    documents: {},
    without: ['SCIEN_SCIET'],
    ...NON_OHADA_FORMS,
  },
  ZM: {
    documentLabels: nonOhadaLabels('PACRA', 'TPIN, ZRA', 'NAPSA'),
    identifiers: {
      registrationNumber: { label: 'N° PACRA' },
      taxId: { label: 'TPIN (ZRA)', placeholder: '1001234567' },
      statisticalId: null,
    },
    documents: {},
    without: ['SCIEN_SCIET'],
    ...NON_OHADA_FORMS,
  },
  MZ: {
    documentLabels: {
      ...nonOhadaLabels('Conservatória', 'NUIT', 'INSS'),
      RCCM: 'Certidão de registo comercial',
      PATENTE: 'Alvará',
    },
    identifiers: {
      registrationNumber: { label: 'N° de registo comercial' },
      taxId: { label: 'NUIT', placeholder: '400123456' },
      statisticalId: null,
    },
    documents: {},
    without: ['SCIEN_SCIET'],
    legalFormLabels: {
      EI: 'Empresário em nome individual',
      SARL: 'Sociedade por quotas (Lda)',
      SARLU: 'Sociedade unipessoal por quotas',
      SA: 'Sociedade anónima (SA)',
      SNC: 'Sociedade em nome colectivo',
      COOP_CA: 'Cooperativa',
      ASSOCIATION: 'Associação',
    },
    withoutForms: ['SAS', 'SASU', 'SCS', 'SCOOPS', 'GIE'],
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
    isKnownBusinessCountry(country)
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

/**
 * The legal forms offered to a category in a country: the category's, less
 * those the country's law does not have (« Autre » when none is left).
 */
export function legalFormsFor(
  country: string | null | undefined,
  category: BusinessCategory,
): BusinessLegalForm[] {
  const without = rulesFor(country).withoutForms ?? [];
  const forms = LEGAL_FORMS_BY_CATEGORY[category].filter(
    (f) => !without.includes(f),
  );
  return forms.length > 0 ? forms : ['OTHER'];
}

/** A legal form's name in the organisation's country. */
export function legalFormLabel(
  country: string | null | undefined,
  legalForm: BusinessLegalForm,
): string {
  return (
    rulesFor(country).legalFormLabels?.[legalForm] ??
    BUSINESS_LEGAL_FORM_LABELS[legalForm]
  );
}

/** Whether a legal form fits a category (in a country, when given). */
export function legalFormFits(
  category: BusinessCategory,
  legalForm: BusinessLegalForm,
  country?: string | null,
): boolean {
  return country === undefined
    ? LEGAL_FORMS_BY_CATEGORY[category].includes(legalForm)
    : legalFormsFor(country, category).includes(legalForm);
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
      legalForms: legalFormsFor(country, value),
      documents: { required: [], ...documentsFor(country, value) },
    })),
    legalForms: Object.values(BusinessLegalForm).map((value) => ({
      value,
      label: legalFormLabel(country, value),
    })),
    documentTypes: Object.values(BusinessDocumentType).map((value) => ({
      value,
      label: documentLabel(country, value),
    })),
    identifiers: COUNTRY_RULES[country].identifiers,
    sizes: BUSINESS_SIZES,
  };
}
