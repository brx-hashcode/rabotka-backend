import type { BotProfileType } from '../types/bot-state.types';

export type ContactInfo = {
  email: string;
  phone: string;
  address: string;
};

export function workerMenuMessage(): string {
  return [
    '*Menu Rabotka*',
    '',
    '1- Trouver une mission',
    '2- Mes candidatures actives',
    '3- Offres recommandées',
    '4- Rechercher par référence',
    '5- Mon profil',
    '6- Recharger mon wallet',
    '7- Créer une réclamation',
    '8- Aide',
    '',
    '*Répondez avec le numéro de votre choix.*',
  ].join('\n');
}

export function employerMenuMessage(): string {
  return [
    '*Menu Rabotka*',
    '',
    '1- Publier une offre',
    '2- Candidatures reçues',
    '3- Mes offres publiées',
    '4- Missions en cours',
    '5- Travailleurs recommandés',
    '6- Mon profil',
    '7- Recharger mon wallet',
    '8- Créer une réclamation',
    '9- Aide',
    '',
    '*Répondez avec le numéro de votre choix.*',
  ].join('\n');
}

export function menuMessage(profileType: BotProfileType): string {
  return profileType === 'WORKER' ? workerMenuMessage() : employerMenuMessage();
}

/**
 * Menu shown while the account is still awaiting KYC validation. Only the two
 * actions an admin may ask for during review are available (view/fix the
 * profile, or file a claim), so it uses its own 1/2 numbering — the pre-KYC
 * gate in bot-orchestrator intercepts this input before the router, so these
 * numbers never collide with the full menu's.
 */
export function restrictedMenuMessage(): string {
  return [
    '⏳ *Votre profil est en cours de vérification.*',
    '',
    'Une fois votre KYC validé, vous aurez accès à toutes les fonctionnalités de Rabotka.',
    '',
    'En attendant, vous pouvez :',
    '',
    '1- Mon profil',
    '2- Créer une réclamation',
    '',
    '*Répondez avec le numéro de votre choix.*',
  ].join('\n');
}

export function helpMessage(contact: ContactInfo): string {
  return [
    '*Contact Rabotka*',
    '',
    `*Téléphone*: ${contact.phone}`,
    `*Email*: ${contact.email}`,
    `*Adresse*: _${contact.address}_`,
    '',
    'Tapez *Menu* pour revenir.',
  ].join('\n');
}

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

export function unknownCommandMessage(): string {
  return 'Commande non reconnue. Tapez *Menu* pour voir le menu.';
}
