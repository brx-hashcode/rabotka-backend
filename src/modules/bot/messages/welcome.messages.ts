import {
  coverImageUrl,
  templateReply,
} from '../../../common/constants/whatsapp-carousel';
import { WHATSAPP_TEMPLATES } from '../../../common/constants/whatsapp-templates';

/** Where the welcome card sends people: the role-aware app home. */
const WELCOME_PATH = 'home';

const APP_URL = 'https://rabotka.work/login?redirect=/home';

/**
 * The one answer the bot gives a registered user for anything they type.
 *
 * The in-chat menu is gone: offers, applications and missions all live in the
 * app, so every message gets the same doorway back to it.
 *
 * Falls back to a free-form image + text when no card SID is configured (e.g.
 * rolled back through TPL_WELCOME_PLATFORM=''). That fallback is legal here precisely
 * because the user just wrote to us — we are inside the 24h session window, the
 * only place free-form sends are allowed. It loses the tappable button, not the
 * message.
 */
export function welcomePlatformMessage(): string {
  const { contentSid, variables } = WHATSAPP_TEMPLATES.welcomePlatform;

  if (contentSid) {
    return templateReply(contentSid, variables(WELCOME_PATH));
  }

  return [
    `[IMG:${coverImageUrl()}]*Bienvenue sur Rabotka*`,
    'L’endroit où compétences et opportunités se rencontrent.',
    '',
    'Offres, candidatures et missions : tout se passe dans l’application.',
    '',
    APP_URL,
  ].join('\n');
}

/**
 * Sent to a number with no profile. Same card, different button — there is no
 * account to open yet, so it points at onboarding.
 */
export function welcomeUnregisteredMessage(): string {
  const card = WHATSAPP_TEMPLATES.welcomeUnregisteredCard;

  if (card.contentSid) {
    return templateReply(card.contentSid, card.variables());
  }

  // The previously approved text-only template, until the card is live.
  return templateReply(WHATSAPP_TEMPLATES.welcomeUnregistered.contentSid);
}
