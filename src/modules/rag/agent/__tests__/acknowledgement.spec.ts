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

  it.each([
    ['D’accord \nMerci', 'Ravine, 9 Sep 17:59'],
    ['Ok \nMerci', 'Ravine, 23 Sep 10:37'],
    ['Merci beaucoup', ''],
    ["ok d'accord merci", ''],
  ])('reads %s as one close, stacked across lines', (text) => {
    // People stack these, and across two lines. Enumerating every pair would
    // be a list that still misses the next one somebody types, so the message
    // is consumed atom by atom instead.
    expect(isAcknowledgement(text)).toBe(true);
  });

  it.each(['Non', 'Bien'])('leaves a bare %s to the assistant', (text) => {
    // Alone it is an ANSWER — to "voulez-vous que je regarde ?" a bare « non »
    // means no, and it deserves a real reply. Stacked, as in « non merci », it
    // closes. Same word, different message, which is why two atoms are needed.
    //
    // « rien » is the exception and stays a close on its own: asked what they
    // are looking for, "nothing" IS the end of the exchange.
    expect(isAcknowledgement(text)).toBe(false);
  });

  it.each(['rien ne marche', 'ok mais mon paiement ne passe pas'])(
    'does not swallow %s',
    (text) => {
      expect(isAcknowledgement(text)).toBe(false);
    },
  );

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
