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
  };
}
