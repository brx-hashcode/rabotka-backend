import {
  draftMessages,
  forgotten,
  parseDraft,
  problems,
  type OfferBrief,
} from '../offer-writer';

const TRADES = ['Cuisine & Restauration', 'Nettoyage'];
const input = (over: Partial<OfferBrief> = {}): OfferBrief => ({
  brief: 'Un assistant directeur à Brazzaville au Congo, 2 ans d’expérience',
  title: null,
  employmentType: null,
  city: 'Kinshasa',
  isRemote: false,
  quantity: 1,
  businessName: 'ZuaFood',
  countryName: 'Congo-Kinshasa',
  businessCategory: 'Association',
  ...over,
});
const answer = (over: Record<string, unknown> = {}, facts: object = {}) =>
  JSON.stringify({
    facts: { city: 'Brazzaville', country: 'Congo', ...facts },
    title: 'Assistant directeur',
    about: 'ZuaFood est une association du Congo-Kinshasa.',
    role: 'Vous préparez les réunions du directeur.',
    tasks: ['Préparer les réunions', 'Suivre les projets'],
    education: [{ text: 'Diplôme en gestion', required: true }],
    experience: [{ text: '2 ans d’expérience', required: true }],
    skills: [{ text: 'Excel', required: false }],
    qualities: ['Discrétion sur les dossiers'],
    conditions: [],
    categoryName: 'cuisine & restauration',
    removed: [],
    ...over,
  });
const draft = (
  over: Record<string, unknown> = {},
  facts: object = {},
  form: Partial<OfferBrief> = {},
) => parseDraft(answer(over, facts), TRADES, input(form))!;

describe('offer-writer: the request wins', () => {
  it('takes the place from the request, not from the form', () => {
    const d = draft();
    expect(d.description).toContain('- Lieu : Brazzaville, Congo');
    expect(d.description).not.toContain('Lieu : Kinshasa');
    expect(d.place).toEqual({
      remote: false,
      city: 'Brazzaville',
      country: 'Congo',
    });
    expect(d.changes).toEqual([
      { field: 'place', from: 'Kinshasa', to: 'Brazzaville' },
    ]);
  });

  it('keeps the form’s when the request says nothing, or the model made it up', () => {
    for (const city of [null, 'Dakar']) {
      const d = draft({}, { city, country: null }, { brief: 'Un comptable' });
      expect(d.description).toContain('- Lieu : Kinshasa');
      expect(d.place).toBeNull();
      expect(d.changes).toEqual([]);
    }
  });

  it('says it to live there only when the request did', () => {
    const line = 'Habiter à Brazzaville ou pouvoir s’y installer';
    expect(draft({}, { residence: true }).description).toContain(line);
    expect(draft().description).not.toContain(line);
  });

  it('follows the type and the number the request gives', () => {
    const d = draft(
      {},
      { employmentType: 'stage', quantity: '2', city: null },
      {
        brief: 'Deux stagiaires en comptabilité',
        employmentType: 'CDI',
        quantity: 5,
      },
    );
    expect(d.employmentType).toBe('STAGE');
    expect(d.quantity).toBe(2);
    expect(d.description).toContain('- Type de contrat : Stage');
    expect(d.description).toContain('- Nombre de personnes : 2');
    expect(d.changes.map((c) => c.field)).toEqual([
      'employmentType',
      'quantity',
    ]);
  });

  it('does not let a guess replace what the form says', () => {
    const d = draft(
      {},
      { employmentType: 'CDD', quantity: 3, city: null },
      { brief: 'Un vendeur', employmentType: 'CDI', quantity: 1 },
    );
    expect(d.description).toContain('Type de contrat : CDI');
    expect(d).toMatchObject({ employmentType: null, quantity: null });
    // Nothing chosen: the guess is a suggestion.
    expect(
      draft({}, { employmentType: 'CDD' }, { employmentType: null })
        .employmentType,
    ).toBe('CDD');
  });

  it('reads remote work from the request only', () => {
    const d = draft(
      {},
      { remote: true, city: null },
      { brief: 'Développeur en télétravail' },
    );
    expect(d.place).toMatchObject({ remote: true });
    expect(d.description).toContain('- Lieu : à distance');
    expect(draft({}, { remote: true }).place?.remote).toBe(false);
  });
});

