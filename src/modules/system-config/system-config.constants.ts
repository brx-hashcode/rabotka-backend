import { ConfigCategory } from '@prisma/client';

export interface ConfigDefault {
  key: string;
  value: string;
  category: ConfigCategory;
  label: string;
  isSecret: boolean;
}

export const DEFAULT_SYSTEM_CONFIGS: ConfigDefault[] = [
  // ── TWILIO ────────────────────────────────────────────────────────────────
  {
    key: 'twilio.account_sid',
    value: '',
    category: ConfigCategory.TWILIO,
    label: 'Twilio Account SID',
    isSecret: false,
  },
  {
    key: 'twilio.auth_token',
    value: '',
    category: ConfigCategory.TWILIO,
    label: 'Twilio Auth Token',
    isSecret: true,
  },
  {
    key: 'twilio.whatsapp_from',
    value: '',
    category: ConfigCategory.TWILIO,
    label: 'Numéro WhatsApp expéditeur (ex: whatsapp:+14155...)',
    isSecret: false,
  },
  {
    key: 'twilio.sms_from',
    value: '',
    category: ConfigCategory.TWILIO,
    label: 'Numéro SMS expéditeur',
    isSecret: false,
  },

  // ── FEES ──────────────────────────────────────────────────────────────────
  {
    key: 'fees.late_cancellation_penalty_fcfa',
    value: '5000',
    category: ConfigCategory.FEES,
    label: 'Pénalité annulation tardive (FCFA)',
    isSecret: false,
  },
  {
    key: 'fees.late_cancellation_score_deduction',
    value: '5',
    category: ConfigCategory.FEES,
    label: 'Déduction score fiabilité (annulation tardive)',
    isSecret: false,
  },
  {
    key: 'fees.cancellation_threshold_hours',
    value: '4',
    category: ConfigCategory.FEES,
    label: 'Délai annulation sans pénalité (heures)',
    isSecret: false,
  },
  {
    key: 'fees.reliability_score_min',
    value: '50',
    category: ConfigCategory.FEES,
    label: 'Score fiabilité minimum',
    isSecret: false,
  },
  {
    key: 'fees.employer_cancel_score_deduction',
    value: '5',
    category: ConfigCategory.FEES,
    label: "Déduction score employeur (annulation d'un travailleur accepté)",
    isSecret: false,
  },
  {
    key: 'fees.employer_ghost_score_deduction',
    value: '10',
    category: ConfigCategory.FEES,
    label: "Déduction score employeur (offre expirée avec travailleur accepté)",
    isSecret: false,
  },
  {
    key: 'fees.billing_block_threshold',
    value: '2',
    category: ConfigCategory.FEES,
    label: 'Nombre de pénalités impayées avant blocage',
    isSecret: false,
  },
  {
    key: 'fees.max_concurrent_applications',
    value: '3',
    category: ConfigCategory.FEES,
    label: 'Nombre max de candidatures simultanées (par travailleur)',
    isSecret: false,
  },
  {
    key: 'fees.contact_unlock_fee_employer',
    value: '500',
    category: ConfigCategory.FEES,
    label: 'Frais déverrouillage contact – Employeur (FCFA)',
    isSecret: false,
  },
  {
    key: 'fees.contact_unlock_fee_worker',
    value: '100',
    category: ConfigCategory.FEES,
    label: 'Frais déverrouillage contact – Travailleur (FCFA)',
    isSecret: false,
  },
  {
    key: 'fees.contact_unlock_expiry_hours',
    value: '48',
    category: ConfigCategory.FEES,
    label: 'Délai expiration déverrouillage contact (heures)',
    isSecret: false,
  },
  {
    key: 'fees.welcome_credit_worker',
    value: '100',
    category: ConfigCategory.FEES,
    label: 'Crédit de bienvenue – Travailleur (FCFA)',
    isSecret: false,
  },
  {
    key: 'fees.welcome_credit_employer',
    value: '500',
    category: ConfigCategory.FEES,
    label: 'Crédit de bienvenue – Employeur (FCFA)',
    isSecret: false,
  },

  // ── MATCHING ──────────────────────────────────────────────────────────────
  {
    key: 'matching.use_embeddings',
    value: 'false',
    category: ConfigCategory.MATCHING,
    label: 'Activer algorithme de similarité (embeddings)',
    isSecret: false,
  },

  // ── CONTACT ───────────────────────────────────────────────────────────────
  {
    key: 'contact.email',
    value: 'contact@rabotka.com',
    category: ConfigCategory.CONTACT,
    label: 'Email de contact',
    isSecret: false,
  },
  {
    key: 'contact.phone',
    value: '',
    category: ConfigCategory.CONTACT,
    label: 'Téléphone de contact',
    isSecret: false,
  },
  {
    key: 'contact.address',
    value: '',
    category: ConfigCategory.CONTACT,
    label: 'Adresse physique',
    isSecret: false,
  },
  {
    key: 'contact.orange_money_number',
    value: '06 000 0000',
    category: ConfigCategory.CONTACT,
    label: 'Numéro Orange Money (paiement pénalités)',
    isSecret: false,
  },
  {
    key: 'contact.airtel_money_number',
    value: '07 000 0000',
    category: ConfigCategory.CONTACT,
    label: 'Numéro Airtel Money (paiement pénalités)',
    isSecret: false,
  },

  // ── STORAGE ───────────────────────────────────────────────────────────────
  {
    key: 'storage.driver',
    value: 'S3',
    category: ConfigCategory.STORAGE,
    label: 'Fournisseur actif (S3 | CLOUDFLARE | CLOUDINARY | VERCEL_BLOB)',
    isSecret: false,
  },
  // S3
  {
    key: 'storage.s3.bucket',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'S3 – Nom du bucket',
    isSecret: false,
  },
  {
    key: 'storage.s3.region',
    value: 'us-east-1',
    category: ConfigCategory.STORAGE,
    label: 'S3 – Région',
    isSecret: false,
  },
  {
    key: 'storage.s3.access_key_id',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'S3 – Access Key ID',
    isSecret: true,
  },
  {
    key: 'storage.s3.secret_access_key',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'S3 – Secret Access Key',
    isSecret: true,
  },
  {
    key: 'storage.s3.endpoint',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'S3 – Endpoint personnalisé (optionnel)',
    isSecret: false,
  },
  // Cloudflare R2
  {
    key: 'storage.cloudflare.account_id',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'Cloudflare R2 – Account ID',
    isSecret: false,
  },
  {
    key: 'storage.cloudflare.bucket_name',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'Cloudflare R2 – Nom du bucket',
    isSecret: false,
  },
  {
    key: 'storage.cloudflare.access_key_id',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'Cloudflare R2 – Access Key ID',
    isSecret: true,
  },
  {
    key: 'storage.cloudflare.secret_access_key',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'Cloudflare R2 – Secret Access Key',
    isSecret: true,
  },
  // Cloudinary
  {
    key: 'storage.cloudinary.cloud_name',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'Cloudinary – Cloud Name',
    isSecret: false,
  },
  {
    key: 'storage.cloudinary.api_key',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'Cloudinary – API Key',
    isSecret: true,
  },
  {
    key: 'storage.cloudinary.api_secret',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'Cloudinary – API Secret',
    isSecret: true,
  },
  // Vercel Blob
  {
    key: 'storage.vercel_blob.token',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'Vercel Blob – Read/Write Token',
    isSecret: true,
  },
];

