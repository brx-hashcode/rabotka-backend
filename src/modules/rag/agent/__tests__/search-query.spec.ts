import { searchQuery } from '../search-query';

const user = (text: string) => ({ role: 'user' as const, text });
const vova = (text: string) => ({ role: 'assistant' as const, text });

describe('searchQuery', () => {
  it('adds the previous question to a short follow-up', () => {
    expect(
      searchQuery('Lesquels sont traités ?', [
        user('Tu peux me dire si j’ai des candidatures en cours ?'),
        vova('Vous en avez 5.'),
      ]),
    ).toBe(
      'Tu peux me dire si j’ai des candidatures en cours ? Lesquels sont traités ?',
    );
  });

  it('skips the message being answered when the history already holds it', () => {
    expect(
      searchQuery('Lesquels ?', [
        user('J’ai des candidatures ?'),
        vova('5.'),
        user('Lesquels ?'),
      ]),
    ).toBe('J’ai des candidatures ? Lesquels ?');
  });

  it('leaves a question that stands on its own', () => {
    const q =
      'Comment je fais pour retirer mon argent une fois la mission réalisée ?';
    expect(searchQuery(q, [user('Bonjour')])).toBe(q);
  });

  it('leaves a first message alone', () => {
    expect(searchQuery('Bonjour Vova', [])).toBe('Bonjour Vova');
  });
});
