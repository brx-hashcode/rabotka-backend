import type { BotProfile } from '../types/bot-state.types';
import { helpMessage } from '../messages/menu.messages';

export function handleHelpCommand(profile: BotProfile): string {
  return helpMessage(profile.profile_type);
}
