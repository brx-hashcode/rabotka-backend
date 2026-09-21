import { Injectable } from '@nestjs/common';
import type { BotState, BotProfile } from '../types/bot-state.types';
import { CMD_PAY, CMD_RESUME, CMD_STOP } from '../bot.constants';
import { stripChatFormattingChars } from '../utils/chat-input';

export type RouteResult =
  | { type: 'flow'; flowId: string; state: BotState }
  | { type: 'command'; commandId: string }
  | { type: 'unknown' };

/**
 * Routes an inbound message.
 *
 * The bot no longer offers an in-chat menu: typing "Menu", "1" or "publier"
 * used to open a flow, and all of those now live in the app. What survives is
 * the ability to *finish* a conversation already under way — a user halfway
 * through paying a penalty must not be dropped — so a message is only handed to
 * a flow when one is already active. Everything else is `unknown`, which the
 * orchestrator answers with the welcome card.
 *
 * Template buttons keep working: their payloads arrive while the matching flow
 * holds state, and are routed by the same branch.
 */
@Injectable()
export class BotRouterService {
  route(
    input: string,
    _profile: BotProfile,
    state: BotState | null,
  ): RouteResult {
    const trimmed = stripChatFormattingChars(input.trim());
    const normalized = trimmed.toLowerCase();

    // « payer », which older messages told people to type, always answers
    // with the button into the app — with or without an open flow.
    if (CMD_PAY.includes(normalized)) {
      return { type: 'command', commandId: 'pay_penalties' };
    }

    // Before the flow branch, deliberately: someone who writes STOP means it,
    // and making them finish a half-open payment flow first would be the
    // product arguing with a person who asked to be left alone.
    if (CMD_STOP.includes(normalized)) {
      return { type: 'command', commandId: 'marketing_opt_out' };
    }
    if (CMD_RESUME.includes(normalized)) {
      return { type: 'command', commandId: 'marketing_opt_in' };
    }

    if (state?.flowId) {
      return { type: 'flow', flowId: state.flowId, state };
    }

    return { type: 'unknown' };
  }
}
