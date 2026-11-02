import { emailButton, escapeHtml } from './layout';

/**
 * Business subscription messages. By email (and in-app), never WhatsApp;
 * sent with the layout's « Business » label, signed by Rabotka Business.
 */

const SIGN_OFF = `
    <p>
      Merci de votre confiance,<br />
      <strong>L'équipe Rabotka Business</strong>
    </p>`;

function frDate(date: Date): string {
  return date.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Africa/Brazzaville',
  });
}

export function businessTrialStartedEmail(
  name: string,
  p: { businessName: string; planName: string; endsAt: Date; url: string },
): string {
  return `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>
      <strong>${escapeHtml(p.businessName)}</strong> est vérifiée : votre essai
      gratuit de la formule <strong>${escapeHtml(p.planName)}</strong> commence
      aujourd'hui, jusqu'au <strong>${frDate(p.endsAt)}</strong>.
    </p>

    <p>
      Publiez vos offres et recrutez dès maintenant. Vous pourrez choisir votre
      formule à tout moment depuis votre espace, rubrique « Abonnement ».
    </p>

    ${emailButton(p.url, 'Découvrir mon abonnement')}
    ${SIGN_OFF}
  `;
}

export function businessSubscriptionActiveEmail(
  name: string,
  p: {
    planName: string;
    periodLabel: string;
    startsAt: Date;
    endsAt: Date;
    url: string;
  },
): string {
  const later = p.startsAt.getTime() > Date.now() + 60_000;
  return `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>
      Votre paiement est confirmé : votre abonnement
      <strong>${escapeHtml(p.planName)}</strong> (${escapeHtml(p.periodLabel)})
      ${
        later
          ? `prendra le relais le <strong>${frDate(p.startsAt)}</strong>, à la fin de la période en cours,`
          : 'est actif'
      }
      jusqu'au <strong>${frDate(p.endsAt)}</strong>.
    </p>

    <p>Votre facture vous est envoyée dans un e-mail séparé.</p>

    ${emailButton(p.url, 'Voir mon abonnement')}
    ${SIGN_OFF}
  `;
}

export function businessSubscriptionExpiringEmail(
  name: string,
  p: { planName: string; endsAt: Date; trial: boolean; url: string },
): string {
  return `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>
      ${p.trial ? 'Votre essai gratuit' : `Votre abonnement <strong>${escapeHtml(p.planName)}</strong>`}
      se termine le <strong>${frDate(p.endsAt)}</strong>.
    </p>

    <p>
      ${p.trial ? 'Choisissez une formule' : 'Renouvelez-le'} pour garder vos
      offres en ligne, vos contacts inclus et vos avantages. Un renouvellement
      anticipé s'ajoute à la période en cours : vous ne perdez aucun jour.
    </p>

    ${emailButton(p.url, p.trial ? 'Choisir ma formule' : 'Renouveler')}
    ${SIGN_OFF}
  `;
}

export function businessSubscriptionExpiredEmail(
  name: string,
  p: { planName: string; trial: boolean; url: string; withdrawn?: boolean },
): string {
  return `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>
      ${p.trial ? 'Votre essai gratuit' : `Votre abonnement <strong>${escapeHtml(p.planName)}</strong>`}
      est terminé${p.withdrawn ? ' : cette formule n’est plus proposée' : ''}.
    </p>

    <p>
      Vos offres publiées restent visibles, mais vous ne pouvez plus en publier
      de nouvelles, et chaque contact devient payant.
      Choisissez une formule pour retrouver vos avantages.
    </p>

    ${emailButton(p.url, 'Choisir ma formule')}
    ${SIGN_OFF}
  `;
}

/** An admin assigned a plan by hand: nothing was paid, so no invoice line. */
export function businessSubscriptionGrantedEmail(
  name: string,
  p: {
    planName: string;
    periodLabel: string;
    startsAt: Date;
    endsAt: Date;
    url: string;
  },
): string {
  const later = p.startsAt.getTime() > Date.now() + 60_000;
  return `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>
      L'équipe Rabotka vous a attribué la formule
      <strong>${escapeHtml(p.planName)}</strong> (${escapeHtml(p.periodLabel)}),
      offerte. Elle
      ${
        later
          ? `prendra le relais le <strong>${frDate(p.startsAt)}</strong>, à la fin de la période en cours,`
          : 'est active dès maintenant'
      }
      jusqu'au <strong>${frDate(p.endsAt)}</strong>.
    </p>

    <p>Ses contacts inclus et ses avantages vous sont ouverts pendant toute la période.</p>

    ${emailButton(p.url, 'Voir mon abonnement')}
    ${SIGN_OFF}
  `;
}

/** An admin ended a period (or dropped one not yet started). */
export function businessSubscriptionCancelledEmail(
  name: string,
  p: { planName: string; reason: string | null; url: string },
): string {
  const reason = p.reason?.trim();
  return `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>
      Votre abonnement <strong>${escapeHtml(p.planName)}</strong> a été arrêté
      par l'équipe Rabotka.
    </p>

    ${reason ? `<p><strong>Motif :</strong> ${escapeHtml(reason)}</p>` : ''}

    <p>
      Vos offres publiées restent visibles, mais vous ne pouvez plus en publier
      de nouvelles, et chaque contact devient payant. Choisissez une formule
      pour retrouver vos avantages, ou répondez à cet e-mail pour toute question.
    </p>

    ${emailButton(p.url, 'Choisir une formule')}
    ${SIGN_OFF}
  `;
}
