import { PaymentRequestType } from '@prisma/client';

/**
 * What each notification says and where it opens — the one place the copy
 * lives. Trigger sites pass facts; this turns them into a sentence and an
 * rabotka-client path, so wording and routing can change without touching the
 * services that decide when to notify.
 *
 * Paths are rabotka-client routes (`src/app/routes/index.tsx`). They differ by
 * role: a worker's mission is `/applications/:id`, the employer's view of the
 * same application is `/candidatures/:id`.
 */

export type PaymentKind =
  'WALLET_TOP_UP' | 'PENALTY' | 'CONTACT_UNLOCK' | 'RECOMMENDATION_CONTACT';

export function paymentKindOf(
  requestType: PaymentRequestType | null | undefined,
): PaymentKind {
  switch (requestType) {
    case PaymentRequestType.WALLET_TOP_UP:
      return 'WALLET_TOP_UP';
    case PaymentRequestType.CONTACT_UNLOCK:
      return 'CONTACT_UNLOCK';
    case PaymentRequestType.RECOMMENDATION_CONTACT:
      return 'RECOMMENDATION_CONTACT';
    default:
      // Null predates the column and was always a penalty — same fallback as
      // `resolvePaymentType`.
      return 'PENALTY';
  }
}

export type ClaimStatusValue =
  'CREATED' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED';

export type NotificationInput =
  | { type: 'PROFILE_VIEW'; sector: string | null; city: string | null }
  | { type: 'JOB_RECOMMENDATION'; jobOfferId: string; jobTitle: string }
  | {
      type: 'APPLICATION_ACCEPTED';
      applicationId: string;
      jobTitle: string;
      /** A contact-unlock fee is still owed before the mission can start. */
      paymentPending: boolean;
    }
  | {
      type: 'APPLICATION_REJECTED';
      jobTitle: string | null;
      /** Closed because the offer filled or ended, not by the employer. */
      automatic: boolean;
    }
  | { type: 'HIRE_CANCELLED'; jobTitle: string }
  | {
      type: 'MISSION_RATED';
      score: number;
      jobTitle: string | null;
      rateeRole: 'WORKER' | 'EMPLOYER';
      applicationId: string | null;
      jobOfferId: string | null;
    }
  | {
      type: 'NEW_APPLICATION';
      applicationId: string;
      jobTitle: string;
      workerName: string;
    }
  | {
      type: 'APPLICATION_CANCELLED';
      jobOfferId: string;
      jobTitle: string;
      workerName: string;
    }
  | {
      type: 'MISSION_COMPLETED';
      jobOfferId: string;
      jobTitle: string;
      workerName: string;
    }
  | {
      type: 'CONTACT_UNLOCKED';
      recipientRole: 'WORKER' | 'EMPLOYER';
      applicationId: string | null;
      counterpartName: string;
      jobTitle: string | null;
    }
  | {
      type: 'PAYMENT_SUCCEEDED' | 'PAYMENT_FAILED';
      amount: number;
      kind: PaymentKind;
    }
  | { type: 'CLAIM_COMMENTED'; claimId: string; claimTitle: string }
  | {
      type: 'CLAIM_STATUS_CHANGED';
      claimId: string;
      claimTitle: string;
      status: ClaimStatusValue;
    };

export type NotificationType = NotificationInput['type'];

/** "Awa K." — enough to recognise someone the recipient already deals with. */
export function personName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  fallback: string,
): string {
  const first = firstName?.trim();
  const initial = lastName?.trim()?.charAt(0);
  if (!first) return fallback;
  return initial ? `${first} ${initial.toUpperCase()}.` : first;
}

export type RenderedNotification = {
  title: string;
  body: string;
  link: string | null;
};

function fcfa(amount: number): string {
  // Plain spaces: `toLocaleString('fr-FR')` uses U+202F, which some Android
  // WebView fonts render as a box.
  return `${Math.round(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} FCFA`;
}

function quoted(title: string | null | undefined): string {
  const t = title?.trim();
  return t ? ` « ${t} »` : '';
}

const PAYMENT_LABEL: Record<PaymentKind, string> = {
  WALLET_TOP_UP: 'la recharge de votre portefeuille',
  PENALTY: 'le règlement de votre pénalité',
  CONTACT_UNLOCK: 'le déblocage du contact',
  RECOMMENDATION_CONTACT: 'le déblocage du contact',
};

function paymentLink(kind: PaymentKind, failed: boolean): string {
  if (kind === 'PENALTY' && failed) return '/penalites/paiement';
  return '/portefeuille';
}

const CLAIM_STATUS_SENTENCE: Record<ClaimStatusValue, string> = {
  CREATED: 'a été rouverte',
  IN_PROGRESS: 'est en cours de traitement',
  COMPLETED: 'a été résolue',
  REJECTED: 'a été rejetée',
};

/**
 * The sentence a worker reads when an employer opened their profile.
 *
 * Sector and city only. Naming the employer would hand the worker the one thing
 * the paid contact unlock sells, so the copy is built from fields that describe
 * a crowd, and each part is dropped when the employer never filled it in.
 */
