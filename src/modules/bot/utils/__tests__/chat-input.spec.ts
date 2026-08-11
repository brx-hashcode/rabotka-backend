import {
  expandSlashCommand,
  stripChatFormattingChars,
} from '../chat-input';
import { CMD_MENU, CMD_PAY } from '../../bot.constants';

describe('expandSlashCommand', () => {
  it('maps a bare slash to the menu', () => {
    // The whole point: "/" is what people reach for, and it previously fell
    // through to "I didn't understand".
    expect(expandSlashCommand('/')).toBe('menu');
    expect(CMD_MENU).toContain(expandSlashCommand('/'));
  });

  it('tolerates whitespace around it', () => {
    expect(expandSlashCommand('  /  ')).toBe('menu');
  });

  it('strips the slash off a command the bot already knows', () => {
    expect(CMD_MENU).toContain(expandSlashCommand('/menu'));
    expect(CMD_MENU).toContain(expandSlashCommand('/start'));
    expect(CMD_MENU).toContain(expandSlashCommand('/aide'));
    expect(CMD_PAY).toContain(expandSlashCommand('/payer'));
  });

  it('leaves accented commands intact', () => {
    expect(CMD_MENU).toContain(expandSlashCommand('/démarrer'));
  });

  it('does not change the case', () => {
    // This runs over every inbound message, including the flows that capture
    // free text. Lowercasing here would flatten a cancellation reason.
    expect(expandSlashCommand('/Menu')).toBe('Menu');
  });

  it('leaves a URL alone', () => {
    expect(expandSlashCommand('https://rabotka.work/s/abc')).toBe(
      'https://rabotka.work/s/abc',
    );
  });

  it('leaves a slash that is not the first character alone', () => {
    expect(expandSlashCommand('24/7')).toBe('24/7');
    expect(expandSlashCommand('Je suis dispo lundi/mardi')).toBe(
      'Je suis dispo lundi/mardi',
    );
  });

  it('ignores a slash followed by something that is not a word', () => {
    // "//" and "/1" are not commands: "/1" in particular must not become "1"
    // and get parsed as a numbered menu choice.
    expect(expandSlashCommand('//')).toBe('//');
    expect(expandSlashCommand('/1')).toBe('/1');
    expect(expandSlashCommand('/_x')).toBe('/_x');
  });

  it('passes ordinary text through untouched', () => {
    expect(expandSlashCommand('Bonjour')).toBe('Bonjour');
    expect(expandSlashCommand('menu')).toBe('menu');
  });

  it('composes with the invisible-character strip', () => {
    // WhatsApp and mobile keyboards prefix directional marks; a slash hidden
    // behind one still has to register.
    expect(expandSlashCommand('‎/')).toBe('menu');
  });
});

describe('stripChatFormattingChars', () => {
  it('removes directional and zero-width marks', () => {
    expect(stripChatFormattingChars('‎menu​')).toBe('menu');
  });
});
