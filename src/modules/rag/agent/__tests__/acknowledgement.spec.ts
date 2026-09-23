import { isAcknowledgement, isPureGreeting } from '../offer';
import { acknowledgementReply } from '../refusals';

/**
 * From a real transcript. Every one of these was answered with a full
 * reintroduction — "Bonjour Chloé ! Je suis VoVa AI, l'assistant de Rabotka…"
 * — and an app card, until she wrote « arrête avec vos messages bête la ».
 */
describe('isAcknowledgement', () => {
  it.each([
    'Merci',
    'Merci bien',
    'Non merci',
    'Je vois',
    'Non laisse',
    'ok',
    "D'accord",
    'Thank you',
    'thanks',
  ])('treats %s as the end of the exchange', (text) => {
    expect(isAcknowledgement(text)).toBe(true);
  });

  it.each([
    'merci, et comment je postule ?',
    'ok mais mon paiement ne passe pas',
    'je vois une erreur sur mon profil',
  ])('does not swallow a question that opens with one: %s', (text) => {
    // Exact match after folding, like isPureGreeting — otherwise the answer
    // drops the actual question on the floor.
    expect(isAcknowledgement(text)).toBe(false);
  });

  it('does not overlap with a greeting', () => {
    // Two different decisions; « bonjour » opens and « merci » closes. Sharing
    // one list would make a change to either silently change the other.
    for (const hello of ['bonjour', 'salut', 'hello']) {
      expect(isPureGreeting(hello)).toBe(true);
      expect(isAcknowledgement(hello)).toBe(false);
    }
  });
});

describe('acknowledgementReply', () => {
  it('is short, and asks nothing', () => {
    const reply = acknowledgementReply('Chloé');

    expect(reply).toContain('Chloé');
    // No relance. Somebody who says merci has finished, and a question turns
    // the close into another round trip.
    expect(reply).not.toContain('?');
    expect(reply.length).toBeLessThan(40);
  });

  it('never reintroduces the assistant', () => {
    expect(acknowledgementReply('Chloé')).not.toContain('VoVa');
    expect(acknowledgementReply(null)).not.toContain('VoVa');
  });

  it('works for somebody with no profile', () => {
    expect(acknowledgementReply(null)).toBe('Avec plaisir 🙂');
  });
});
