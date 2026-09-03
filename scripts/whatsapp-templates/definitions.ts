/**
 * Templates authored HERE rather than translated from Twilio.
 *
 * `twilio-source.ts` + `translate.ts` recreated the original 27 in Rabotka's
 * own WABA, and that was the right shape while Twilio held the copy. It is not
 * the shape for anything new: the account is moving to Cloud, and a template
 * that never existed in Twilio has nothing to translate from. Worse, two of
 * these carry a FLOW button — Twilio Content has no such action, so the
 * translation path could not express them even if the SIDs existed.
 *
 * So the payload is the source of truth. `author.ts` writes these into
 * `out/payloads/` alongside the generated ones, and `create.ts` submits either
 * kind without caring which produced it.
 *
 * Keep `name` in step with the registry's `cloud.name`: that string is what a
 * send resolves to, and a mismatch surfaces as `132001 Template name does not
 * exist` on the first real send rather than at build time.
 */
import type { MetaTemplatePayload } from './translate';
import type { WhatsAppTemplateName } from '../../src/common/constants/whatsapp-templates';

/**
 * Which registry keys this file owns.
 *
 * Separate from `authoredTemplates()` and free of any environment lookup, so a
 * caller can ask "is this one still translated from Twilio?" without needing a
 * Flow id — the Twilio-fixture tests do exactly that.
 */
export const AUTHORED_KEYS: ReadonlySet<WhatsAppTemplateName> = new Set([
  'contactUnlocked',
  'contactUnlockedRecommendation',
  'kycRejected',
  'accountSuspended',
  'adminMessage',
  // v4 is authored here and lives on Meta only; its Twilio fixture is the v3
  // card with the numbered menu, which the app no longer sends.
  'kycPendingMenu',
  'openApp',
  'claimCommented',
]);

/**
 * The published feedback Flow, by id.
 *
 * A FLOW button binds its flow at CREATION time, not at send time — the send
 * carries only the token. The Flow must already be PUBLISHED; Meta rejects a
 * template pointing at a draft.
 */
function feedbackFlowId(): string {
  const id = process.env.WHATSAPP_FEEDBACK_FLOW_ID?.trim();
  if (!id) {
    throw new Error(
      'WHATSAPP_FEEDBACK_FLOW_ID is not set — the unlock templates bind the ' +
        'feedback Flow to their button at creation time, so it cannot be ' +
        'submitted without one.',
    );
  }
  return id;
}

/**
 * « Laisser un avis », opening the feedback Flow in-chat.
 *
 * On a template rather than as a free-form interactive message, which is the
 * entire reason it exists: `sendFeedbackFlow` is rejected outside WhatsApp's
 * 24h service window (131047), and the people these two templates reach are
 * the ones who paid on the web without ever messaging the bot.
 */
function feedbackFlowButton() {
  return {
    type: 'FLOW' as const,
    text: 'Laisser un avis',
    flow_id: feedbackFlowId(),
    navigate_screen: 'FEEDBACK',
    flow_action: 'navigate' as const,
  };
}

/**
 * The templates this repo owns outright.
 *
 * Bodies are deliberately emoji-free. The previous versions opened on 🎉 and
 * bulleted the contact with 📞 / ✉️; Rabotka's other surfaces do not decorate,
 * and a paid reveal reads as more credible undecorated — the message is a
 * receipt, not a celebration.
 *
 * A function, not a const: module bodies are evaluated before the importer's
 * own statements, so a top-level object would read `WHATSAPP_FEEDBACK_FLOW_ID`
 * before `author.ts` had loaded the .env files, and throw on every run.
 */
export function authoredTemplates(): Partial<
  Record<WhatsAppTemplateName, MetaTemplatePayload>
