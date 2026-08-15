
export type ContactInfo = {
  email: string;
  phone: string;
  address: string;
};

/**
 * The support card.
 *
 * Answers `/support` for any account, and stands in as the whole reply for a
 * suspended one. `reason` is the admin's own words when the suspension has
 * them — "your account is suspended" with no motive leaves the reader with
 * nothing to act on, which is the entire point of storing it.
 */
export function supportCardBotMessage(
  contact: ContactInfo,
  opts?: { suspended?: boolean; reason?: string | null },
): string {
  const lines = ['Support Rabotka', ''];

  // Driven by the STATUS, not by whether a reason happens to be stored. Keying
  // it off the reason meant every suspension predating the suspension_reason
  // column produced a card that never mentioned the suspension at all.
  if (opts?.suspended) {
    lines.push('Votre compte est suspendu.', '');
    if (opts.reason?.trim()) {
      lines.push(`Motif : ${opts.reason.trim()}`, '');
    }
  }

  lines.push(
    'Notre équipe vous répond du lundi au samedi, de 8h à 18h :',
    '',
    `*Email* : ${contact.email}`,
    `*Téléphone* : ${contact.phone}`,
  );

  return lines.join('\n');
}

/**
 * @deprecated Use {@link supportCardBotMessage}, which carries the suspension
 * reason. Kept only until the last caller moves.
 */
export function accountSuspendedBotMessage(contact: ContactInfo): string {
  return supportCardBotMessage(contact);
}

/**
 * The penalty gate: what a user with unpaid penalties gets instead of the
 * feature they asked for. Names the way out ("1"), because a block with no
 * stated remedy just reads as the bot being broken.
 */
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
  const lines: string[] = ['Vos pénalités impayées', ''];
  penalties.forEach((p, i) => {
    const date = p.created_at.toLocaleDateString('fr-FR');
    const job = p.jobTitle ? ` - ${p.jobTitle}` : '';
    lines.push(
      `${i + 1}. ${p.amount.toLocaleString('fr-FR')} FCFA - ${p.reason}${job} (${date})`,
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
 * Re-prompt inside a flow.
 *
 * Now names the escape. This is what someone stuck mid-flow sees, and it
 * previously pointed nowhere — the reader had to already know that "menu" got
 * them out. `/` is the discoverable version of that, and it works from inside
 * any flow (see `expandSlashCommand`).
 */
export function unknownCommandMessage(): string {
  return [
    "Je n'ai pas compris votre réponse. Merci de réessayer.",
    '',
    'Envoyez */* à tout moment pour revenir aux options.',
  ].join('\n');
}
