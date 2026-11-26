import {
  coverImageUrl,
  ctaReply,
} from '../../../common/constants/whatsapp-carousel';

/** Where the welcome card sends people: the role-aware app home. */
const WELCOME_PATH = 'home';

/** Where the unregistered card sends people: there is no account to open yet. */
const ONBOARDING_PATH = 'onboarding';

/**
 * Where a text fallback points, since it has no button to carry the one-tap
 * link. The path goes in as a `?redirect=` target rather than onto the path:
 * the app's entry point is the login screen, which then forwards.
 */
const appUrlFor = (path: string): string =>
  `https://rabotka.work/login?redirect=/${path.replace(/^\/+/u, '')}`;

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
/**
 * THE HEADER IMAGE, AND WHY IT IS A LINK.
 *
 * Verified against Graph on a live send, because two rounds of guessing had
 * already cost a production regression:
 *
 *   header.image = { link }  ->  200, delivered
 *   header.image = { id }    ->  400, 131008 "header image must contain link"
 *
 * A `cta_url` header REQUIRES a link. It does not take an uploaded media id,
 * however reasonable that looks next to templates, whose header media really is
 * uploaded once at approval. Sending an id here fails every time.
 *
 * That is worth knowing because a link is the fragile option and the instinct
 * to replace it is a good one. The bucket is `*.r2.dev`, Cloudflare's
 * development endpoint, which is rate-limited and not meant for production
 * traffic — when Meta cannot fetch it the send comes back 131053. That is a
 * transient failure of the HOST, not of the shape of the message, and the fix
 * for it is a real domain in front of the bucket, not a different payload.
 *
 * Until then `CloudProvider` retries the card without its image on any refusal,
 * so a bucket hiccup costs the picture rather than falling through to the
 * approved MARKETING template, which is billed.
 */
/**
 * VoVa's screens, as the card names them: a title, a line, a button. The
 * welcome card said « La première marketplace d'emploi… » under every reply,
 * whatever VoVa had just offered to open — « Je vous ouvre *Candidatures
 * reçues* », then the brand card. Keyed by the path suffix of
 * `rag/agent/destination.ts`.
 */
const SCREENS: Record<string, { title: string; line: string; button: string }> =
  {
    jobs: {
      title: 'Missions disponibles',
      line: 'Les offres ouvertes, près de chez vous et dans vos domaines.',
      button: 'Voir les missions',
    },
    'recherche-offres': {
      title: 'Rechercher une offre',
      line: 'Par domaine, par ville, par type de contrat.',
      button: 'Rechercher',
    },
    'mes-candidatures': {
      title: 'Mes candidatures',
      line: 'Chacune avec son statut et la suite à donner.',
      button: 'Mes candidatures',
    },
    'penalites/paiement': {
      title: 'Mes pénalités',
      line: 'Le détail, et le paiement en quelques instants.',
      button: 'Voir mes pénalités',
    },
    portefeuille: {
      title: 'Mon portefeuille',
      line: 'Votre solde, vos mouvements et la recharge.',
      button: 'Mon portefeuille',
    },
    'profile/portfolio': {
      title: 'Mes réalisations',
      line: 'Les photos de votre travail, sur votre profil.',
      button: 'Mes réalisations',
    },
    profile: {
      title: 'Mon profil',
      line: 'Vos informations, vos domaines et votre vérification.',
      button: 'Voir mon profil',
    },
    'claims/new': {
      title: 'Nouvelle réclamation',
      line: 'Expliquez le problème, l’équipe vous répond ici.',
      button: 'Réclamation',
    },
    candidatures: {
      title: 'Candidatures reçues',
      line: 'Les candidatures à vos offres, avec leur statut.',
      button: 'Voir candidatures',
    },
    'profils-contactes': {
      title: 'Profils contactés',
      line: 'Les personnes dont vous avez le contact.',
      button: 'Voir les profils',
    },
    recherche: {
      title: 'Trouver des profils',
      line: 'Les travailleurs vérifiés, par métier et par ville.',
      button: 'Chercher un profil',
    },
    'job-offers/new': {
      title: 'Publier une mission',
      line: 'Décrivez le besoin, les candidatures arrivent ici.',
      button: 'Publier une mission',
    },
    missions: {
      title: 'Mes missions',
      line: 'Vos offres publiées, en cours et terminées.',
      button: 'Voir mes missions',
    },
    dashboard: {
      title: 'Mon espace',
      line: 'Vos offres, vos candidatures et vos messages.',
      button: 'Ouvrir mon espace',
    },
  };

/** The card under a VoVa reply: the screen it named, not the brand card. */
export function screenCardMessage(destination: string): string {
  const screen = SCREENS[destination.replace(/^\/+/u, '')];
  if (!screen) return welcomePlatformMessage(destination);
  const body = `*${screen.title}*\n${screen.line}`;
  return ctaReply({
    body,
    buttonText: screen.button,
    path: destination,
    fallbackText: `${body}\n\n${appUrlFor(destination)}`,
  });
}

export function welcomePlatformMessage(
  destination: string = WELCOME_PATH,
): string {
  const body = [
    '*Rabotka*',
    'La première marketplace d’emploi sur WhatsApp en Afrique.',
    'Offres, candidatures et missions : tout se passe dans l’application.',
  ].join('\n');

  return ctaReply({
    body,
    buttonText: 'Ouvrir l’application',
    // A path, not a URL: the outbound worker mints the one-tap `/s/<code>`
    // link on the way out.
    path: destination,
    imageUrl: coverImageUrl(),
    // TEXT, NOT A TEMPLATE — see the note above this function. There is no
    // billed way out of this card any more.
    fallbackText: `${body}\n\n${appUrlFor(destination)}`,
  });
}

/**
 * The line that goes before the signup card when a stranger types « start »
 * or « menu » — usually what an ad or a shared link told them to send. The
 * card alone answered them like a machine; this says hello first. The greeting
 * word comes from the caller (the time in Brazzaville), since « Bonjour » at
 * 21h is the slip users already corrected once.
 */
export function welcomeUnregisteredIntro(greeting: string): string {
  return `${greeting} 👋 Pour commencer sur Rabotka, il vous faut un compte : c’est juste ici.`;
}

/**
 * The signup card's words. « Ce numéro n’est pas encore enregistré » read like
 * a system notice; this says what Rabotka is for and what to do next.
 */
const UNREGISTERED_CARD_BODY = [
  '*Bienvenue sur Rabotka* 👋',
  'Des missions près de chez vous, et des gens de confiance pour les faire.',
  'Votre numéro n’a pas encore de compte : créez-le en quelques étapes.',
];

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
    body: UNREGISTERED_CARD_BODY.join('\n'),
    buttonText: 'Créer mon compte',
    path: ONBOARDING_PATH,
    imageUrl: coverImageUrl(),
    fallbackText: [
      ...UNREGISTERED_CARD_BODY,
      '',
      appUrlFor(ONBOARDING_PATH),
    ].join('\n'),
  });
}
