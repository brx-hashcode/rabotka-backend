import type { BotProfile, BotState } from '../types/bot-state.types';
import type { PaymentRequestType } from '@prisma/client';
import type { IPaymentUrlService } from '../types/payment-url.types';
import {
  paymentUseRegisteredNumberPrompt,
  paymentEnterPhonePrompt,
  paymentPendingMessage,
  paymentDirectFailedMessage,
  paymentOperatorUnknownMessage,
} from '../../whatsapp/templates';

type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

type MobileMoneyContext = {
  paymentService: IPaymentUrlService;
  getFallbackUrl: () => Promise<string>;
};

const OPERATOR_CODES: Record<string, string> = {
  MTN: 'CG_MTNMOBILEMONEY',
  AIRTEL: 'CG_AIRTELMONEY',
};

const OPERATOR_LABELS: Record<string, string> = {
  MTN: 'MTN Mobile Money',
  AIRTEL: 'Airtel Money',
};

/** Maps local prefix → operator key. Order matters: longest prefix first. */
const PREFIX_TO_OPERATOR: Record<string, string> = {
  '06': 'MTN',
  '05': 'AIRTEL',
  '04': 'AIRTEL',
};

/**
 * Normalize a phone number entered by the user:
 * - Strip spaces and leading +
 * - If starts with 242, keep as-is (full number)
 * - Otherwise prepend 242 (Congo country code)
 * Returns the full number without + prefix, e.g. "242061234567"
 */
function normalizePhone(raw: string): string {
  const digits = raw.replace(/\s+/g, '').replace(/^\+/, '');
  return digits.startsWith('242') ? digits : `242${digits}`;
}

/**
 * Detect operator from the local part of the phone number (after stripping 242).
 * Returns the operator key (MTN / AIRTEL) or null if unrecognized.
 */
function detectOperator(fullPhone: string): string | null {
  const local = fullPhone.replace(/^242/, '');
  for (const [prefix, operator] of Object.entries(PREFIX_TO_OPERATOR)) {
    if (local.startsWith(prefix)) return operator;
  }
  return null;
}

function withMmPayload(
  state: BotState,
  patch: Record<string, unknown>,
): BotState {
  return {
    ...state,
    payload: { ...state.payload, ...patch },
    updatedAt: new Date().toISOString(),
  };
}

export function getMobileMoneyInitialPayload(params: {
  amount: number;
  description: string;
  requestType: PaymentRequestType;
  options?: {
    contactUnlockAttemptId?: string;
    recommendationWorkerId?: string;
  };
}): Record<string, unknown> {
  return {
    _mm_step: 'use_registered_number',
    _mm_amount: params.amount,
    _mm_description: params.description,
    _mm_requestType: params.requestType,
    _mm_options: params.options ?? {},
  };
}

async function initiatePayment(
  phone: string,
  operator: string,
  amount: number,
  description: string,
  requestType: PaymentRequestType,
  options: Record<string, string>,
  profile: BotProfile,
  ctx: MobileMoneyContext,
): Promise<FlowResult> {
  const gatewayPhone = phone.replace(/^242/, '');
  const result = await ctx.paymentService.initiateDirectPayment({
    profileId: profile.id,
    amount,
    phone: gatewayPhone,
    operator: OPERATOR_CODES[operator] ?? operator,
    description,
    requestType,
    options,
  });

  if (!result.success) {
    const fallbackUrl = await ctx.getFallbackUrl();
    return { reply: [paymentDirectFailedMessage(fallbackUrl)], clearState: true };
  }

  return {
    reply: [paymentPendingMessage(amount, OPERATOR_LABELS[operator] ?? operator, gatewayPhone)],
    clearState: true,
  };
}

export async function runMobileMoneySubFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: MobileMoneyContext,
): Promise<FlowResult> {
  const trimmed = input.trim();
  const payload = state.payload ?? {};
  const mmStep = payload._mm_step as string;
  const amount = payload._mm_amount as number;
  const description = payload._mm_description as string;
  const requestType = payload._mm_requestType as PaymentRequestType;
  const options = (payload._mm_options ?? {}) as Record<string, string>;

  if (mmStep === 'use_registered_number') {
    if (trimmed === '1') {
      const phone = normalizePhone(profile.phone);
      const operator = detectOperator(phone);
      if (!operator) {
        // Registered number has unrecognized prefix — ask for a different number
        const nextState = withMmPayload(state, { _mm_step: 'enter_phone' });
        return {
          reply: [
            paymentOperatorUnknownMessage(),
            paymentEnterPhonePrompt(),
          ],
          nextState,
        };
      }
      return initiatePayment(phone, operator, amount, description, requestType, options, profile, ctx);
    }

    if (trimmed === '2') {
      const nextState = withMmPayload(state, { _mm_step: 'enter_phone' });
      return { reply: [paymentEnterPhonePrompt()], nextState };
    }

    if (trimmed === '3') {
      const url = await ctx.getFallbackUrl();
      return { reply: [url], clearState: true };
    }

    return {
      reply: [paymentUseRegisteredNumberPrompt(profile.phone)],
      nextState: state,
    };
  }

  if (mmStep === 'enter_phone') {
    const raw = trimmed.replace(/\s+/g, '');
    // Accept 8–12 local digits or full number with optional 242 prefix
    if (!/^\d{8,15}$/.test(raw.replace(/^\+?242/, ''))) {
      return {
        reply: [
          `⚠️ Numéro invalide. Entrez le numéro sans indicatif pays.\nExemple : *06XXXXXXX*`,
        ],
        nextState: state,
      };
    }
    const phone = normalizePhone(raw);
    const operator = detectOperator(phone);
    if (!operator) {
      return {
        reply: [paymentOperatorUnknownMessage()],
        nextState: state,
      };
    }
    return initiatePayment(phone, operator, amount, description, requestType, options, profile, ctx);
  }

  // Unexpected state — reset
  return {
    reply: [paymentUseRegisteredNumberPrompt(profile.phone)],
    nextState: withMmPayload(state, { _mm_step: 'use_registered_number' }),
  };
}
