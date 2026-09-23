import { brazzavilleClock, correctSalutation } from '../prompts';

/**
 * Every case below is a real reply from Fariol Blondeau's transcript, at the
 * timestamp it was actually sent. The clock was right every time; the model
 * said the other word. He eventually corrected it himself, at 06h08:
 * « Tu confond le temps c'est bonjour ah ah ».
 */
describe('correctSalutation', () => {
  it.each([
    ['2026-08-27T05:08:51Z', '06h08'],
    ['2026-08-28T08:19:44Z', '09h19'],
    ['2026-08-23T08:29:44Z', '09h29'],
  ])('fixes « Bonsoir » sent at %s (%s local)', (iso, hhmm) => {
    const now = new Date(iso);
    expect(brazzavilleClock(now).hhmm).toBe(hhmm);

    expect(correctSalutation('Bonsoir *Fariol*! Avec plaisir.', 'Merci', now)).toBe(
      'Bonjour *Fariol*! Avec plaisir.',
    );
  });

  it('leaves a correct salutation alone', () => {
    const night = new Date('2026-09-09T21:34:16Z'); // 22h34 local
    const reply = 'Bonsoir *Fariol*! Merci à vous.';
    expect(correctSalutation(reply, 'merci', night)).toBe(reply);
  });

  it('never corrects somebody on their own greeting', () => {
    // The standing rule is to answer with the word the person used. Somebody
    // who writes « bonsoir » at noon gets « Bonsoir » back, deliberately.
    const morning = new Date('2026-08-27T05:08:51Z');
    const reply = 'Bonsoir *Fariol*! Avec plaisir.';
    expect(correctSalutation(reply, 'Bonsoir VoVa', morning)).toBe(reply);
  });

  it('touches only the opening word', () => {
    const morning = new Date('2026-08-27T05:08:51Z');
    const reply = 'Bonsoir *Fariol*! On se dit bonsoir ce soir alors.';

    // Not a rewriter — the rest of the sentence is the model's own.
    expect(correctSalutation(reply, 'salut', morning)).toBe(
      'Bonjour *Fariol*! On se dit bonsoir ce soir alors.',
    );
  });

  it('leaves a reply that opens with neither word', () => {
    const morning = new Date('2026-08-27T05:08:51Z');
    const reply = 'Votre solde est de *0 FCFA*.';
    expect(correctSalutation(reply, 'mon solde', morning)).toBe(reply);
  });
});