> {
  return {
    contactUnlocked: {
      name: 'rabotka_contact_unlocked_mutual_v6',
      language: 'fr',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: [
            '*Contact débloqué*',
            '',
            'Les deux parties ont réglé leur part. Voici les coordonnées de *{{1}}* :',
            '',
            'Téléphone : {{2}}',
            'Email : {{3}}',
            '',
            'Un premier message pour vous présenter et confirmer votre présence, et tout est prêt.',
            '',
            'Toute l’équipe Rabotka vous souhaite une excellente collaboration.',
          ].join('\n'),
          example: {
            body_text: [
              ['Marie Lore', '+242 06 000 0000', 'marie.lore@example.com'],
            ],
          },
        },
        { type: 'BUTTONS', buttons: [feedbackFlowButton()] },
      ],
    },

    contactUnlockedRecommendation: {
      name: 'rabotka_contact_unlocked_reco_v5',
      language: 'fr',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: [
            '*Contact débloqué*',
            '',
            'Votre paiement est confirmé. Voici comment joindre *{{1}}* :',
            '',
            'Téléphone : {{2}}',
            'Email : {{3}}',
            '',
            'Présentez-lui votre mission dès maintenant — les profils les plus demandés répondent vite.',
            '',
            'Toute l’équipe Rabotka vous souhaite une excellente collaboration.',
          ].join('\n'),
          example: {
            body_text: [
              ['Sara Electricienne', '+242 06 000 0103', 'sara@example.com'],
            ],
          },
        },
        { type: 'BUTTONS', buttons: [feedbackFlowButton()] },
      ],
    },

    /**
     * The two negative outcomes, which until now reached the user by email
     * alone — on a platform where WhatsApp is the channel people actually read.
     *
     * Both carry the admin's reason as {{2}}. That is the whole point of them:
     * "your account was suspended" with no motive tells someone nothing they
     * can act on, and support then fields the question by hand.
     *
     * Neither has a button. A rejected profile is not ACTIVE and a suspended
     * one is refused a session outright, so no link here can be followed —
     * see `kycPendingMenu` in the registry for what a dead CTA costs.
     */
    /**
     * v2 of both. v1 was approved, sent once, and was wrong on two counts.
     *
     * The KYC body invited people to "renvoyer des documents dans cette
     * conversation" — the bot has no document-intake flow, so it promised an
     * action that goes nowhere. A rejected decision is contested through a
     * CLAIM (`/claims/new`), which is what it now says.
     *
     * The suspension body said "vous ne pouvez plus accéder à la plateforme",
     * which stopped being true the moment we chose a read-only session: a
     * suspended user CAN sign in and read, they simply cannot act. Telling
     * them otherwise turns a recoverable state into a dead end.
     *
     * Both now carry a CTA into the app. v1 had none, on the reasoning that a
     * login code is never minted for these profiles — true then, no longer:
     * `MINTABLE_STATUSES` accepts SUSPENDED and the consume side agrees, so
     * the button lands them signed in on the page that helps.
     *
     * New names rather than an edit. Meta re-reviews an edited body and this
     * repo's tooling only creates, so a version is both the honest record and
     * the cheaper path.
     */
    kycRejected: {
      name: 'rabotka_kyc_rejected_v2',
      language: 'fr',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: [
            'Bonjour {{1}},',
            '',
            'Après examen de votre dossier, votre vérification d’identité (KYC) n’a pas pu être validée.',
            '',
            'Motif : {{2}}',
            '',
            'Si vous estimez que cette décision est incorrecte, vous pouvez ouvrir une réclamation depuis l’application — notre équipe réexaminera votre dossier.',
            '',
            'L’équipe Rabotka',
          ].join('\n'),
          example: {
            body_text: [
              ['Jean', 'La photo de la pièce d’identité est illisible'],
            ],
          },
        },
        {
          type: 'BUTTONS',
          buttons: [
            {
              type: 'URL',
              text: 'Ouvrir une réclamation',
              // The variable ends the URL, which is what WhatsApp requires, and
              // the outbound processor swaps it for a one-tap login code.
              url: 'https://rabotka.work/s/{{1}}',
              example: ['https://rabotka.work/s/claims-new'],
            },
          ],
        },
      ],
    },

    /**
     * v4 of the KYC-pending card, replacing `rabotka_kyc_pending_menu_v3`.
     *
     * v3 is not merely dated, it is wrong: its body offers « 1- Mon profil /
     * 2- Créer une réclamation » and asks the reader to « répondre avec le
     * numéro de votre choix ». The numbered menu was removed from the bot —
     * `BotRouterService` answers `unknown` for everything when no flow is live
     * — so a « 1 » comes back to the same card. The message invites an action
     * that loops.
     *
     * v4 says one thing and offers one button. Nothing to type, nothing to
     * choose, and the button lands on the profile — the only screen that is
     * useful while a dossier is under review, since that is where the
     * documents were submitted and where a correction is made.
     *
     * A new name rather than an edit: Meta re-reviews an edited body anyway,
     * and this repo's tooling only creates. `kyc_pending_menu_v3` should be
     * deleted from the WABA only AFTER this one is approved and deployed — a
     * deleted template cannot be sent, and until the new build ships, v3 is
     * what these users receive.
     */
    kycPendingMenu: {
      name: 'rabotka_kyc_pending_v4',
      language: 'fr',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: [
            'Bonjour {{1}},',
            '',
            'Votre vérification d’identité est en cours d’examen par notre équipe.',
            '',
            'Vous recevrez un message dès qu’elle est terminée. En attendant, vous pouvez consulter votre profil et compléter vos informations.',
            '',
            'L’équipe Rabotka',
          ].join('\n'),
          example: { body_text: [['Jean']] },
        },
        {
          type: 'BUTTONS',
          buttons: [
            {
              type: 'URL',
              text: 'Voir mon profil',
              // The variable ends the URL, as WhatsApp requires; the outbound
              // processor swaps it for a one-tap login code.
              url: 'https://rabotka.work/s/{{1}}',
              example: ['https://rabotka.work/s/profile'],
            },
          ],
        },
      ],
    },

    /**
     * The door for an account with no menu, and nothing more.
     *
     * Says nothing about WHY the account is walled — not the suspension, not
     * the review, not the refusal. That is the assistant's job now, and it has
     * the status and the admin's own words; a card repeating them would say it
     * worse and drift the day the wording changes.
     *
     * It exists because a bare link does not open WhatsApp's in-app browser —
     * only a template's CTA button does. Without that constraint this would be
     * free-form text: the bot answers inside the 24h service window.
     */
    /**
     * v2, and the version bump is about Meta's CATEGORY, not the wording.
     *
     * v1 was declared UTILITY and Meta approved it as MARKETING. That is not
     * cosmetic: a MARKETING template can be dropped by a user's marketing
     * opt-out, and this card is the ONLY door an account behind a wall has.
     * Silencing it recreates the exact failure this whole change set exists to
     * fix.
     *
     * The cause was structural rather than accidental. What made v1 generic —
     * saying nothing about the account's state — is what made it read as an
     * invitation. Meta calls a message UTILITY when it follows up on a request
     * the customer made or reports on their account; a standalone « open the
     * app » is a promotion.
     *
     * So v2 keeps the state out of the copy and anchors it on the one thing
     * that is always true when this card is sent: the person has just written
     * in. That makes it a service reply, which is what it actually is — the
     * bot only sends it in response to an inbound message, inside the 24h
     * window.
     */
    openApp: {
      name: 'rabotka_open_app_v2',
      language: 'fr',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: [
            'Bonjour {{1}},',
            '',
            'Suite à votre message, voici l’accès à votre espace Rabotka. Vous pouvez y consulter l’état de votre compte et vos informations.',
            '',
            'L’équipe Rabotka',
          ].join('\n'),
          example: { body_text: [['Jean']] },
        },
        {
          type: 'BUTTONS',
          buttons: [
            {
              type: 'URL',
              // « Voir mon compte » rather than « Ouvrir l'application »: it
              // names what the button reports on, which is the half that reads
              // as utility. An app-opening invitation is what got v1 filed as
              // marketing.
              text: 'Voir mon compte',
              // The variable ends the URL, as WhatsApp requires; the outbound
              // processor swaps it for a one-tap login code.
              url: 'https://rabotka.work/s/{{1}}',
              example: ['https://rabotka.work/s/home'],
            },
          ],
        },
      ],
    },

    /**
     * An admin answered a claim.
     *
     * UTILITY, and it held on the first submission. What earns that is the
     * STATIC text: Meta's classifier cannot see what a variable will hold at
     * send time, so it judges the frame, and this frame names both the event
     * and the specific claim it belongs to — a follow-up to something the user
     * filed themselves.
     *
     * Contrast `adminMessage`, whose body is essentially just {{1}}. With no
     * transactional anchor left in the static text once the sender's name went
     * away, it reads as a broadcast and Meta reclassified it MARKETING twice.
     * The lesson is not "sign it" — it is "anchor it in the static text".
     *
     * So this one signs as the team, per Rabotka answering as one team, and
     * pays no category cost for it.
     */
    claimCommented: {
      name: 'rabotka_claim_comment_v1',
      language: 'fr',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: [
            'Bonjour {{1}},',
            '',
            'Notre équipe a répondu à votre réclamation « {{2}} ».',
            '',
            'Réponse : {{3}}',
            '',
            'Vous pouvez consulter la réclamation.',
            '',
            'L’équipe Rabotka',
          ].join('\n'),
          example: {
            body_text: [
              [
                'Jean',
                'Paiement non reçu',
                'Nous avons vérifié la transaction et lancé le remboursement.',
              ],
            ],
          },
        },
        {
          type: 'BUTTONS',
          buttons: [
            {
              type: 'URL',
              text: 'Voir ma réclamation',
              // The variable ends the URL, as WhatsApp requires. The CALLER
              // mints the code here — `sendTemplateMessage` bypasses the
              // outbound queue, so `withLoginCode` never runs for this one.
              url: 'https://rabotka.work/s/{{1}}',
              example: ['https://rabotka.work/s/claims'],
            },
          ],
        },
      ],
    },

    accountSuspended: {
      name: 'rabotka_account_suspended_v2',
      language: 'fr',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: [
            'Bonjour {{1}},',
            '',
            'Votre compte Rabotka a été suspendu.',
            '',
            'Motif : {{2}}',
            '',
            'Vous pouvez toujours consulter votre compte, mais vous ne pouvez ni postuler, ni publier d’offre, ni contacter un profil tant qu’il n’est pas rétabli.',
            '',
            'Tapez */support* pour joindre notre équipe.',
            '',
            'L’équipe Rabotka',
          ].join('\n'),
          example: {
            body_text: [['Jean', 'Trois pénalités impayées']],
          },
        },
        {
          type: 'BUTTONS',
          buttons: [
            {
              type: 'URL',
              text: 'Ouvrir Rabotka',
              url: 'https://rabotka.work/s/{{1}}',
              example: ['https://rabotka.work/s/home'],
            },
          ],
        },
      ],
    },

    /**
     * v4: no sender name, and anchored as account support.
     *
     * v2's closing line was `_{{2}} — L’équipe Rabotka_`, so every message an
     * admin sent was signed with that admin's own name. Rabotka answers as one
     * team, and a variable may never be empty — there was no value of `{{2}}`
     * that rendered as the team alone, which is why this needed a new version
     * rather than a code change.
     *
     * Submitted as MARKETING because that is what Meta assigns it, not because
     * it is one. Asking for UTILITY only earns a silent reclassification —
     * `welcomePlatform` v3 sat pending for hours over exactly that, and v4 was
     * approved in minutes once it asked for the category Meta wanted.
     *
     * Three submissions pinned the cause, so do not spend a fourth on
     * rephrasing: v2 (signed with the admin's own name) is UTILITY to this day;
     * v3 (name removed) came back MARKETING; v4 (name removed, plus this
     * opening line naming the sender and the subject) came back MARKETING too.
     * The individual's name is what made Meta read this as 1:1 correspondence
     * rather than a broadcast, and the team decided a nameless message is worth
     * the marketing rate and the opt-out exposure.
     *
     * The opening line stays regardless: it says who is writing and about what,
     * and its static text widens the variable-density margin v1 was rejected on
     * (subCode 2388293). It is deliberately not "réponse à votre demande":
     * plenty of these are proactive — a KYC chaser, a penalty notice — and the
     * template must not claim the user asked first.
     *
     * Must stay byte-identical to `formatAdminMessage`, which renders the same
     * shape on the free-form path — the two modes are meant to be
     * indistinguishable to the reader.
     */
    adminMessage: {
      name: 'rabotka_admin_message_v4',
      language: 'fr',
      category: 'MARKETING',
      components: [
        {
          type: 'BODY',
          text: [
            '*Rabotka*',
            '',
            'Message de notre équipe support concernant votre compte :',
            '',
            '{{1}}',
            '',
            'Merci et à bientôt,',
            '_L’équipe Rabotka_',
          ].join('\n'),
          example: {
            body_text: [['Votre compte est actif.']],
          },
        },
      ],
    },
  };
}
