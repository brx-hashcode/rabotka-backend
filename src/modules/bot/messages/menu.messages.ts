import type { BotProfileType } from '../types/bot-state.types';

export type ContactInfo = {
  email: string;
  phone: string;
  address: string;
};

export function workerMenuMessage(): string {
  return [
    '*MENU RABOTKA*',
    '',
    '1- Trouver une mission',
    '2- Mes candidatures',
    '3- Paiements en attente',
    '4- Offres recommandées',
    '5- Mon profil',
    '6- Historique',
    '7- Aide',
    '',
    '*Répondez avec le numéro de votre choix.*',
  ].join('\n');
}

export function employerMenuMessage(): string {
  return [
    '*MENU RABOTKA*',
    '',
    '1- Publier une offre',
    '2- Mes offres publiées',
    '3- Candidatures reçues',
    '4- Paiements en attente',
    '5- Missions pourvues',
    '6- Travailleurs recommandés',
    '7- Mon profil',
    '8- Historique',
    '9- Aide',
    '',
    '*Répondez avec le numéro de votre choix.*',
  ].join('\n');
}

export function menuMessage(profileType: BotProfileType): string {
  return profileType === 'WORKER' ? workerMenuMessage() : employerMenuMessage();
}

export function helpMessage(contact: ContactInfo): string {
  return [
    '*CONTACT RABOTKA*',
    '',
    `*Téléphone*: ${contact.phone}`,
    `*Email*: ${contact.email}`,
    `*Adresse*: _${contact.address}_`,
    '',
    "*Tapez 'Menu' pour revenir.*",
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
    '⚠️ *Accès bloqué — Pénalités impayées*',
    '',
    "Vous avez des pénalités impayées. Vous ne pouvez pas accéder aux fonctionnalités tant qu'elles ne sont pas réglées.",
    '',
    "Tapez *3* (Paiements en attente) pour régler vos pénalités et réactiver l'accès.",
  ].join('\n');
}

export function unknownCommandMessage(): string {
  return "Commande non reconnue. Tapez *Menu* pour voir le menu.";
}