describe('offer-writer: nothing invented', () => {
  it('drops every line with a figure nobody gave', () => {
    const d = draft(
      {
        tasks: ['Encadrer 5 personnes', 'Préparer les réunions'],
        conditions: ['Prime de 20 000 FCFA', 'Déplacements en ville'],
        role: 'Vous préparez les réunions. Vous gérez 12 sites.',
      },
      { pay: '300 000 FCFA', hours: 'de 8h à 17h' },
    );
    expect(d.description).not.toMatch(
      /5 personnes|20 000|12 sites|300 000|17h/,
    );
    expect(d.description).toContain('- Préparer les réunions');
    expect(d.description).toContain('- Déplacements en ville');
  });

  it('keeps the figures of the request', () => {
    const d = draft(
      {},
      { pay: '15 000 FCFA chacun', hours: 'de 8h à 17h', city: null },
      { brief: '2 serveurs, 15 000 FCFA chacun, de 8h à 17h' },
    );
    expect(d.description).toContain('- Rémunération : 15 000 FCFA chacun');
    expect(d.description).toContain('- Horaires : de 8h à 17h');
    expect(d.toConfirm).not.toContain('la rémunération');
  });

  it('presents as a plus what the request does not require', () => {
    const d = draft();
    expect(d.description).toContain('- Diplôme en gestion : un atout');
    expect(d.description).toContain('- 2 ans d’expérience : obligatoire\n');
    // A skill is what the work is made of.
    expect(d.description).toContain('Compétences :\n- Excel\n');
    expect(
      draft({
        education: [{ text: 'Un diplôme est un plus', required: false }],
      }).description,
    ).toContain('- Un diplôme est un plus\n');
  });

  it('knows a name in capitals as what the request requires', () => {
    const d = draft(
      {
        skills: ['AWS', 'Azure', 'SQL', 'Le tri'].map((x) => ({
          text: `Maîtriser ${x}`,
          required: true,
        })),
      },
      { city: null },
      { brief: "Ingénieur, maîtrise d'AWS et Azure obligatoire" },
    );
    expect(d.description).toContain('- Maîtriser AWS : obligatoire');
    expect(d.description).toContain('- Maîtriser Azure : obligatoire');
    expect(d.description).toContain('- Maîtriser SQL\n');
    expect(d.description).toContain('- Maîtriser Le tri\n');
  });

  it('leaves out contacts, and conditions the offer already gives', () => {
    const d = draft({
      tasks: ['Écrire à rh@zuafood.com', 'Préparer les réunions'],
      conditions: ['Lieu : Kinshasa', 'Type de contrat : CDI', 'Repas offert'],
    });
    expect(d.description).not.toMatch(/@|Lieu : Kinshasa|contrat : CDI/);
    expect(d.description).toContain('- Repas offert');
  });

  it('says what is still to give, from what the request gave', () => {
    expect(draft().toConfirm).toEqual([
      'la rémunération',
      'la date de début',
      'les horaires',
    ]);
    expect(
      draft({}, { employmentType: 'CDD' }, { brief: 'Un CDD', city: null })
        .toConfirm,
    ).toEqual([
      'la rémunération',
      'le lieu',
      'la date de début',
      'les horaires',
    ]);
  });
});

describe('offer-writer: nothing forgotten', () => {
  const missing = (brief: string, over: object = {}) =>
    forgotten(draft(over, { city: null }, { brief }), brief);

  it('sees a licence or a figure the offer left out', () => {
    expect(missing('Chauffeur, permis B exigé')).toEqual(['permis B']);
    expect(
      missing('Chauffeur, permis B exigé', {
        skills: [{ text: 'Permis B', required: true }],
      }),
    ).toEqual([]);
    expect(missing('Caissier, 3 ans en supermarché')).toEqual(['3 ans']);
    expect(
      missing('Caissier, 3 ans en supermarché', {
        experience: ['Trois ans en supermarché'],
      }),
    ).toEqual([]);
  });

  it('does not ask for what is left out on purpose', () => {
    expect(missing('Cuisinier, appeler le 06 600 00 00')).toEqual([]);
    expect(missing('Femme de moins de 30 ans')).toEqual([]);
    expect(missing('De 25 à 35 ans')).toEqual([]);
    // Years of work, though, count.
    expect(missing('Plus de 10 ans d’expérience')).toEqual(['10 ans']);
  });
});

describe('offer-writer: not too thin', () => {
  const brief = 'Un assistant directeur à Brazzaville';
  const full = {
    tasks: ['Préparer', 'Suivre', 'Classer', 'Rédiger'],
    skills: ['Rédiger un compte rendu', 'Tenir un agenda'],
  };
  const found = (over: object) => problems(draft(over, {}, { brief }), brief);

  it('asks for missions and skills when a model writes almost nothing', () => {
    expect(found(full)).toEqual([]);
    expect(found({ ...full, tasks: ['Assister le directeur'] })).toEqual([
      expect.stringContaining('missions'),
    ]);
    expect(found({ ...full, skills: [] })).toEqual([
      expect.stringContaining('compétences'),
    ]);
  });

  it('does not let the offer speak of the request', () => {
    expect(
      found({ ...full, role: 'La demande ne précise pas les missions.' }),
    ).toEqual([expect.stringContaining('ne voit pas la demande')]);
  });
});

