import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { IPaymentGateway } from '../interfaces/payment-gateway.interface';
import {
  GatewayBalance,
  GatewayCountry,
  InitiatePaymentParams,
  InitiatePaymentResult,
  InitiatePayoutParams,
  PaymentGatewayDriver,
  PaymentGatewayMetadata,
  PaymentStatusResult,
  PayoutResult,
  PayoutStatusResult,
  WebhookHandleResult,
} from '../types/payment-gateway.types';
import { fetchWithTimeout } from '../../../utils/fetch-with-timeout.util';

/**
 * pawaPay routes by network, so the payer has to pick one. Codes are
 * pawaPay's own provider codes (`<NETWORK>_<ISO3>`), sent as-is.
 */
export const PAWAPAY_METADATA: PaymentGatewayMetadata = {
  key: PaymentGatewayDriver.PAWAPAY,
  label: 'pawaPay',
  requiresOperator: true,
  operators: [
    { code: 'MTN_MOMO_COG', label: 'MTN Mobile Money' },
    { code: 'AIRTEL_COG', label: 'Airtel Money' },
  ],
};

/** Calling code per country, to put a local number in MSISDN form. */
const DIAL_CODES: Record<string, string> = { COG: '242', CMR: '237' };

/** pawaPay accepts at most 10 metadata fields on a payment. */
const MAX_METADATA_FIELDS = 10;

/** How long the account's country list is trusted before asking again. */
const COUNTRIES_TTL_MS = 60 * 60 * 1000;

/** What each kind of payment says on the payer's SMS receipt. */
const CUSTOMER_MESSAGES: Record<string, string> = {
  CONTACT_UNLOCK: 'Rabotka contact',
  RECOMMENDATION_CONTACT: 'Rabotka contact',
  WALLET_TOP_UP: 'Rabotka recharge',
  PENALTY_BATCH: 'Rabotka penalite',
  PENALTY_RESOLUTION: 'Rabotka penalite',
};

/**
 * Readable reasons for the rejections a payer can do something about. Anything
 * else falls back to the generic message with pawaPay's code.
 */
const REJECTION_MESSAGES: Record<string, string> = {
  INVALID_PHONE_NUMBER: 'Numéro de téléphone invalide.',
  INVALID_PAYER_FORMAT: 'Numéro de téléphone invalide.',
  PROVIDER_TEMPORARILY_UNAVAILABLE:
    "L'opérateur est momentanément indisponible. Réessayez dans quelques minutes.",
  AMOUNT_OUT_OF_BOUNDS: "Ce montant n'est pas accepté par l'opérateur.",
  INVALID_AMOUNT: 'Montant invalide.',
  INVALID_PROVIDER: 'Opérateur non pris en charge.',
};

type MetadataItem = Record<string, string | boolean>;

/** The ISO3 country a pawaPay provider code belongs to (`MTN_MOMO_COG` → `COG`). */
export function countryOfOperator(operator: string): string {
  return operator.slice(operator.lastIndexOf('_') + 1);
}

/**
 * A phone number in the MSISDN form pawaPay wants: digits only, with the
 * country calling code. A local Congolese number keeps its leading 0
 * (`06 123 45 67` → `242061234567`), as the networks number them that way.
 */
export function toMsisdn(phone: string, country: string): string {
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  const dial = DIAL_CODES[country];
  if (!dial || digits.startsWith(dial)) return digits;
  return `${dial}${digits}`;
}

/** Whole francs as a string: XAF has no decimals, and pawaPay rejects them. */
function toAmount(amount: number): string {
  return String(Math.round(amount));
}

/**
 * The payer, as pawaPay metadata: visible in its dashboard, statements and
 * callbacks, never to the customer. Fields that identify a person carry
 * `isPII` so pawaPay can handle them under data-protection rules.
 */
