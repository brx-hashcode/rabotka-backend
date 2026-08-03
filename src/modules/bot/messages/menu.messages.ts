
export type ContactInfo = {
  email: string;
  phone: string;
  address: string;
};

export function accountSuspendedBotMessage(contact: ContactInfo): string {
  return [
    '🚫 *Compte suspendu*',
    '',
    'Votre compte a été suspendu. Vous ne pouvez plus accéder aux fonctionnalités.',
    '',
    'Pour toute réclamation ou demande de réactivation, veuillez contacter notre équipe support :',
    '',
    `*Email* : ${contact.email}`,
    `*Téléphone* : ${contact.phone}`,
  ].join('\n');
}

export function hasPenaltiesBotMessage(): string {
  return [
    '⚠️ *Accès bloqué - Pénalités impayées*',
    '',
    "Vous avez des pénalités impayées. Vous ne pouvez pas accéder aux fonctionnalités tant qu'elles ne sont pas réglées.",
    '',
    'Tapez *1* pour afficher la liste de vos pénalités et choisir celle(s) à régler.',
  ].join('\n');
}

export function penaltiesListBotMessage(
  penalties: Array<{
    amount: number;
    reason: string;
    created_at: Date;
    jobTitle?: string | null;
  }>,
): string {
  const lines: string[] = ['📋 *Vos pénalités impayées*', ''];
  penalties.forEach((p, i) => {
    const date = p.created_at.toLocaleDateString('fr-FR');
    const job = p.jobTitle ? ` - *_${p.jobTitle}_*` : '';
    lines.push(
      `*${i + 1}.* ${p.amount.toLocaleString('fr-FR')} FCFA - ${p.reason}${job} _(${date})_`,
    );
  });
  const total = penalties.reduce((s, p) => s + p.amount, 0);
  lines.push(
    '',
    `*Total*: ${total.toLocaleString('fr-FR')} FCFA`,
    '',
    'Tapez le *numéro* de la pénalité à régler, ou *0* pour toutes les régler.',
  );
  return lines.join('\n');
}

/**
 * Re-prompt inside a flow. Deliberately does not point anywhere: the menu is
 * gone, and a dead end outside a flow gets the welcome card instead.
 */
export function unknownCommandMessage(): string {
  return "Je n'ai pas compris votre réponse. Merci de réessayer.";
}
