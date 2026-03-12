import { helpMessage, unknownCommandMessage, type ContactInfo } from '../messages/menu.messages';

export function handleHelpCommand(command: string, contact: ContactInfo): string {
  if (command !== 'help') {
    return unknownCommandMessage();
  }
  return helpMessage(contact);
}
