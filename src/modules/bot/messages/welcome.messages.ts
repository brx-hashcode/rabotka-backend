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

  // Kept word-for-word in step with the v3 card's title, so a rollback to the
  // free-form branch doesn't quietly change what the bot says.
  return [
    `[IMG:${coverImageUrl()}]*Rabotka*`,
    'La première marketplace d’emploi sur WhatsApp en Afrique.',
    '',
    'Offres, candidatures et missions : tout se passe dans l’application.',
    '',
    APP_URL,
  ].join('\n');
}

/**
 * Sent to a number with no profile. Same card, different button — there is no
 * account to open yet, so it points at onboarding.
 *
 * Every path that answers an unregistered number must come through here. Two of
 * them used to pass the old text-only SID straight to `templateReply`, so the
 * card was built, approved and registered while nothing ever sent it — the
 * registry was right and the call sites were wrong.
 *
 * No fallback branch: `sid()` returns its approved default whenever the env
 * override is blank, so `contentSid` is never empty and a guard here would be
 * dead code that reads like a live choice. Rolling back means pointing
 * `TPL_WELCOME_UNREGISTERED_V2` at the previous text template,
 * `HX1610d675f58d8fa92d277383584cc5fb`.
 */
export function welcomeUnregisteredMessage(): string {
  const card = WHATSAPP_TEMPLATES.welcomeUnregisteredCard;
  return templateReply(card.contentSid, card.variables());
}
