export const PAYMENT_GATEWAY_PROVIDER = 'PAYMENT_GATEWAY_PROVIDER';

export const PAYMENT_ENV_OVERRIDES: Record<string, Record<string, string>> = {
  MONETBIL: {
    MONETBIL_SERVICE_KEY: 'payment.monetbil.service_key',
  },
  MTN_MOMO: {
    MTN_MOMO_BASE_URL: 'payment.mtn_momo.base_url',
    MTN_MOMO_COLLECTION_API_USER: 'payment.mtn_momo.collection_api_user',
    MTN_MOMO_COLLECTION_API_KEY: 'payment.mtn_momo.collection_api_key',
    MTN_MOMO_COLLECTION_PRIMARY_KEY: 'payment.mtn_momo.collection_primary_key',
    MTN_MOMO_ENVIRONMENT: 'payment.mtn_momo.environment',
    MTN_MOMO_CALLBACK_URL: 'payment.mtn_momo.callback_url',
  },
};