describe('offer-writer: how it opens', () => {
  const post = (over: object, form: Partial<OfferBrief> = {}) =>
    /Le poste\n(.*)/.exec(draft(over as never, {}, form).description)?.[1];

  it('says first who is looked for and what for, then « Vous »', () => {
    expect(
      post({
        seeking: 'Nous recherchons un assistant pour préparer les réunions.',
        role: 'Vous travaillez avec le directeur.',
      }),
    ).toBe(
      'Nous recherchons un assistant pour préparer les réunions. Vous travaillez avec le directeur.',
    );
  });

  it('puts it first wherever the model wrote it', () => {
    expect(
      post({
        seeking: null,
        role: 'Nous recrutons un assistant pour le siège. Vous suivez ses dossiers.',
      }),
    ).toBe(
      'Nous recrutons un assistant pour le siège. Vous suivez ses dossiers.',
    );
  });

  it('opens with it even when the model did not', () => {
    expect(
      post({
        seeking: 'Vous serez responsable du cloud.',
        role: 'Vous gérez.',
      }),
    ).toBe(
      'Nous recherchons : Assistant directeur. Vous serez responsable du cloud. Vous gérez.',
    );
  });

  it('names the organisation, in its own sector only', () => {
    const about = (text: string) =>
      /Qui sommes-nous\n(.*)/.exec(draft({ about: text }).description)?.[1];
    expect(about('ZuaFood agit dans le secteur associatif.')).toBe(
      'ZuaFood agit dans le secteur associatif.',
    );
    for (const wrong of [
      'Cette organisation œuvre dans le secteur associatif.',
      'ZuaFood œuvre dans le secteur technologique.',
      'ZuaFood travaille dans le domaine de la santé.',
    ]) {
      expect(about(wrong)).toBe('ZuaFood, association, Congo-Kinshasa.');
    }
  });
});

describe('offer-writer: the layout', () => {
  it('is always the same six sections, in order', () => {
    const { description } = draft();
    const at = [
      'Qui sommes-nous',
      'Le poste',
      'Vos missions',
      'Profil recherché',
      'Formation :',
      'Expérience :',
      'Compétences :',
      'Qualités :',
      'Conditions',
      'Pour postuler',
    ].map((h) => description.indexOf(`${h}\n`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(
      description.endsWith('Postulez directement en ligne sur Rabotka.'),
    ).toBe(true);
  });

  it('is in English for a request in English', () => {
    const d = parseDraft(
      answer({}, { city: 'Accra', country: null }),
      TRADES,
      input({
        brief:
          'We need an assistant to the director based in Accra with experience',
      }),
    )!;
    expect(d.description).toContain('Your responsibilities\n- ');
    expect(d.description).toContain('- Location: Accra');
    expect(d.description).toContain('Diplôme en gestion: an advantage');
    expect(d.toConfirm[0]).toBe('the pay');
  });

  it('drops markdown, numbering and empty blocks, within the form’s limits', () => {
    const d = draft({
      title: `**${'T'.repeat(140)}**`,
      tasks: ['- **Servir** les clients', '2) Ranger', null, ''],
      education: null,
      skills: ['Excel'],
      qualities: [],
    });
    expect(d.title.length).toBeLessThanOrEqual(100);
    expect(d.description).toContain('- Servir les clients\n- Ranger');
    expect(d.description).not.toContain('Formation :');
    expect(d.description).not.toContain('Qualités :');
    expect(
      draft({ role: `${'mot '.repeat(900)}.` }).description.length,
    ).toBeLessThanOrEqual(2500);
  });

  it('keeps the trade only from the list, and what was left out', () => {
    expect(draft().categoryName).toBe('Cuisine & Restauration');
    expect(draft({ categoryName: 'Astronaute' }).categoryName).toBeNull();
    expect(draft({ removed: ['l’âge', null, ''] }).removed).toEqual(['l’âge']);
  });

  it('is null for anything but the JSON asked for', () => {
    expect(parseDraft('Je ne peux pas.', TRADES, input())).toBeNull();
    expect(parseDraft('{"title": "x"}', TRADES, input())).toBeNull();
    expect(
      parseDraft(answer({ tasks: ['Gérer 40 sites'] }), TRADES, input()),
    ).toBeNull();
  });
});

describe('offer-writer: the prompt', () => {
  it('gives the request last, as what counts, and the form as defaults', () => {
    const [system, human] = draftMessages(
      input({ employmentType: 'CDI', quantity: 2 }),
      TRADES,
    );
    const text = human.content as string;
    expect(text).toContain('Cuisine & Restauration ; Nettoyage');
    expect(text).toContain('Organisation : ZuaFood (Association)');
    expect(text.indexOf('la demande l’emporte')).toBeLessThan(
      text.indexOf('DEMANDE DE L'),
    );
    expect(text.trim().endsWith('2 ans d’expérience')).toBe(true);
    expect(text).toContain('- Lieu : Kinshasa');
    expect(system.content as string).toContain('LA DEMANDE FAIT FOI');
    // Never hard-coded to one country any more.
    expect(system.content as string).not.toContain('Congo-Brazzaville');
  });
});
