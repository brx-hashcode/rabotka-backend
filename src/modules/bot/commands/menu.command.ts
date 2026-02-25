import type { BotProfile } from '../types/bot-state.types';
import { menuMessage } from '../messages/menu.messages';

export function handleMenuCommand(profile: BotProfile): string {
  return menuMessage(profile.profile_type);
}
