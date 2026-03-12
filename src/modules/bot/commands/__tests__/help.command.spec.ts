import { handleHelpCommand } from '../help.command';
import { helpMessage, unknownCommandMessage } from '../../messages/menu.messages';

describe('handleHelpCommand', () => {
  it('returns helpMessage when command is "help"', () => {
    expect(handleHelpCommand('help')).toBe(helpMessage());
  });

  it('returns unknownCommandMessage for unrecognized command', () => {
    expect(handleHelpCommand('foo')).toBe(unknownCommandMessage());
  });

  it('returns unknownCommandMessage for empty string', () => {
    expect(handleHelpCommand('')).toBe(unknownCommandMessage());
  });

  it('returns unknownCommandMessage for "HELP" (case-sensitive)', () => {
    expect(handleHelpCommand('HELP')).toBe(unknownCommandMessage());
  });
});