/** Maps system-config keys to the env var names each storage provider reads */
export const STORAGE_ENV_OVERRIDES: Record<string, Record<string, string>> = {
  S3: {
    AWS_S3_BUCKET: 'storage.s3.bucket',
    AWS_REGION: 'storage.s3.region',
    AWS_ACCESS_KEY_ID: 'storage.s3.access_key_id',
    AWS_SECRET_ACCESS_KEY: 'storage.s3.secret_access_key',
    AWS_ENDPOINT_URL: 'storage.s3.endpoint',
  },
  CLOUDFLARE: {
    CLOUDFLARE_ACCOUNT_ID: 'storage.cloudflare.account_id',
    CLOUDFLARE_BUCKET_NAME: 'storage.cloudflare.bucket_name',
    CLOUDFLARE_ACCESS_KEY_ID: 'storage.cloudflare.access_key_id',
    CLOUDFLARE_SECRET_ACCESS_KEY: 'storage.cloudflare.secret_access_key',
  },
  CLOUDINARY: {
    CLOUDINARY_CLOUD_NAME: 'storage.cloudinary.cloud_name',
    CLOUDINARY_API_KEY: 'storage.cloudinary.api_key',
    CLOUDINARY_API_SECRET: 'storage.cloudinary.api_secret',
  },
  VERCEL_BLOB: {
    BLOB_READ_WRITE_TOKEN: 'storage.vercel_blob.token',
  },
};
