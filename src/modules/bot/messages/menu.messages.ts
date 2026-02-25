import type { BotProfileType } from '../types/bot-state.types';
import { RABOTKA_CONTACT } from '../../../common/constants/rabotka-contact';

export function workerMenuMessage(): string {
  return [
    'Menu Rabotka - Worker',
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
    'Menu Rabotka - Employer',
    '',
    '1️⃣ Publier une offre',
    '2️⃣ Mes offres publiées',
    '3️⃣ Candidatures reçues',
    '4️⃣ Mon profil',
    '5️⃣ Historique',
    '6️⃣ Aide',
    '',
    'Tapez le numéro correspondant à votre choix.',
  ].join('\n');
}

export function menuMessage(profileType: BotProfileType): string {
  return profileType === 'WORKER' ? workerMenuMessage() : employerMenuMessage();
}

export function helpMessage(): string {
  return [
    'Aide - Contact Rabotka',
    '',
    'Nous contacter:',
    `*Téléphone*: _${RABOTKA_CONTACT.phone}_`,
    `*Email*: _${RABOTKA_CONTACT.email}_`,
    `*Adresse*: _${RABOTKA_CONTACT.address}_`,
    '',
    "Tapez 'Menu' à tout moment pour revoir le menu.",
  ].join('\n');
}

export function unknownCommandMessage(): string {
  return "Commande non reconnue. Tapez 'Menu' pour voir les options.";
}
