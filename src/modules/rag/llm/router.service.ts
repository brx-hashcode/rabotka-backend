import { Injectable } from '@nestjs/common';
import type { LlmTier } from './llm.types';
import { foldText } from '../shared/text';

export interface RouteInput {
  /** The user's message, as received. */
  text: string;
  /** Whether the turn may call tools. */
  hasTools: boolean;
  /** Prior turns in this conversation. */
  historyLength: number;
}

/**
 * Greetings and pleasantries, unaccented and lowercased before matching —
 * a phone keyboard drops accents, and `CMD_MENU` in the bot already assumes it.
 */
const GREETINGS = [
  'bonjour',
  'bonsoir',
  'salut',
  'bjr',
  'hello',
  'hi',
  'hey',
  'coucou',
  'mbote',
  'merci',
  'ok',
  'daccord',
  'au revoir',
  'bonne journee',
  'bonne soiree',
  'ca va',
];

/** Longest input still plausibly a greeting rather than a question. */
const SHORT_INPUT_CHARS = 32;

/**
 * Picks a tier. **Rules only — never an LLM call.** Spending a model call to
 * decide which model to call doubles the latency it was meant to save, and adds
 * a second thing that can fail before the user gets a word back.
 */
@Injectable()
export class LlmRouterService {
  route(input: RouteInput): LlmTier {
    // A turn that can call a tool can also reach a fee, a balance, or a
    // corpus chunk. That is never cheap-tier work.
    if (input.hasTools) return 'standard';
    if (input.historyLength > 0) return 'standard';

    const normalized = foldText(input.text);
    if (normalized.length === 0) return 'standard';
    if (normalized.length > SHORT_INPUT_CHARS) return 'standard';

    return GREETINGS.some(
      (g) => normalized === g || normalized.startsWith(`${g} `),
    )
      ? 'cheap'
      : 'standard';
  }
}
