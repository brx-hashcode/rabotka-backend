import { Logger } from '@nestjs/common';
import { fetchWithTimeout } from '../../../../common/utils/fetch-with-timeout.util';
import type { CloudProviderConfig } from '../../whatsapp.config';

/**
 * Business-level billing: what has been charged, what is outstanding, invoices.
 *
 * SEPARATE FROM CONSUMPTION, and the distinction is the whole reason this file
 * exists. `pricing_analytics` answers "what did we USE in this window"; it says
 * nothing about what has already been paid. Reading a 30-day consumption total
 * as an amount owed is wrong by roughly the amount already charged, which is
 * how a 15.25 AED usage figure gets compared against a 0.80 AED balance.
 *
 * ## The permission
 *
 * These edges hang off the BUSINESS, not the WABA, and they need
 * `business_management` — a scope a WhatsApp-only system user does not get by
 * default. Probing them with the messaging token returns
 * `(#200) Requires business_management permission`, which is an authorization
 * failure, NOT a missing endpoint: a deliberately invalid edge answers
 * `Unknown path components` instead, so the two are distinguishable and this
 * client distinguishes them.
 *
 * When the scope is absent, every method here returns `permissionMissing`
 * rather than throwing, so the back office can say exactly what to grant
 * instead of rendering a broken panel.
 *
 * ## What each edge is for
 *
 * `extendedcredits` and `business_invoices` are documented for businesses on a
 * CREDIT LINE / monthly invoicing. An account paying by card may legitimately
 * return an empty list from both even with the scope granted — empty is a real
 * answer here and must not be reported as an error.
 */

const REQUEST_TIMEOUT_MS = 20_000;

/** Marker in Meta's error text for the scope this client needs. */
const PERMISSION_ERROR = /requires business_management permission/i;

export interface BillingCard {
  id: string;
  displayString: string | null;
  expiryMonth: string | null;
  expiryYear: string | null;
  isDefault: boolean;
}

export interface BillingCreditLine {
  id: string;
  legalEntityName: string | null;
  /** Meta reports money as a string in minor-unit-aware form, e.g. "0.80". */
  balance: string | null;
  maxBalance: string | null;
  creditAvailable: string | null;
  currency: string | null;
}

export interface BillingInvoice {
  id: string;
  billingPeriod: string | null;
  amountDue: string | null;
  currency: string | null;
  dueDate: string | null;
  paymentStatus: string | null;
  invoiceDate: string | null;
  downloadUri: string | null;
}

export interface CloudBillingResult {
  businessId: string | null;
  /**
   * The scope the token is missing, or null when everything was readable.
   * Drives the "grant this permission" state in the UI, which is the only
   * honest thing to render when the data cannot be fetched.
   */
  permissionMissing: string | null;
  creditLines: BillingCreditLine[];
  invoices: BillingInvoice[];
  cards: BillingCard[];
}

export class CloudBillingClient {
  private readonly logger = new Logger('WhatsAppCloudBilling');

  constructor(private readonly config: CloudProviderConfig) {}

  async fetch(): Promise<CloudBillingResult> {
    const empty: CloudBillingResult = {
      businessId: null,
      permissionMissing: null,
      creditLines: [],
      invoices: [],
      cards: [],
    };

    // The business id is not configured anywhere — it is read off the WABA,
    // which the messaging token CAN see.
    const owner = await this.get(
      `${this.config.wabaId}?fields=owner_business_info`,
    );
    if (owner.permissionMissing) {
      return { ...empty, permissionMissing: owner.permissionMissing };
    }

    const businessId = readOwnerBusinessId(owner.body);
    if (!businessId) {
      this.logger.warn(
        'WABA reported no owning business — billing cannot be resolved',
      );
      return empty;
    }

    const [credits, invoices, cards] = await Promise.all([
      this.get(
        `${businessId}/extendedcredits?fields=id,legal_entity_name,balance,max_balance,credit_available,currency`,
      ),
      this.get(
        `${businessId}/business_invoices?fields=id,billing_period,amount_due,currency,due_date,payment_status,invoice_date,download_uri`,
      ),
      this.get(`${businessId}/credit_cards`),
    ]);

    // One shared verdict: these edges all gate on the same scope, so if any of
    // them reports it missing the whole panel is in the same state.
    const permissionMissing =
      credits.permissionMissing ??
      invoices.permissionMissing ??
      cards.permissionMissing ??
      null;

    return {
      businessId,
      permissionMissing,
      creditLines: readList(credits.body).map(toCreditLine),
      invoices: readList(invoices.body).map(toInvoice),
      cards: readList(cards.body).map(toCard),
    };
  }

