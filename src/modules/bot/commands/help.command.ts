import { helpMessage, unknownCommandMessage } from '../messages/menu.messages';

export function handleHelpCommand(command: string): string {
  if (command !== 'help') {
    return unknownCommandMessage();
  }
  return helpMessage();
}
