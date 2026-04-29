import { handleHelpCommand } from '../help.command';
import {
  helpMessage,
  unknownCommandMessage,
  type ContactInfo,
} from '../../messages/menu.messages';

const contact: ContactInfo = {
  email: 'contact@rabotka.com',
  phone: '+242 06 000 0000',
  address: 'Brazzaville, Congo',
};

describe('handleHelpCommand', () => {
  it('returns helpMessage when command is "help"', () => {
    expect(handleHelpCommand('help', contact)).toBe(helpMessage(contact));
  });

  it('returns unknownCommandMessage for unrecognized command', () => {
    expect(handleHelpCommand('foo', contact)).toBe(unknownCommandMessage());
  });

  it('returns unknownCommandMessage for empty string', () => {
    expect(handleHelpCommand('', contact)).toBe(unknownCommandMessage());
  });

  it('returns unknownCommandMessage for "HELP" (case-sensitive)', () => {
    expect(handleHelpCommand('HELP', contact)).toBe(unknownCommandMessage());
  });
});