  /**
   * A GET that reports a missing scope instead of throwing on it.
   *
   * A genuinely broken request still throws — a permissions gap is an expected
   * configuration state with a specific remedy, while a 500 from Graph is not,
   * and collapsing the two would hide real breakage behind a "grant this
   * permission" message that nobody can act on.
   */
  private async get(
    path: string,
  ): Promise<{ body: unknown; permissionMissing: string | null }> {
    const url = `https://graph.facebook.com/${this.config.apiVersion}/${path}`;

    let response: Response;
    try {
      response = await fetchWithTimeout(
        url,
        { headers: { Authorization: `Bearer ${this.config.accessToken}` } },
        REQUEST_TIMEOUT_MS,
      );
    } catch (err) {
      const detail =
        err instanceof Error && err.name === 'AbortError'
          ? `timed out after ${REQUEST_TIMEOUT_MS}ms`
          : `could not reach graph.facebook.com: ${reason(err)}`;
      this.logger.error(`[CloudBilling] ${detail}`);
      throw new Error(`WhatsApp billing ${detail}`);
    }

    const body: unknown = await response.json().catch(() => null);

    if (response.ok) return { body, permissionMissing: null };

    const message = readGraphError(body) ?? response.statusText;
    if (PERMISSION_ERROR.test(message)) {
      this.logger.warn(
        `[CloudBilling] ${path.split('?')[0]} needs business_management — ` +
          'the endpoint exists, the token does not carry the scope',
      );
      return { body: null, permissionMissing: 'business_management' };
    }

    this.logger.error(`[CloudBilling] ${response.status}: ${message}`);
    throw new Error(`WhatsApp billing request failed: ${message}`);
  }
}

function readOwnerBusinessId(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const owner = body.owner_business_info;
  if (!isRecord(owner)) return null;
  return typeof owner.id === 'string' ? owner.id : null;
}

function readList(body: unknown): Record<string, unknown>[] {
  if (!isRecord(body)) return [];
  const data = body.data;
  return Array.isArray(data) ? data.filter(isRecord) : [];
}

function toCreditLine(row: Record<string, unknown>): BillingCreditLine {
  return {
    id: str(row.id) ?? '',
    legalEntityName: str(row.legal_entity_name),
    balance: money(row.balance),
    maxBalance: money(row.max_balance),
    creditAvailable: money(row.credit_available),
    currency: str(row.currency),
  };
}

function toInvoice(row: Record<string, unknown>): BillingInvoice {
  return {
    id: str(row.id) ?? '',
    billingPeriod: str(row.billing_period),
    amountDue: money(row.amount_due),
    currency: str(row.currency),
    dueDate: str(row.due_date),
    paymentStatus: str(row.payment_status),
    invoiceDate: str(row.invoice_date),
    downloadUri: str(row.download_uri),
  };
}

function toCard(row: Record<string, unknown>): BillingCard {
  return {
    id: str(row.id) ?? '',
    displayString: str(row.display_string),
    expiryMonth: str(row.expiry_month),
    expiryYear: str(row.expiry_year),
    isDefault: row.is_default === true,
  };
}

/** Meta returns money as a string on some edges and a number on others. */
function money(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function readGraphError(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const error = body.error;
  if (!isRecord(error)) return null;
  return typeof error.message === 'string' ? error.message : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
