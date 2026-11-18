import { escapeHtml } from './layout';

export function kycRejectedEmail(name: string, reason?: string): string {
  const reasonBlock = reason
    ? `<p><strong>Motif :</strong> ${escapeHtml(reason)}</p>`
    : '';

  return `
    <p>Bonjour ${escapeHtml(name)},</p>

    <p>
      Après examen de votre dossier, nous avons le regret de vous informer que votre
      vérification d'identité a été <strong>rejetée</strong>.
    </p>

    ${reasonBlock}

    <p>
      Corrigez ce qui est indiqué ci-dessus et envoyez de nouveaux documents
      depuis l'application, rubrique <strong>Profil › Vérification d'identité</strong>.
      Votre dossier sera réexaminé dès réception.
    </p>

    <p>
      Merci de votre compréhension,<br />
      <strong>L'équipe Rabotka</strong>
    </p>
  `;
}
