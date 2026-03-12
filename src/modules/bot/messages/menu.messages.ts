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
    '1️⃣ Voir les offres disponibles',
    '2️⃣ Mes candidatures',
    '3️⃣ Mon profil',
    '4️⃣ Historique',
    '5️⃣ Aide',
    '',
    '*Tapez le numéro correspondant.*',
  ].join('\n');
}

export function employerMenuMessage(): string {
  return [
    '*MENU RABOTKA*',
    '',
    '1️⃣ Publier une offre',
    '2️⃣ Mes offres publiées',
    '3️⃣ Candidatures reçues',
    '4️⃣ Missions pourvues',
    '5️⃣ Mon profil',
    '6️⃣ Historique',
    '7️⃣ Aide',
    '',
    '*Tapez le numéro correspondant.*',
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

export function unknownCommandMessage(): string {
  return "Commande non reconnue. Tapez 'Menu' pour voir les options.";
}