export function buildDepositMetadata(
  params: InitiatePaymentParams,
  msisdn: string,
): MetadataItem[] {
  const fields: Array<[string, string | null | undefined, boolean]> = [
    ['paymentRequestId', params.externalId, false],
    ['requestType', params.requestType, false],
    ['profileId', params.payer?.profileId, false],
    ['profileType', params.payer?.profileType, false],
    ['payerName', params.payer?.name, true],
    ['payerPhone', msisdn, true],
    ['payerEmail', params.payer?.email, true],
    ['operator', params.operator, false],
  ];
  return fields
    .filter(([, value]) => typeof value === 'string' && value.trim() !== '')
    .slice(0, MAX_METADATA_FIELDS)
    .map(([name, value, pii]) =>
      pii ? { [name]: value!.trim(), isPII: true } : { [name]: value!.trim() },
    );
}

/**
 * The narration on the payer's receipt. pawaPay accepts 4–22 letters, digits
 * and spaces only, so accents and punctuation are stripped.
 */
export function customerMessageFor(requestType?: string | null): string {
  const raw = CUSTOMER_MESSAGES[requestType ?? ''] ?? 'Rabotka paiement';
  const clean = raw
    .normalize('NFD')
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .slice(0, 22)
    .trim();
  return clean.length >= 4 ? clean : 'Rabotka';
}

type PawapayResponse = { status: number; body: Record<string, unknown> | null };

/** A JSON field as text: strings and numbers only, anything else is the fallback. */
function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : fallback;
}

/** The amount and currency pawaPay says were collected (`"1500.00"` → 1500). */
function settledAmount(data: Record<string, unknown>): {
  amount?: number;
  currency?: string;
} {
  const amount = Number(data['amount']);
  return {
    ...(Number.isFinite(amount) ? { amount } : {}),
    ...(typeof data['currency'] === 'string'
      ? { currency: data['currency'] }
      : {}),
  };
}

/**
 * pawaPay Merchant API.
 *
 * Deposits, payouts and their status checks go through the v2 API; wallet
 * balances are only offered on v1. Every call is a bearer-token request to
 * the same host.
 *
 * Never trusts a callback body: the webhook only names the deposit, and its
 * status is read back from the API (the signature is checked before that, by
 * `PawapaySignatureVerifier`, at the HTTP layer).
 */
@Injectable()
export class PawapayPaymentGateway implements IPaymentGateway {
  private readonly logger = new Logger(PawapayPaymentGateway.name);
  private countries: { value: GatewayCountry[]; at: number } | null = null;

  readonly metadata = PAWAPAY_METADATA;

  constructor(private readonly configService: ConfigService) {}

  private get baseUrl(): string {
    return this.configService
      .get<string>('PAWAPAY_BASE_URL', '')
      .replace(/\/+$/, '');
  }

