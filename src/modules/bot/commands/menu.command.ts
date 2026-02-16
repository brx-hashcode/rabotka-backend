import type { BotProfile } from '../types/bot-state.types';
import { menuMessage } from '../messages/menu.messages';

/**
 * Returns the main menu for the given profile type (Worker or Employer).
 */
export function handleMenuCommand(profile: BotProfile): string {
  return menuMessage(profile.profile_type);
}
