import type { BotProfile, BotState } from '../types/bot-state.types';
import type { PaymentRequestType } from '@prisma/client';
import type { IPaymentUrlService } from '../types/payment-url.types';
import {
  paymentUseRegisteredNumberPrompt,
  paymentEnterPhonePrompt,
  paymentChooseOperatorPrompt,
  paymentPendingMessage,
  paymentDirectFailedMessage,
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
  options?: { contactUnlockAttemptId?: string; recommendationWorkerId?: string };
}): Record<string, unknown> {
  return {
    _mm_step: 'use_registered_number',
    _mm_amount: params.amount,
    _mm_description: params.description,
    _mm_requestType: params.requestType,
    _mm_options: params.options ?? {},
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
      // Use registered phone → go to choose operator
      const nextState = withMmPayload(state, {
        _mm_step: 'choose_operator',
        _mm_phone: profile.phone,
      });
      return {
        reply: [paymentChooseOperatorPrompt()],
        nextState,
      };
    }

    if (trimmed === '2') {
      // Enter a different phone number
      const nextState = withMmPayload(state, { _mm_step: 'enter_phone' });
      return { reply: [paymentEnterPhonePrompt()], nextState };
    }

    if (trimmed === '3') {
      // Fallback: send payment link
      const url = await ctx.getFallbackUrl();
      return { reply: [url], clearState: true };
    }

    // Show prompt (initial entry or invalid input)
    return {
      reply: [paymentUseRegisteredNumberPrompt(profile.phone)],
      nextState: state,
    };
  }

  if (mmStep === 'enter_phone') {
    const phone = trimmed.replace(/\s+/g, '');
    if (!/^\d{8,15}$/.test(phone)) {
      return {
        reply: [
          `⚠️ Numéro invalide. Entrez un numéro avec l'indicatif pays, ex: *242XXXXXXXX*`,
        ],
        nextState: state,
      };
    }
    const nextState = withMmPayload(state, {
      _mm_step: 'choose_operator',
      _mm_phone: phone,
    });
    return { reply: [paymentChooseOperatorPrompt()], nextState };
  }

  if (mmStep === 'choose_operator') {
    const mmPhone = payload._mm_phone as string;
    let operator: string | null = null;

    if (trimmed === '1') operator = 'MTN';
    else if (trimmed === '2') operator = 'AIRTEL';

    if (!operator) {
      return {
        reply: ['*Tapez 1 pour MTN Mobile Money ou 2 pour Airtel Money.*'],
        nextState: state,
      };
    }

    // Strip country prefix (+242) to match what the gateway expects
    const gatewayPhone = mmPhone.replace(/^\+?242/, '');

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
      return {
        reply: [paymentDirectFailedMessage(fallbackUrl)],
        clearState: true,
      };
    }

    return {
      reply: [
        paymentPendingMessage(amount, OPERATOR_LABELS[operator], gatewayPhone),
      ],
      clearState: true,
    };
  }

  // Unexpected state — reset
  return {
    reply: [paymentUseRegisteredNumberPrompt(profile.phone)],
    nextState: withMmPayload(state, { _mm_step: 'use_registered_number' }),
  };
}