  private get apiToken(): string {
    return this.configService.get<string>('PAWAPAY_API_TOKEN', '');
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<PawapayResponse> {
    const response = await fetchWithTimeout(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  }

  // ── Deposits ───────────────────────────────────────────────────────────

  async initiatePayment(
    params: InitiatePaymentParams,
  ): Promise<InitiatePaymentResult> {
    const operator = params.operator ?? '';
    if (!PAWAPAY_METADATA.operators.some((o) => o.code === operator)) {
      throw new BadRequestException('Opérateur non pris en charge.');
    }
    const msisdn = toMsisdn(params.phone, countryOfOperator(operator));
    const depositId = randomUUID();

    const body = {
      depositId,
      amount: toAmount(params.amount),
      currency: params.currency,
      payer: {
        type: 'MMO',
        accountDetails: { phoneNumber: msisdn, provider: operator },
      },
      clientReferenceId: params.externalId,
      customerMessage: customerMessageFor(params.requestType),
      metadata: buildDepositMetadata(params, msisdn),
    };

    let res: PawapayResponse;
    try {
      res = await this.call('POST', '/v2/deposits', body);
    } catch (err) {
      // The request may have reached pawaPay. Not knowing is not failing:
      // the status check settles it.
      this.logger.warn(
        `pawaPay deposit ${depositId}: no response, left pending — ${err instanceof Error ? err.message : String(err)}`,
      );
      return { gatewayRef: depositId, status: 'PENDING' };
    }

    if (res.status >= 500) {
      this.logger.warn(
        `pawaPay deposit ${depositId}: HTTP ${res.status}, outcome unknown, left pending`,
      );
      return { gatewayRef: depositId, status: 'PENDING' };
    }

    const status = res.body?.['status'];
    if (status === 'ACCEPTED' || status === 'DUPLICATE_IGNORED') {
      this.logger.log(`pawaPay deposit initiated: depositId=${depositId}`);
      return { gatewayRef: depositId, status: 'INITIATED' };
    }

    const code = this.failureCode(res.body);
    throw new BadRequestException(
      REJECTION_MESSAGES[code] ??
        `Paiement refusé par l'opérateur (${code || `HTTP ${res.status}`}).`,
    );
  }

  async checkPaymentStatus(gatewayRef: string): Promise<PaymentStatusResult> {
    try {
      const res = await this.call(
        'GET',
        `/v2/deposits/${encodeURIComponent(gatewayRef)}`,
      );
      if (res.status !== 200 || !res.body) {
        return { gatewayRef, status: 'PENDING' };
      }
      // Only NOT_FOUND means pawaPay never took the deposit.
      if (res.body['status'] === 'NOT_FOUND') {
        return { gatewayRef, status: 'FAILED', failureReason: 'NOT_FOUND' };
      }
      const data = (res.body['data'] ?? {}) as Record<string, unknown>;
      switch (data['status']) {
        case 'COMPLETED':
          return {
            gatewayRef,
            status: 'COMPLETED',
            transactionId: data['providerTransactionId'] as string | undefined,
            paidAt: new Date(),
            ...settledAmount(data),
          };
        case 'FAILED':
          return {
            gatewayRef,
            status: 'FAILED',
            failureReason: this.failureCode(data) || undefined,
          };
        default:
          // ACCEPTED, PROCESSING, IN_RECONCILIATION: not final yet.
          return { gatewayRef, status: 'PENDING' };
      }
    } catch (err) {
      this.logger.warn(`pawaPay deposit status error for ${gatewayRef}`, err);
      return { gatewayRef, status: 'PENDING' };
    }
  }

  async handleWebhookPayload(payload: unknown): Promise<WebhookHandleResult> {
    const body = (payload ?? {}) as Record<string, unknown>;
    const gatewayRef = body['depositId'];
    if (typeof gatewayRef !== 'string' || !gatewayRef) {
      return { gatewayRef: '', status: 'PENDING', rawPayload: payload };
    }
    // The callback only tells us which deposit moved; its status is read back
    // from the API rather than taken from the body.
    const verified = await this.checkPaymentStatus(gatewayRef);
    return {
      gatewayRef,
      status: verified.status,
      transactionId: verified.transactionId,
      amount: verified.amount,
      currency: verified.currency,
      rawPayload: payload,
    };
  }

  // ── Payouts ────────────────────────────────────────────────────────────

  async initiatePayout(params: InitiatePayoutParams): Promise<PayoutResult> {
    if (!PAWAPAY_METADATA.operators.some((o) => o.code === params.operator)) {
      throw new BadRequestException('Opérateur non pris en charge.');
    }
    const payoutId = randomUUID();
    const body = {
      payoutId,
      amount: toAmount(params.amount),
      currency: params.currency,
      recipient: {
        type: 'MMO',
        accountDetails: {
          phoneNumber: toMsisdn(
            params.phone,
            countryOfOperator(params.operator),
          ),
          provider: params.operator,
        },
      },
      clientReferenceId: params.externalId,
      customerMessage: customerMessageFor(null),
      metadata: [{ reference: params.externalId }],
    };

    let res: PawapayResponse;
    try {
      res = await this.call('POST', '/v2/payouts', body);
    } catch (err) {
      this.logger.warn(
        `pawaPay payout ${payoutId}: no response, left pending — ${err instanceof Error ? err.message : String(err)}`,
      );
      return { gatewayRef: payoutId, status: 'PENDING' };
    }
    if (res.status >= 500) {
      return { gatewayRef: payoutId, status: 'PENDING' };
    }
    const status = res.body?.['status'];
    if (status === 'ACCEPTED' || status === 'DUPLICATE_IGNORED') {
      return { gatewayRef: payoutId, status: 'INITIATED' };
    }
    const code = this.failureCode(res.body);
    throw new BadRequestException(
      REJECTION_MESSAGES[code] ??
        `Transfert refusé par l'opérateur (${code || `HTTP ${res.status}`}).`,
    );
  }

  async checkPayoutStatus(gatewayRef: string): Promise<PayoutStatusResult> {
    try {
      const res = await this.call(
        'GET',
        `/v2/payouts/${encodeURIComponent(gatewayRef)}`,
      );
      if (res.status !== 200 || !res.body) {
        return { gatewayRef, status: 'PENDING' };
      }
      if (res.body['status'] === 'NOT_FOUND') {
        return { gatewayRef, status: 'FAILED', failureReason: 'NOT_FOUND' };
      }
      const data = (res.body['data'] ?? {}) as Record<string, unknown>;
      if (data['status'] === 'COMPLETED') {
        return {
          gatewayRef,
          status: 'COMPLETED',
          transactionId: data['providerTransactionId'] as string | undefined,
        };
      }
      if (data['status'] === 'FAILED') {
        return {
          gatewayRef,
          status: 'FAILED',
          failureReason: this.failureCode(data) || undefined,
        };
      }
      return { gatewayRef, status: 'PENDING' };
    } catch (err) {
      this.logger.warn(`pawaPay payout status error for ${gatewayRef}`, err);
      return { gatewayRef, status: 'PENDING' };
    }
  }

  // ── Balances ───────────────────────────────────────────────────────────

  /** Balances are only on pawaPay's v1 API. */
  async getBalances(country: string): Promise<GatewayBalance[]> {
    const res = await this.call(
      'GET',
      `/v1/wallet-balances/${encodeURIComponent(country)}`,
    );
    if (res.status !== 200 || !res.body) {
      throw new Error(`pawaPay balances failed: HTTP ${res.status}`);
    }
    const balances = (res.body['balances'] ?? []) as Array<
      Record<string, unknown>
    >;
    return balances.map((b) => {
      const operator = text(b['mno']);
      return {
        country: text(b['country'], country),
        currency: text(b['currency']),
        balance: text(b['balance'], '0'),
        ...(operator ? { operator } : {}),
      };
    });
  }

  /** The countries the account is configured for, from its active configuration. */
  async listBalanceCountries(): Promise<GatewayCountry[]> {
    if (this.countries && Date.now() - this.countries.at < COUNTRIES_TTL_MS) {
      return this.countries.value;
    }
    const res = await this.call('GET', '/v2/active-conf');
    if (res.status !== 200 || !res.body) {
      throw new Error(
        `pawaPay active configuration failed: HTTP ${res.status}`,
      );
    }
    const countries = (res.body['countries'] ?? []) as Array<
      Record<string, unknown>
    >;
    const value = countries
      .map((c) => {
        const code = text(c['country']);
        const names = (c['displayName'] ?? {}) as Record<string, string>;
        return { code, name: names['fr'] || names['en'] || code };
      })
      .filter((c) => /^[A-Z]{3}$/.test(c.code));
    this.countries = { value, at: Date.now() };
    return value;
  }

  private failureCode(body: Record<string, unknown> | null): string {
    const reason = (body?.['failureReason'] ?? {}) as Record<string, unknown>;
    const code = reason['failureCode'] ?? body?.['failureCode'];
    return typeof code === 'string' ? code : '';
  }
}
