import type { BotProfileType } from '../types/bot-state.types';
import { RABOTKA_CONTACT } from '../../../common/constants/rabotka-contact';

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
    'Tapez le numéro correspondant à votre choix.',
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
    'Tapez le numéro correspondant à votre choix.',
  ].join('\n');
}

export function menuMessage(profileType: BotProfileType): string {
  return profileType === 'WORKER' ? workerMenuMessage() : employerMenuMessage();
}

export function helpMessage(): string {
  return [
    '*CONTACT RABOTKA*',
    '',
    `*Téléphone*: ${RABOTKA_CONTACT.phone}`,
    `*Email*: ${RABOTKA_CONTACT.email}`,
    `*Adresse*: _${RABOTKA_CONTACT.address}_`,
    '',
    "Tapez 'Menu' pour revenir.",
  ].join('\n');
}

export function unknownCommandMessage(): string {
  return "Commande non reconnue. Tapez 'Menu' pour voir les options.";
}
