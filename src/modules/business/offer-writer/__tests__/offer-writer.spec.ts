import { draftMessages, parseDraft } from '../offer-writer';

const TRADES = ['Cuisine & Restauration', 'Nettoyage'];
const answer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    title: 'Serveur pour mariage',
    description: 'Missions :\n- Servir les invités\n- Débarrasser',
    categoryName: 'cuisine & restauration',
    employmentType: 'mission',
    removed: [],
    ...over,
  });

describe('offer-writer', () => {
  it('reads the draft and keeps the trade only from the list', () => {
    expect(parseDraft(`Voici :\n${answer()}`, TRADES)).toEqual({
      title: 'Serveur pour mariage',
      description: 'Missions :\n- Servir les invités\n- Débarrasser',
      categoryName: 'Cuisine & Restauration',
      employmentType: 'MISSION',
      removed: [],
    });
    expect(
      parseDraft(
        answer({ categoryName: 'Astronaute', employmentType: 'FREELANCE' }),
        TRADES,
      ),
    ).toMatchObject({ categoryName: null, employmentType: null });
  });

  it('keeps within the form’s limits, cutting at a line, and drops markdown', () => {
    const long = Array.from(
      { length: 60 },
      (_, i) => `- Tâche numéro ${i}`,
    ).join('\n');
    const d = parseDraft(
      answer({
        title: 'T'.repeat(140),
        description: `**Missions** :\n${long}`,
      }),
      TRADES,
    );
    expect(d?.title.length).toBeLessThanOrEqual(100);
    expect(d?.description.length).toBeLessThanOrEqual(1000);
    expect(d?.description.startsWith('Missions :')).toBe(true);
    expect(d?.description.endsWith('…')).toBe(false);
  });

  it('says what it left out', () => {
    expect(
      parseDraft(answer({ removed: ['l’âge', '', 'le sexe'] }), TRADES)
        ?.removed,
    ).toEqual(['l’âge', 'le sexe']);
  });

  it('is null for anything but the JSON asked for', () => {
    expect(parseDraft('Je ne peux pas.', TRADES)).toBeNull();
    expect(parseDraft('{"title": "x"}', TRADES)).toBeNull();
  });

  it('gives the model the trades, what the form says and the brief', () => {
    const [, human] = draftMessages(
      {
        brief: '2 serveurs samedi',
        title: null,
        employmentType: 'MISSION',
        city: 'Pointe-Noire',
        isRemote: false,
        quantity: 2,
        businessName: 'ZuaFood',
        businessCategory: 'Restauration',
      },
      TRADES,
    );
    const text = human.content as string;
    expect(text).toContain('Cuisine & Restauration ; Nettoyage');
    expect(text).toContain('Lieu : Pointe-Noire');
    expect(text).toContain('Nombre de personnes : 2');
    expect(text).toContain('Entreprise : ZuaFood (Restauration)');
    expect(text).toContain('2 serveurs samedi');
  });
});
