import { z } from 'zod';
import type { ProviderName } from './contracts';

/**
 * Environment contract for WhatsApp sending, validated at boot.
 *
 * The schema is DISCRIMINATED on `WHATSAPP_PROVIDER`: Cloud credentials are
 * required only when `cloud` is selected and Twilio's only when `twilio`, so
 * nobody has to hold a full set of Meta credentials to run the Twilio path (or
 * the reverse). Both sets stay populated in production regardless — rollback is
 * a single env change plus a restart, and that only works if the other
 * provider's credentials are already sitting there.
 *
 * Fails fast and names the offending variable. Until this landed there was no
 * env validation anywhere in the app, so a blank credential surfaced as
 * `isConfigured() === false` and messages that silently never sent.
 */

/**
 * `FOO=` in a .env file is an empty string, not an absent key, and an empty
 * credential is exactly the failure this schema exists to catch — so required
 * variables have to reject it explicitly.
 */
function required(description: string) {
  return z
    .string({ error: `is required (${description})` })
    .trim()
    .min(1, { error: `must not be empty (${description})` });
}

const twilioSchema = z.looseObject({
  WHATSAPP_PROVIDER: z.literal('twilio'),
  TWILIO_ACCOUNT_SID: required('Twilio account SID'),
  TWILIO_AUTH_TOKEN: required('Twilio auth token'),
  TWILIO_WHATSAPP_FROM: required(
    'Twilio WhatsApp sender, e.g. whatsapp:+14155…',
  ),
  // sendSms() has no callers today; the number is only needed if that changes.
  TWILIO_SMS_FROM: z.string().trim().optional(),
});

const cloudSchema = z.looseObject({
  WHATSAPP_PROVIDER: z.literal('cloud'),
  WHATSAPP_CLOUD_API_VERSION: z
    .string()
    .trim()
    .regex(/^v\d+\.\d+$/, { error: 'must look like "v25.0"' })
    .default('v25.0'),
  WHATSAPP_CLOUD_PHONE_NUMBER_ID: required('Meta phone number ID'),
  WHATSAPP_CLOUD_ACCESS_TOKEN: required('Meta system-user access token'),
  WHATSAPP_CLOUD_APP_SECRET: required(
    'X-Hub-Signature-256 verification secret',
  ),
  WHATSAPP_CLOUD_VERIFY_TOKEN: required('GET webhook handshake token'),
  WHATSAPP_CLOUD_WABA_ID: required('WhatsApp Business Account ID'),
});

/**
 * `discriminatedUnion` needs the discriminator resolved before it can pick a
 * branch, so the default is applied here rather than on the literal.
 */
const whatsappEnvSchema = z.preprocess(
  (raw) => {
    const env = (raw ?? {}) as Record<string, unknown>;
    const provider =
      typeof env.WHATSAPP_PROVIDER === 'string' &&
      env.WHATSAPP_PROVIDER.trim().length > 0
        ? env.WHATSAPP_PROVIDER.trim()
        : 'twilio';
    return { ...env, WHATSAPP_PROVIDER: provider };
  },
  z.discriminatedUnion('WHATSAPP_PROVIDER', [twilioSchema, cloudSchema]),
);

export type TwilioEnv = z.infer<typeof twilioSchema>;
export type CloudEnv = z.infer<typeof cloudSchema>;
export type WhatsappEnv = z.infer<typeof whatsappEnvSchema>;

export interface TwilioProviderConfig {
  provider: 'twilio';
  accountSid: string;
  authToken: string;
  whatsappFrom: string;
  smsFrom: string | null;
}

export interface CloudProviderConfig {
  provider: 'cloud';
  apiVersion: string;
  phoneNumberId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  wabaId: string;
}

export type WhatsappConfig = TwilioProviderConfig | CloudProviderConfig;

/** Injection token for the resolved, validated config. */
export const WHATSAPP_CONFIG = Symbol('WHATSAPP_CONFIG');

export class WhatsappConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhatsappConfigError';
  }
}

function formatIssues(error: z.ZodError, provider: string): string {
  const lines = error.issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    return `  - ${key}: ${issue.message}`;
  });
  return (
    `Invalid WhatsApp configuration for WHATSAPP_PROVIDER="${provider}":\n` +
    lines.join('\n') +
    `\n\nSee docs/whatsapp-providers.md for the variables each provider needs.`
  );
}

/**
 * Parse and validate the WhatsApp slice of the environment.
 *
 * Throws `WhatsappConfigError` naming every offending variable at once —
 * fixing them one restart at a time is miserable when six are blank.
 */
export function parseWhatsappConfig(
  env: Record<string, unknown>,
): WhatsappConfig {
  const provider =
    typeof env.WHATSAPP_PROVIDER === 'string' &&
    env.WHATSAPP_PROVIDER.trim().length > 0
      ? env.WHATSAPP_PROVIDER.trim()
      : 'twilio';

  if (provider !== 'twilio' && provider !== 'cloud') {
    throw new WhatsappConfigError(
      `WHATSAPP_PROVIDER must be "twilio" or "cloud", received "${provider}".`,
    );
  }

  const result = whatsappEnvSchema.safeParse(env);
  if (!result.success) {
    throw new WhatsappConfigError(formatIssues(result.error, provider));
  }

  const parsed = result.data;
  if (parsed.WHATSAPP_PROVIDER === 'cloud') {
    return {
      provider: 'cloud',
      apiVersion: parsed.WHATSAPP_CLOUD_API_VERSION,
      phoneNumberId: parsed.WHATSAPP_CLOUD_PHONE_NUMBER_ID,
      accessToken: parsed.WHATSAPP_CLOUD_ACCESS_TOKEN,
      appSecret: parsed.WHATSAPP_CLOUD_APP_SECRET,
      verifyToken: parsed.WHATSAPP_CLOUD_VERIFY_TOKEN,
      wabaId: parsed.WHATSAPP_CLOUD_WABA_ID,
    };
  }

  return {
    provider: 'twilio',
    accountSid: parsed.TWILIO_ACCOUNT_SID,
    authToken: parsed.TWILIO_AUTH_TOKEN,
    whatsappFrom: parsed.TWILIO_WHATSAPP_FROM,
    smsFrom: parsed.TWILIO_SMS_FROM?.trim() || null,
  };
}

/**
 * `ConfigModule.forRoot({ validate })` hook.
 *
 * Returns the environment UNCHANGED — the rest of the app reads dozens of
 * variables through `ConfigService`, and returning only this slice would strip
 * every one of them.
 */
export function validateWhatsappEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  parseWhatsappConfig(config);
  return config;
}

export function resolvedProviderName(config: WhatsappConfig): ProviderName {
  return config.provider;
}
