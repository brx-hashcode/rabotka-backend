import { ConfigCategory } from '@prisma/client';

export interface ConfigDefault {
  key: string;
  value: string;
  category: ConfigCategory;
  label: string;
  isSecret: boolean;
}

// The `twilio.*` keys lived here until WhatsApp gained a second provider.
// Messaging credentials are environment-only now, for both Twilio and Meta
// Cloud — see whatsapp.config.ts. `ConfigCategory.TWILIO` stays in the Prisma
// enum: it is unused, and removing a Postgres enum value is a destructive
// migration for no gain.
export const DEFAULT_SYSTEM_CONFIGS: ConfigDefault[] = [
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
    key: 'fees.employer_late_cancel_score_deduction',
    value: '5',
    category: ConfigCategory.FEES,
    label:
      'Déduction score employeur (annulation tardive ou offre non démarrée avec travailleur accepté)',
    isSecret: false,
  },
  {
    key: 'fees.completion_score_reward',
    value: '1',
    category: ConfigCategory.FEES,
    label: 'Bonus score fiabilité (travail terminé)',
    isSecret: false,
  },
  {
    key: 'fees.rating_score_delta_1',
    value: '-4',
    category: ConfigCategory.FEES,
    label: 'Ajustement score fiabilité — note 1★',
    isSecret: false,
  },
  {
    key: 'fees.rating_score_delta_2',
    value: '-2',
    category: ConfigCategory.FEES,
    label: 'Ajustement score fiabilité — note 2★',
    isSecret: false,
  },
  {
    key: 'fees.rating_score_delta_3',
    value: '0',
    category: ConfigCategory.FEES,
    label: 'Ajustement score fiabilité — note 3★',
    isSecret: false,
  },
  {
    key: 'fees.rating_score_delta_4',
    value: '1',
    category: ConfigCategory.FEES,
    label: 'Ajustement score fiabilité — note 4★',
    isSecret: false,
  },
  {
    key: 'fees.rating_score_delta_5',
    value: '3',
    category: ConfigCategory.FEES,
    label: 'Ajustement score fiabilité — note 5★',
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
    key: 'fees.max_daily_applications',
    value: '10',
    category: ConfigCategory.FEES,
    label: 'Nombre max de candidatures par jour (par travailleur)',
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
    key: 'fees.contact_recommendation_fee_employer',
    value: '1000',
    category: ConfigCategory.FEES,
    label: 'Frais contact depuis recommandation – Employeur (FCFA)',
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
  {
    key: 'matching.min_notification_score',
    value: '0.55',
    category: ConfigCategory.MATCHING,
    label: 'Score minimum pour notification de recommandation',
    isSecret: false,
  },
  {
    key: 'matching.recommendations_enabled',
    value: 'true',
    category: ConfigCategory.MATCHING,
    label: 'Activer les notifications de recommandation de jobs',
    isSecret: false,
  },
  {
    key: 'matching.recommendation_min_score',
    value: '0.3',
    category: ConfigCategory.MATCHING,
    label: 'Score minimum pour le fil de profils recommandés (employeur)',
    isSecret: false,
  },
  {
    key: 'matching.cf_enabled',
    value: 'false',
    category: ConfigCategory.MATCHING,
    label: 'Activer le filtrage collaboratif (recommandations croisées)',
    isSecret: false,
  },
  {
    key: 'matching.engine_version',
    value: 'legacy',
    category: ConfigCategory.MATCHING,
    label: 'Moteur de recommandation actif (legacy | v2)',
    isSecret: false,
  },
  {
    key: 'matching.v2_rollout_percent',
    value: '0',
    category: ConfigCategory.MATCHING,
    label: 'Pourcentage d’utilisateurs sur le moteur v2 (0-100)',
    isSecret: false,
  },
  {
    key: 'matching.max_notification_workers',
    value: '20',
    category: ConfigCategory.MATCHING,
    label: 'Nombre max de travailleurs notifiés par offre',
    isSecret: false,
  },
  {
    key: 'matching.notification_cooldown_minutes',
    value: '60',
    category: ConfigCategory.MATCHING,
    label: 'Délai minimum entre deux notifications de recommandation (minutes)',
    isSecret: false,
  },

  // ── GENERAL ───────────────────────────────────────────────────────────────
  {
    key: 'general.description',
    value:
      'Plateforme de mise en relation entre employeurs et travailleurs informels en Afrique.',
    category: ConfigCategory.GENERAL,
    label: 'Description courte de Rabotka (utilisée dans les emails)',
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
  {
    key: 'storage.cloudflare.public_base_url',
    value: '',
    category: ConfigCategory.STORAGE,
    label: 'Cloudflare R2 – Public Base URL (ex: https://pub-xxx.r2.dev)',
    isSecret: false,
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
    CLOUDFLARE_PUBLIC_BASE_URL: 'storage.cloudflare.public_base_url',
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