export function profileViewBody(
  sector: string | null,
  city: string | null,
): string {
  let who = 'Un employeur';
  if (sector) who += ` du secteur ${sector}`;
  if (city) who += ` à ${city}`;
  return `${who} a consulté votre profil.`;
}

export function renderNotification(
  input: NotificationInput,
): RenderedNotification {
  switch (input.type) {
    case 'PROFILE_VIEW':
      return {
        title: 'Votre profil a été consulté',
        body: profileViewBody(input.sector, input.city),
        link: '/profile',
      };

    case 'JOB_RECOMMENDATION':
      return {
        title: 'Une offre pour vous',
        body: `Nouvelle offre${quoted(input.jobTitle)} qui correspond à votre profil.`,
        link: `/offres/${input.jobOfferId}`,
      };

    case 'APPLICATION_ACCEPTED':
      return input.paymentPending
        ? {
            title: 'Candidature acceptée',
            body: `Votre candidature${quoted(input.jobTitle)} a été acceptée. Réglez les frais de mise en relation pour obtenir le contact.`,
            link: `/applications/${input.applicationId}/paiement`,
          }
        : {
            title: 'Candidature acceptée',
            body: `Votre candidature${quoted(input.jobTitle)} a été acceptée.`,
            link: `/applications/${input.applicationId}`,
          };

    case 'APPLICATION_REJECTED':
      return {
        title: 'Candidature non retenue',
        body: input.automatic
          ? `L’offre${quoted(input.jobTitle)} est pourvue ou fermée. Votre candidature n’a pas été retenue.`
          : `Votre candidature${quoted(input.jobTitle)} n’a pas été retenue.`,
        link: '/recherche-offres',
      };

    case 'HIRE_CANCELLED':
      return {
        title: 'Mission annulée',
        body: `L’employeur a annulé la mission${quoted(input.jobTitle)}.`,
        link: '/mes-candidatures',
      };

    case 'MISSION_RATED': {
      const link =
        input.rateeRole === 'WORKER'
          ? input.applicationId
            ? `/applications/${input.applicationId}`
            : '/mes-candidatures'
          : input.jobOfferId
            ? `/missions/${input.jobOfferId}`
            : '/missions';
      return {
        title: 'Nouvelle évaluation',
        body: `Vous avez reçu une note de ${input.score}/5${
          input.jobTitle ? ` pour${quoted(input.jobTitle)}` : ''
        }.`,
        link,
      };
    }

    case 'NEW_APPLICATION':
      return {
        title: 'Nouvelle candidature',
        body: `${input.workerName} a postulé à votre offre${quoted(input.jobTitle)}.`,
        link: `/candidatures/${input.applicationId}`,
      };

    case 'APPLICATION_CANCELLED':
      return {
        title: 'Candidature annulée',
        body: `${input.workerName} a annulé sa participation à${quoted(input.jobTitle) || ' votre offre'}.`,
        link: `/missions/${input.jobOfferId}`,
      };

    case 'MISSION_COMPLETED':
      return {
        title: 'Mission terminée',
        body: `${input.workerName} a indiqué avoir terminé la mission${quoted(input.jobTitle)}. Vous pouvez maintenant l’évaluer.`,
        link: `/missions/${input.jobOfferId}`,
      };

    case 'CONTACT_UNLOCKED':
      // Informational only: the details are delivered on WhatsApp, and the
      // in-app contacts list is hidden, so there is nowhere useful to open.
      // Worded so a name ending in an initial ("Awa K.") never doubles the
      // full stop.
      return {
        title: 'Contact débloqué',
        body: `Les coordonnées de ${input.counterpartName}${
          input.jobTitle ? ` pour${quoted(input.jobTitle)}` : ''
        } vous ont été envoyées sur WhatsApp.`,
        link: null,
      };

    case 'PAYMENT_SUCCEEDED':
      return {
        title: 'Paiement confirmé',
        body: `Votre paiement de ${fcfa(input.amount)} pour ${PAYMENT_LABEL[input.kind]} a été confirmé.`,
        link: paymentLink(input.kind, false),
      };

    case 'PAYMENT_FAILED':
      return {
        title: 'Paiement échoué',
        body: `Votre paiement de ${fcfa(input.amount)} pour ${PAYMENT_LABEL[input.kind]} n’a pas abouti. Vous pouvez réessayer.`,
        link: paymentLink(input.kind, true),
      };

    case 'CLAIM_COMMENTED':
      return {
        title: 'Réponse à votre réclamation',
        body: `Notre équipe a répondu à votre réclamation${quoted(input.claimTitle)}.`,
        link: `/claims/${input.claimId}`,
      };

    case 'CLAIM_STATUS_CHANGED':
      return {
        title: 'Réclamation mise à jour',
        body: `Votre réclamation${quoted(input.claimTitle)} ${CLAIM_STATUS_SENTENCE[input.status]}.`,
        link: `/claims/${input.claimId}`,
      };
  }
}
