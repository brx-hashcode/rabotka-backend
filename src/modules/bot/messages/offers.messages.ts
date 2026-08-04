import { APP_TIMEZONE } from '../utils/parse-date-time';

export type OfferListItem = {
  id: string;
  reference?: string;
  title: string;
  description: string;
  scheduled_at: Date;
  amount: number | null;
  payment_flow: string | null;
  address: string;
  note: string | null;
  quantity?: number;
  acceptedCount?: number;
  status: string;
  employerScore?: number | null;
};

export function formatPaymentFlow(flow: string | null): string {
  if (!flow) return '';
  const map: Record<string, string> = {
    HOURLY: 'par heure',
    DAILY: 'par jour',
    MONTHLY: 'par mois',
  };
  return map[flow] ?? flow;
}

export function formatAmount(
  amount: number | null,
  flow: string | null,
): string {
  if (amount == null || amount === 0) return 'A négocier';
  const flowLabel = formatPaymentFlow(flow);
  const flowSuffix = flowLabel ? ` ${flowLabel}` : '';
  return `${amount.toLocaleString('fr-FR')} FCFA${flowSuffix}`;
}

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: APP_TIMEZONE,
  });
}

function employerScoreStars(score: number): string {
  if (score >= 90) return '⭐⭐⭐';
  if (score >= 75) return '⭐⭐';
  if (score >= 60) return '⭐';
  return '⚠️';
}

function formatEmployerScore(score: number | null | undefined): string {
  if (score == null) return '';
  return `*Fiabilité employeur*: ${employerScoreStars(score)} (${score}/100)`;
}

export function jobOfferToOfferListItem(offer: {
  id: string;
  reference?: string;
  title: string;
  description: string;
  scheduled_at: Date;
  amount: number | null;
  payment_flow: string | null;
  address: string;
  note: string | null;
  quantity: number;
  acceptedCount?: number;
  status: string;
  employer?: { reliability_score?: number | null } | null;
}): OfferListItem {
  return {
    id: offer.id,
    reference: offer.reference,
    title: offer.title,
    description: offer.description,
    scheduled_at: offer.scheduled_at,
    amount: offer.amount,
    payment_flow: offer.payment_flow,
    address: offer.address,
    note: offer.note,
    quantity: offer.quantity,
    acceptedCount: offer.acceptedCount ?? 0,
    status: offer.status,
    employerScore: offer.employer?.reliability_score ?? null,
  };
}
