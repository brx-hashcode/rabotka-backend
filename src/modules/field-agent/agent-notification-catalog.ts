import { AgentNotificationType } from '@prisma/client';

/**
 * Everything the agent app's bell can say, and the facts each needs. The copy
 * is rendered here, once, when the row is written — the app shows it as is,
 * the Web Push payload carries the same strings.
 */
export type AgentNotificationInput =
  | {
      type: 'COMMISSION_EARNED';
      amount: number;
      workerName: string;
      jobTitle: string;
    }
  | {
      type: 'COMMISSION_AVAILABLE';
      amount: number;
      workerName: string;
      jobTitle: string;
    }
  | {
      type: 'COMMISSION_CANCELLED';
      amount: number;
      jobTitle: string;
      reason: string;
    }
  | { type: 'WITHDRAWAL_PAID'; amount: number; reference: string }
  | { type: 'WITHDRAWAL_REJECTED'; amount: number; reason: string }
  | {
      type:
        | 'PLACEMENT_ACCEPTED'
        | 'PLACEMENT_STARTED'
        | 'PLACEMENT_COMPLETED'
        | 'PLACEMENT_ENDED';
      workerName: string;
      jobTitle: string;
      jobId: string;
    }
  | {
      type: 'NEW_JOBS_IN_ZONE';
      count: number;
      /** The job itself when there is only one. */
      job: { id: string; title: string; city: string } | null;
      cities: string[];
    }
  | { type: 'ZONES_CHANGED'; cities: string[] }
  | { type: 'ACCOUNT_SUSPENDED'; reason: string | null }
  | { type: 'ACCOUNT_REACTIVATED' };

export type RenderedAgentNotification = {
  type: AgentNotificationType;
  title: string;
  body: string;
  link: string | null;
};

const fcfa = (n: number) =>
  `${new Intl.NumberFormat('fr-FR').format(Math.round(n)).replace(/\u202f|\u00a0/g, ' ')} FCFA`;

/** "Brazzaville", "Brazzaville et Douala", "Brazzaville, Douala et Yaoundé". */
export function listCities(cities: string[]): string {
  const unique = [...new Set(cities)];
  if (unique.length <= 1) return unique[0] ?? '';
  return `${unique.slice(0, -1).join(', ')} et ${unique[unique.length - 1]}`;
}

const WALLET = '/profile?tab=portefeuille';
const PLACEMENTS = '/profile?tab=placements';

export function renderAgentNotification(
  input: AgentNotificationInput,
): RenderedAgentNotification {
  switch (input.type) {
    case 'COMMISSION_EARNED':
      return {
        type: AgentNotificationType.COMMISSION_EARNED,
        title: `Commission de ${fcfa(input.amount)}`,
        body: `${input.workerName} est placé(e) sur « ${input.jobTitle} ». La commission sera disponible après la période de confirmation.`,
        link: WALLET,
      };
    case 'COMMISSION_AVAILABLE':
      return {
        type: AgentNotificationType.COMMISSION_AVAILABLE,
        title: `${fcfa(input.amount)} disponibles`,
        body: `La commission pour ${input.workerName} (« ${input.jobTitle} ») est disponible. Vous pouvez demander un retrait.`,
        link: WALLET,
      };
    case 'COMMISSION_CANCELLED':
      return {
        type: AgentNotificationType.COMMISSION_CANCELLED,
        title: 'Commission annulée',
        body: `La commission de ${fcfa(input.amount)} pour « ${input.jobTitle} » est annulée : ${input.reason}`,
        link: WALLET,
      };
    case 'WITHDRAWAL_PAID':
      return {
        type: AgentNotificationType.WITHDRAWAL_PAID,
        title: 'Retrait versé',
        body: `Votre retrait de ${fcfa(input.amount)} a été envoyé (réf. ${input.reference}).`,
        link: WALLET,
      };
    case 'WITHDRAWAL_REJECTED':
      return {
        type: AgentNotificationType.WITHDRAWAL_REJECTED,
        title: 'Retrait refusé',
        body: `Votre retrait de ${fcfa(input.amount)} a été refusé : ${input.reason}. Le montant est de nouveau disponible.`,
        link: WALLET,
      };
    case 'PLACEMENT_ACCEPTED':
      return {
        type: AgentNotificationType.PLACEMENT_ACCEPTED,
        title: `${input.workerName} est retenu(e)`,
        body: `L'employeur a retenu ${input.workerName} pour « ${input.jobTitle} ».`,
        link: PLACEMENTS,
      };
    case 'PLACEMENT_STARTED':
      return {
        type: AgentNotificationType.PLACEMENT_STARTED,
        title: `${input.workerName} a commencé`,
        body: `${input.workerName} a commencé la mission « ${input.jobTitle} ».`,
        link: PLACEMENTS,
      };
    case 'PLACEMENT_COMPLETED':
      return {
        type: AgentNotificationType.PLACEMENT_COMPLETED,
        title: 'Mission terminée',
        body: `${input.workerName} a terminé « ${input.jobTitle} ».`,
        link: PLACEMENTS,
      };
    case 'PLACEMENT_ENDED':
      return {
        type: AgentNotificationType.PLACEMENT_ENDED,
        title: 'Placement non abouti',
        body: `La candidature de ${input.workerName} pour « ${input.jobTitle} » a été refusée ou annulée.`,
        link: PLACEMENTS,
      };
    case 'NEW_JOBS_IN_ZONE':
      return input.job && input.count === 1
        ? {
            type: AgentNotificationType.NEW_JOBS_IN_ZONE,
            title: `Nouvelle offre à ${input.job.city}`,
            body: input.job.title,
            link: `/jobs/${input.job.id}`,
          }
        : {
            type: AgentNotificationType.NEW_JOBS_IN_ZONE,
            title: `${input.count} nouvelles offres dans vos zones`,
            body: `À ${listCities(input.cities)}. Trouvez les travailleurs à placer.`,
            link: '/',
          };
    case 'ZONES_CHANGED':
      return {
        type: AgentNotificationType.ZONES_CHANGED,
        title: 'Vos zones ont changé',
        body:
          input.cities.length > 0
            ? `Vous couvrez maintenant ${listCities(input.cities)}.`
            : "Vous n'avez plus de zone assignée.",
        link: '/profile?tab=profil',
      };
    case 'ACCOUNT_SUSPENDED':
      return {
        type: AgentNotificationType.ACCOUNT_SUSPENDED,
        title: 'Compte suspendu',
        body: input.reason
          ? `Votre compte agent est suspendu : ${input.reason}`
          : "Votre compte agent est suspendu. Contactez l'équipe Rabotka.",
        link: null,
      };
    case 'ACCOUNT_REACTIVATED':
      return {
        type: AgentNotificationType.ACCOUNT_REACTIVATED,
        title: 'Compte réactivé',
        body: 'Votre compte agent est de nouveau actif.',
        link: '/',
      };
  }
}
