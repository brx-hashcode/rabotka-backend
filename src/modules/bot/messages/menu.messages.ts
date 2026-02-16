import type { BotProfileType } from '../types/bot-state.types';

/**
 * Menu principal Worker (spec: 5.1)
 */
export function workerMenuMessage(): string {
  return [
    '📱 Menu Rabotka - Worker',
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

/**
 * Menu principal Employer (spec: 5.1)
 */
export function employerMenuMessage(): string {
  return [
    '📱 Menu Rabotka - Employer',
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

/**
 * Return menu text based on profile type
 */
export function menuMessage(profileType: BotProfileType): string {
  return profileType === 'WORKER' ? workerMenuMessage() : employerMenuMessage();
}

/**
 * Help / unknown command (same as menu)
 */
export function helpMessage(profileType: BotProfileType): string {
  return [
    menuMessage(profileType),
    '',
    "Tapez 'Menu' ou 'Aide' à tout moment pour revoir le menu.",
  ].join('\n');
}

/**
 * Command not recognized
 */
export function unknownCommandMessage(): string {
  return "Commande non reconnue. Tapez 'Menu' pour voir les options.";
}
