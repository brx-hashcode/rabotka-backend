import { REDIS_KEY_PREFIX } from '../../common/services/redis/redis.constants';

export const BOT_STATE_KEY_PREFIX = `${REDIS_KEY_PREFIX}bot:state:`;

export const BOT_STATE_TTL_SECONDS = 86400;

// Shorter TTLs for flows that should expire if abandoned mid-conversation.
// Flows not listed here fall back to BOT_STATE_TTL_SECONDS (24h).
export const FLOW_TTL_SECONDS: Partial<Record<string, number>> = {
  accept_refuse_candidate: 2 * 3600,
  verify_whatsapp: 10 * 60, // 10 min — OTP-like, short window
  rate_assignment: 2 * 3600,
  pay_penalties: 3600, // 1 h — holds payment intent
};

export const FLOW_IDS = {
  ACCEPT_REFUSE_CANDIDATE: 'accept_refuse_candidate',
  PAY_PENALTIES: 'pay_penalties',
  /** Holds the numbered penalty list while the user picks which to settle.
   *  Distinct from PAY_PENALTIES, which is the payment flow that follows. */
  PENALTY_GATE: 'penalty_gate',
  RATE_ASSIGNMENT: 'rate_assignment',
  VERIFY_WHATSAPP: 'verify_whatsapp',
} as const;

/**
 * Words that mean "get me out of here". There is no menu any more — inside a
 * live flow these exit it, and the orchestrator answers with the welcome card.
 *
 * `start` is the documented entry point. It belongs HERE rather than being
 * handled on its own, because until now it only worked by accident: unrecognised
 * input falls through to the welcome card, so `start` did nothing while a user
 * was mid-flow — which is precisely when someone types it. Someone stuck in the
 * penalty-payment flow had it parsed as a payment option and stayed stuck.
 * Listing it here gives it the escape behaviour every flow already honours.
 *
 * `démarrer`/`commencer` are here because a French-speaking user is at least as
 * likely to type those, and the cost is two array entries.
 */
export const CMD_MENU = [
  'menu',
  'aide',
  'help',
  'bonjour',
  '*',
  'start',
  'démarrer',
  'demarrer',
  'commencer',
  // `expandSlashCommand` already rewrites a bare "/" to "menu" at the
  // conversation entry point, so this is belt and braces — it keeps the slash
  // working for any caller that matches CMD_MENU against raw input rather than
  // the expanded text.
  '/',
];
/**
 * "Stop sending me announcements."
 *
 * The opt-out every marketing message is required to honour, and the one this
 * codebase had no way to express until broadcasts existed — a user who wanted
 * out could only block the number, which costs the WhatsApp quality rating far
 * more than an unsubscribe does.
 *
 * Narrow by design: it silences announcements and job suggestions, never
 * anything about something the person did. Someone who stops the marketing
 * still hears that their candidature was accepted.
 *
 * English spellings included — "stop" is what the WhatsApp footer trains people
 * to send, whatever language the message was in.
 */
export const CMD_STOP = ['stop', 'stopper', 'arreter', 'arrêter', 'unsubscribe'];

/**
 * The other direction, so an opt-out is not a one-way door.
 *
 * Deliberately does NOT contain « start ». The router checks this list before
 * anything else, so listing it there hijacked the product's documented front
 * door: `/start` expands to `start`, matched here, and every user who typed it
 * was answered « C’est réactivé » instead of getting the card that opens the
 * app — whether or not they had ever opted out of anything.
 *
 * Nothing points people at « start » to come back, either: the opt-out reply
 * itself says « Répondez *Reprendre* », which is the word that belongs here.
 */
export const CMD_RESUME = ['reprendre', 'resume', 'continuer'];

export const CMD_PAY = [
  'payer',
  'régler',
  'regler',
  'payer pénalités',
  'payer penalites',
];

/**
 * "I want an account" — the one command an unregistered number can act on.
 *
 * Only reachable from the anonymous path: a registered user typing « compte »
 * keeps whatever the bot already answers them. `expandSlashCommand` rewrites
 * `/compte` to `compte` at the entry point, so only the bare words are listed,
 * accented and unaccented like `CMD_PAY` — phone keyboards differ.
 *
 * Matched EXACTLY, never by prefix. Prefix matching is what swallowed the
 * landing page's own CTA (« Bonjour Rabotka, je cherche… ») and sent the menu
 * card to the first message a new user ever writes.
 */
/**
 * The words that get a card straight away, with no model in the path.
 *
 * A deliberately smaller set than `CMD_MENU`, and used by BOTH gates — the
 * orchestrator's for registered users, and the anonymous branch in
 * `ConversationService`. `CMD_MENU` mixes two kinds of word: navigation
 * commands, and things people actually say.
 *
 * « bonjour », « aide » and « help » are the second kind, and answering them
 * with a card was wrong for either audience. Someone writing « bonjour » is
 * opening a conversation; a card is the reply you give when you have nothing to
 * say, and we have plenty — the assistant can introduce itself and ask what
 * they need.
 *
 * What stays here is the vocabulary that means "show me the thing": *menu*,
 * *start*, *démarrer*. Those are documented entry points, printed in templates,
 * and they must not depend on a model provider being up.
 *
 * NOTE this is not `CMD_MENU`, which still drives account activation in the
 * orchestrator — a KYC-verified user typing « bonjour » must still activate.
 * That path runs before either gate and is deliberately untouched.
 *
 * Nothing is lost when the assistant is off or over budget: both callers fall
 * back to their usual card.
 */
export const CMD_NAVIGATION = [
  'menu',
  '*',
  'start',
  'démarrer',
  'demarrer',
  'commencer',
  // `expandSlashCommand` rewrites a bare "/" to "menu" before this is reached;
  // kept for any caller matching against raw input.
  '/',
];

export const CMD_ACCOUNT = [
  'compte',
  'inscription',
  "s'inscrire",
  's inscrire',
  'sinscrire',
  'creer un compte',
  'créer un compte',
  'creer compte',
  'créer compte',
  'je veux un compte',
  'signup',
  'sign up',
  'register',
];

/**
 * Reach a human.
 *
 * Answered for EVERY account state, unlike the rest of the vocabulary. The
 * suspension and KYC-rejection templates tell people to type it, and those
 * people are by definition not ACTIVE — a command that only worked for
 * healthy accounts would be useless to exactly the audience it names.
 *
 * `expandSlashCommand` already rewrites "/support" to "support", so only the
 * bare words are listed. The accented and unaccented spellings both appear for
 * the same reason they do in CMD_PAY: phone keyboards differ.
 */
export const CMD_SUPPORT = [
  'support',
  'aide',
  'assistance',
  'contact',
  'réclamation',
  'reclamation',
];

/**
 * Base URL for links the bot puts in a message.
 *
 * Must match `FRONTEND_URL`, because that is what
 * `WhatsAppOutboundProcessor.withLoginLinks` matches on when it rewrites a
 * first-party link into a one-tap `/s/<code>`. A hardcoded production URL looks
 * right and silently loses that rewrite in every other environment.
 */
export const APP_BASE_URL = (
  process.env.FRONTEND_URL ?? 'https://rabotka.work'
).replace(/\/+$/, '');
