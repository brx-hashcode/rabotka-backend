import {
  coverImageUrl,
  ctaReply,
  templateReply,
} from '../../../common/constants/whatsapp-carousel';
import { WHATSAPP_TEMPLATES } from '../../../common/constants/whatsapp-templates';

/** Where the welcome card sends people: the role-aware app home. */
const WELCOME_PATH = 'home';

/** Where the unregistered card sends people: there is no account to open yet. */
const ONBOARDING_PATH = 'onboarding';

const APP_URL = 'https://rabotka.work/login?redirect=/home';

/**
 * Both cards are sent FREE-FORM rather than as their approved templates.
 *
 * They are the only two replies the bot gives that were billed. Both are
 * MARKETING, and Meta charges MARKETING wherever it lands — the WABA's own
 * 90-day figures carry a `MARKETING / REGULAR` line and no
 * `MARKETING / FREE_CUSTOMER_SERVICE` one, while UTILITY appears under both.
 * Since a card is only ever a REPLY, it is always inside the 24h service
 * window, where a free-form message costs nothing.
 *
 * They were templates for one reason, recorded on `openApp`: a bare link does
 * not open WhatsApp's in-app browser, only a button does. `cta_url` is that
 * button without the template.
 *
 * The bodies below are Meta's stored copy, character for character, so the
 * reader sees no change. Each reply carries its template as the fallback the
 * outbound worker uses if the window has shut by the time the job drains.
 */

/**
 * The one answer the bot gives a registered user for anything they type.
 *
 * The in-chat menu is gone: offers, applications and missions all live in the
 * app, so every message gets the same doorway back to it.
 *
 * EVERY path that sends this card must come through here. `vova.service` had
 * its own `card()` calling `templateReply('welcomePlatform', …)` directly, so
 * the assistant's replies kept going out as the MARKETING template — billed —
 * while the rest of the bot had moved to the free-form version. Exactly the
 * failure `welcomeUnregisteredMessage` below already records, one card later.
 *
 * @param destination where the button lands. Defaults to the app home; the
 *   assistant passes the place the person actually asked about, so the card
 *   opens there instead of making them navigate again.
 */
export function welcomePlatformMessage(
  destination: string = WELCOME_PATH,
): string {
  const { variables } = WHATSAPP_TEMPLATES.welcomePlatform;

  return ctaReply({
    body: [
      '*Rabotka*',
      'La première marketplace d’emploi sur WhatsApp en Afrique.',
      'Offres, candidatures et missions : tout se passe dans l’application.',
    ].join('\n'),
    buttonText: 'Ouvrir l’application',
    // A path, not a URL: the outbound worker mints the one-tap `/s/<code>`
    // link, exactly as it does for the template's button.
    path: destination,
    imageUrl: coverImageUrl(),
    fallbackTemplate: 'welcomePlatform',
    fallbackVariables: variables(destination),
  });
}

/**
 * The template path, kept whole for a rollback.
 *
 * Point `welcomePlatformMessage` at this to put the approved card back: same
 * words, same button, billed again. Its own free-form branch below is the
 * older, buttonless fallback for a blank `TPL_WELCOME_PLATFORM`.
 */
export function welcomePlatformTemplateMessage(): string {
  const { contentSid, variables } = WHATSAPP_TEMPLATES.welcomePlatform;

  if (contentSid) {
    return templateReply('welcomePlatform', variables(WELCOME_PATH));
  }

  // Kept word-for-word in step with the card's title, so a rollback to the
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
 * No login code rides along, unlike its sibling: there is no profile to mint
 * one against, so the outbound worker sends the bare onboarding path.
 */
export function welcomeUnregisteredMessage(): string {
  return ctaReply({
    body: [
      '*Bienvenue sur Rabotka*',
      'L’endroit où compétences et opportunités se rencontrent.',
      'Ce numéro n’est pas encore enregistré.',
    ].join('\n'),
    buttonText: 'Créer mon compte',
    path: ONBOARDING_PATH,
    imageUrl: coverImageUrl(),
    fallbackTemplate: 'welcomeUnregisteredCard',
  });
}

/**
 * The template path for the unregistered card, kept for a rollback.
 *
 * Point `welcomeUnregisteredMessage` here to send the approved card again.
 * Rolling back further — to the text-only template that predated the card —
 * means pointing `TPL_WELCOME_UNREGISTERED_V2` at
 * `HX1610d675f58d8fa92d277383584cc5fb`.
 *
 * No free-form branch, unlike its sibling: `sid()` returns its approved default
 * whenever the env override is blank, so `contentSid` is never empty and a
 * guard here would be dead code that reads like a live choice.
 */
export function welcomeUnregisteredTemplateMessage(): string {
  const card = WHATSAPP_TEMPLATES.welcomeUnregisteredCard;
  return templateReply('welcomeUnregisteredCard', card.variables());
}
