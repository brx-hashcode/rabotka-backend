import {
  BusinessCategory,
  BusinessDocumentType,
  BusinessLegalForm,
} from '@prisma/client';

/**
 * Business categories, legal forms and documents for Congo-Brazzaville, with
 * their French labels and which papers each category provides. A fixed list
 * (product decision): adding a value is a migration plus an entry here.
 *
 * OHADA company law; registration at the CFE (RCCM); NIU from the tax
 * administration; SCIEN / SCIET from the CNSEE; associations are declared and
 * receive a récépissé.
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
 * Which papers a category must provide, and which it may. « One of » groups
 * are alternatives: any one of the group satisfies it (an école has an
 * autorisation d'ouverture OR an agrément).
 */
export type DocumentRequirement = {
  required: BusinessDocumentType[][];
  optional: BusinessDocumentType[];
};

const COMPANY_DOCS: DocumentRequirement = {
  required: [['RCCM'], ['NIU']],
  optional: ['STATUTS', 'PATENTE', 'SCIEN_SCIET', 'CNSS', 'MANDATE'],
};

export const DOCUMENTS_BY_CATEGORY: Record<
  BusinessCategory,
  DocumentRequirement
> = {
  INDIVIDUAL_BUSINESS: COMPANY_DOCS,
  TPE: COMPANY_DOCS,
  PME: COMPANY_DOCS,
  LARGE_COMPANY: COMPANY_DOCS,
  STARTUP: COMPANY_DOCS,
  COOPERATIVE: {
    required: [['RCCM'], ['NIU']],
    optional: ['STATUTS', 'MANDATE'],
  },
  GIE: { required: [['RCCM'], ['NIU']], optional: ['STATUTS', 'MANDATE'] },
  ASSOCIATION: {
    required: [['RECEPISSE'], ['STATUTS']],
    optional: ['AGREMENT', 'NIU', 'MANDATE'],
  },
  NGO: {
    required: [['RECEPISSE'], ['STATUTS']],
    optional: ['AGREMENT', 'NIU', 'MANDATE'],
  },
  FOUNDATION: {
    required: [['RECEPISSE'], ['STATUTS']],
    optional: ['AGREMENT', 'NIU', 'MANDATE'],
  },
  INTERNATIONAL_NGO: { required: [['AGREMENT']], optional: ['NIU', 'MANDATE'] },
  INTERNATIONAL_ORG: { required: [['AGREMENT']], optional: ['MANDATE'] },
  RELIGIOUS: { required: [['RECEPISSE'], ['STATUTS']], optional: ['MANDATE'] },
  SCHOOL: {
    required: [['AUTORISATION_OUVERTURE', 'AGREMENT']],
    optional: ['RCCM', 'NIU', 'MANDATE'],
  },
  HIGHER_EDUCATION: {
    required: [['AUTORISATION_OUVERTURE', 'AGREMENT']],
    optional: ['RCCM', 'NIU', 'MANDATE'],
  },
  TRAINING_CENTER: {
    required: [['AUTORISATION_OUVERTURE', 'AGREMENT']],
    optional: ['RCCM', 'NIU', 'MANDATE'],
  },
  HEALTH: {
    required: [['AUTORISATION_OUVERTURE', 'AGREMENT']],
    optional: ['RCCM', 'NIU', 'MANDATE'],
  },
  PUBLIC_ADMINISTRATION: {
    required: [['ARRETE']],
    optional: ['NIU', 'MANDATE'],
  },
  PUBLIC_ENTERPRISE: {
    required: [['ARRETE']],
    optional: ['NIU', 'RCCM', 'MANDATE'],
  },
  OTHER: { required: [], optional: Object.values(BusinessDocumentType) },
};

/** The required groups a set of provided documents does not cover. */
export function missingRequiredDocuments(
  category: BusinessCategory,
  provided: readonly BusinessDocumentType[],
): BusinessDocumentType[][] {
  const have = new Set(provided);
  return DOCUMENTS_BY_CATEGORY[category].required.filter(
    (group) => !group.some((t) => have.has(t)),
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
  categories: {
    value: BusinessCategory;
    label: string;
    legalForms: BusinessLegalForm[];
    documents: DocumentRequirement;
  }[];
  legalForms: { value: BusinessLegalForm; label: string }[];
  documentTypes: { value: BusinessDocumentType; label: string }[];
  sizes: readonly string[];
};

/**
 * Everything a sign-up form needs, in one answer (GET /public/business/catalog):
 * the categories in display order, with the legal forms and documents each
 * one takes. The same tables the server checks a sign-up against, so the form
 * can never ask for something different.
 */
export function businessCatalog(): BusinessCatalog {
  return {
    categories: Object.values(BusinessCategory).map((value) => ({
      value,
      label: BUSINESS_CATEGORY_LABELS[value],
      legalForms: LEGAL_FORMS_BY_CATEGORY[value],
      documents: DOCUMENTS_BY_CATEGORY[value],
    })),
    legalForms: Object.values(BusinessLegalForm).map((value) => ({
      value,
      label: BUSINESS_LEGAL_FORM_LABELS[value],
    })),
    documentTypes: Object.values(BusinessDocumentType).map((value) => ({
      value,
      label: BUSINESS_DOCUMENT_LABELS[value],
    })),
    sizes: BUSINESS_SIZES,
  };
}
