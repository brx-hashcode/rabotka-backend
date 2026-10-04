import { escapeHtml } from './layout';

const fcfa = (amount: number) => `${amount.toLocaleString('fr-FR')} FCFA`;

/** Sent when an admin has sent an agent's withdrawal by Mobile Money. */
export function agentWithdrawalPaidEmail(params: {
  firstName: string;
  amount: number;
  momoPhone: string;
  reference: string;
}): string {
  return `
    <p>Bonjour ${escapeHtml(params.firstName)},</p>

    <p>
      Votre retrait de <strong>${escapeHtml(fcfa(params.amount))}</strong> a
      été envoyé par Mobile Money au ${escapeHtml(params.momoPhone)}.
    </p>

    <p>Référence de la transaction : <strong>${escapeHtml(params.reference)}</strong></p>

    <p>
      Si vous ne recevez pas l'argent dans les prochaines heures, contactez
      l'équipe Rabotka en indiquant cette référence.
    </p>

    <p>
      Merci,<br />
      <strong>L'équipe Rabotka</strong>
    </p>
  `;
}

/** Sent when an admin refuses an agent's withdrawal; the money is back. */
export function agentWithdrawalRejectedEmail(params: {
  firstName: string;
  amount: number;
  reason: string;
}): string {
  return `
    <p>Bonjour ${escapeHtml(params.firstName)},</p>

    <p>
      Votre demande de retrait de
      <strong>${escapeHtml(fcfa(params.amount))}</strong> n'a pas été acceptée.
    </p>

    <p>Motif : ${escapeHtml(params.reason)}</p>

    <p>
      Le montant est de nouveau disponible dans votre solde : vous pouvez faire
      une nouvelle demande depuis l'application agent.
    </p>

    <p>
      Cordialement,<br />
      <strong>L'équipe Rabotka</strong>
    </p>
  `;
}
