import { emailButton, escapeHtml, type MailLanguage } from './layout';

/**
 * Business subscription messages. By email (and in-app), never WhatsApp;
 * sent with the layout's « Business » label, signed by Rabotka Business.
 */

const SIGN_OFF = `
    <p>
      Merci de votre confiance,<br />
      <strong>L'équipe Rabotka Business</strong>
    </p>`;

const SIGN_OFF_EN = `
    <p>
      Thank you for your trust,<br />
      <strong>The Rabotka Business team</strong>
    </p>`;

function frDate(date: Date): string {
  return date.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Africa/Brazzaville',
  });
}

function enDate(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Africa/Brazzaville',
  });
}

export function businessTrialStartedEmail(
  name: string,
  p: {
    businessName: string;
    planName: string;
    endsAt: Date;
    url: string;
    /** The reader's language; French unless said. */
    language?: MailLanguage;
  },
): string {
  if (p.language === 'en') {
    return `
    <p>Hello ${escapeHtml(name)},</p>

    <p>
      <strong>${escapeHtml(p.businessName)}</strong> is verified: your free
      trial of the <strong>${escapeHtml(p.planName)}</strong> plan starts
      today, until <strong>${enDate(p.endsAt)}</strong>.
    </p>

    <p>
      Publish your jobs and start hiring right away. You can choose your plan
      at any time from your workspace, in the “Subscription” section.
    </p>

    ${emailButton(p.url, 'Discover my subscription')}
    ${SIGN_OFF_EN}
  `;
  }
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
    /** The reader's language; French unless said. */
    language?: MailLanguage;
  },
): string {
  const later = p.startsAt.getTime() > Date.now() + 60_000;
  if (p.language === 'en') {
    return `
    <p>Hello ${escapeHtml(name)},</p>

    <p>
      Your payment is confirmed: your <strong>${escapeHtml(p.planName)}</strong>
      subscription (${escapeHtml(p.periodLabel)})
      ${
        later
          ? `will take over on <strong>${enDate(p.startsAt)}</strong>, when the current period ends,`
          : 'is active'
      }
      until <strong>${enDate(p.endsAt)}</strong>.
    </p>

    <p>Your invoice is sent to you in a separate email.</p>

    ${emailButton(p.url, 'View my subscription')}
    ${SIGN_OFF_EN}
  `;
  }
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

export function businessCreditsAddedEmail(
  name: string,
  p: {
    what: string;
    expiresAt: Date;
    url: string;
    /** The reader's language; French unless said. */
    language?: MailLanguage;
  },
): string {
  if (p.language === 'en') {
    return `
    <p>Hello ${escapeHtml(name)},</p>

    <p>
      Your payment is confirmed: your pack is added, that is
      <strong>${escapeHtml(p.what)}</strong> on top of your plan, to be used
      until <strong>${enDate(p.expiresAt)}</strong>.
    </p>

    <p>
      They are used once those of your plan are exhausted for the period. Your
      invoice is sent to you in a separate email.
    </p>

    ${emailButton(p.url, 'View my subscription')}
    ${SIGN_OFF_EN}
  `;
  }
  return `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>
      Votre paiement est confirmé : votre pack est ajouté, soit
      <strong>${escapeHtml(p.what)}</strong> en plus de votre formule, à
      utiliser jusqu'au <strong>${frDate(p.expiresAt)}</strong>.
    </p>

    <p>
      Ils servent une fois ceux de votre formule épuisés pour la période.
      Votre facture vous est envoyée dans un e-mail séparé.
    </p>

    ${emailButton(p.url, 'Voir mon abonnement')}
    ${SIGN_OFF}
  `;
}

export function businessSubscriptionExpiringEmail(
  name: string,
  p: {
    planName: string;
    endsAt: Date;
    trial: boolean;
    url: string;
    /** The reader's language; French unless said. */
    language?: MailLanguage;
  },
): string {
  if (p.language === 'en') {
    return `
    <p>Hello ${escapeHtml(name)},</p>

    <p>
      ${p.trial ? 'Your free trial' : `Your <strong>${escapeHtml(p.planName)}</strong> subscription`}
      ends on <strong>${enDate(p.endsAt)}</strong>.
    </p>

    <p>
      ${p.trial ? 'Choose a plan' : 'Renew it'} to keep your jobs online, your
      included contacts and your benefits. An early renewal is added to the
      current period: you do not lose a single day.
    </p>

    ${emailButton(p.url, p.trial ? 'Choose my plan' : 'Renew')}
    ${SIGN_OFF_EN}
  `;
  }
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
  p: {
    planName: string;
    trial: boolean;
    url: string;
    withdrawn?: boolean;
    /** The reader's language; French unless said. */
    language?: MailLanguage;
  },
): string {
  if (p.language === 'en') {
    return `
    <p>Hello ${escapeHtml(name)},</p>

    <p>
      ${p.trial ? 'Your free trial' : `Your <strong>${escapeHtml(p.planName)}</strong> subscription`}
      has ended${p.withdrawn ? ': this plan is no longer offered' : ''}.
    </p>

    <p>
      Your published jobs stay visible, but you can no longer publish new
      ones, and every contact becomes paid.
      Choose a plan to get your benefits back.
    </p>

    ${emailButton(p.url, 'Choose my plan')}
    ${SIGN_OFF_EN}
  `;
  }
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
    /** The reader's language; French unless said. */
    language?: MailLanguage;
  },
): string {
  const later = p.startsAt.getTime() > Date.now() + 60_000;
  if (p.language === 'en') {
    return `
    <p>Hello ${escapeHtml(name)},</p>

    <p>
      The Rabotka team has given you the
      <strong>${escapeHtml(p.planName)}</strong> plan (${escapeHtml(p.periodLabel)}),
      free of charge. It
      ${
        later
          ? `will take over on <strong>${enDate(p.startsAt)}</strong>, when the current period ends,`
          : 'is active right now'
      }
      until <strong>${enDate(p.endsAt)}</strong>.
    </p>

    <p>Its included contacts and its benefits are open to you for the whole period.</p>

    ${emailButton(p.url, 'View my subscription')}
    ${SIGN_OFF_EN}
  `;
  }
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
  p: {
    planName: string;
    reason: string | null;
    url: string;
    /** The reader's language; French unless said. */
    language?: MailLanguage;
  },
): string {
  const reason = p.reason?.trim();
  if (p.language === 'en') {
    return `
    <p>Hello ${escapeHtml(name)},</p>

    <p>
      Your <strong>${escapeHtml(p.planName)}</strong> subscription has been
      stopped by the Rabotka team.
    </p>

    ${reason ? `<p><strong>Reason:</strong> ${escapeHtml(reason)}</p>` : ''}

    <p>
      Your published jobs stay visible, but you can no longer publish new
      ones, and every contact becomes paid. Choose a plan to get your benefits
      back, or reply to this email with any question.
    </p>

    ${emailButton(p.url, 'Choose a plan')}
    ${SIGN_OFF_EN}
  `;
  }
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

/** The subjects of the subscription emails, in the reader's language. */
export const businessSubscriptionSubject = {
  trialStarted: (language: MailLanguage = 'fr') =>
    language === 'en'
      ? 'Your free Rabotka Business trial starts'
      : 'Votre essai gratuit Rabotka Business commence',
  active: (planName: string, language: MailLanguage = 'fr') =>
    language === 'en'
      ? `Your ${planName} subscription is confirmed`
      : `Votre abonnement ${planName} est confirmé`,
  creditsAdded: (what: string, language: MailLanguage = 'fr') =>
    language === 'en' ? `Pack added: ${what}` : `Pack ajouté : ${what}`,
  granted: (planName: string, language: MailLanguage = 'fr') =>
    language === 'en'
      ? `The ${planName} plan has been given to you`
      : `La formule ${planName} vous a été attribuée`,
  cancelled: (planName: string, language: MailLanguage = 'fr') =>
    language === 'en'
      ? `Your ${planName} subscription has been stopped`
      : `Votre abonnement ${planName} a été arrêté`,
  ended: (language: MailLanguage = 'fr') =>
    language === 'en'
      ? 'Your Rabotka Business subscription has ended'
      : 'Votre abonnement Rabotka Business est terminé',
  trialEnded: (language: MailLanguage = 'fr') =>
    language === 'en'
      ? 'Your Rabotka Business trial has ended'
      : 'Votre essai Rabotka Business est terminé',
  trialExpiring: (language: MailLanguage = 'fr') =>
    language === 'en'
      ? 'Your Rabotka Business trial ends soon'
      : 'Votre essai Rabotka Business se termine bientôt',
  expiring: (language: MailLanguage = 'fr') =>
    language === 'en'
      ? 'Your Rabotka Business subscription is about to expire'
      : 'Votre abonnement Rabotka Business arrive à échéance',
};
