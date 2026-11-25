import {
  defaultGrid,
  forbiddenTheme,
  GridError,
  isFit,
  isMust,
  isQuality,
  MAX_FIT,
  needsReading,
  normaliseGrid,
  parseProposal,
  type GridItem,
} from '../cv-grid';

const fit = (over: Partial<Record<string, unknown>> = {}) => ({
  kind: 'FIT' as const,
  family: 'TASKS',
  label: 'Tâches proches',
  importance: 2,
  ...over,
});

describe('forbiddenTheme', () => {
  it.each([
    ['Moins de 30 ans', 'age'],
    ['Âge maximum 35 ans', 'age'],
    ['Âgée de 25 à 30 ans', 'age'],
    ['Entre 25 et 35 ans', 'age'],
    ['Jeune homme dynamique', 'age'],
    ['Under 30', 'age'],
    ['Homme uniquement', 'sex'],
    ['Femme', 'sex'],
    ['Poste réservé aux femmes', 'sex'],
    ['Women only', 'sex'],
    ['Pas de femme enceinte', 'sex'],
    ['Bonne présentation physique', 'appearance'],
    ['Nationalité congolaise', 'origin'],
    ['Origine ethnique', 'origin'],
    ['De l’ethnie kongo', 'origin'],
    ['Être chrétien', 'religion'],
    ['Situation matrimoniale', 'family'],
    ['Célibataire sans enfants', 'family'],
    ['Bonne santé', 'health'],
    ['Sans handicap', 'health'],
  ])('refuses « %s »', (label, theme) => {
    expect(forbiddenTheme(label)).toBe(theme);
  });

  it.each([
    'Garde d’enfants',
    'Secteur de la santé',
    'Femme de chambre ou valet',
    'Accompagnement de personnes handicapées',
    'Moins de 5 ans d’expérience',
    'Plus de 10 ans d’expérience',
    'Entre 10 et 15 ans d’expérience',
    'Langages : Java, Python',
    'Retouche photo',
    'Animation de groupes de jeunes',
    'Autorisation de travail',
    'Enseignement en école catholique',
    'Anglais courant',
    'Ménage et nettoyage',
    'Âge d’or du cinéma',
  ])('allows « %s »', (label) => {
    expect(forbiddenTheme(label)).toBeNull();
  });
});

describe('normaliseGrid', () => {
  it('refuses what the business may not ask, with the reason', () => {
    const strict = { strict: true };
    expect(() =>
      normaliseGrid([fit({ label: 'Moins de 30 ans' })], strict),
    ).toThrow(/porte sur l’âge/);
    expect(() =>
      normaliseGrid(
        [
          fit({
            family: 'SKILLS',
            label: 'Profil',
            asked: [{ label: 'Nationalité congolaise' }],
          }),
        ],
        strict,
      ),
    ).toThrow(/origine ou la nationalité/);
    expect(() => normaliseGrid([fit({ label: ' ' })], strict)).toThrow(
      GridError,
    );
    expect(() => normaliseGrid([fit({ family: 'BEAUTY' })], strict)).toThrow(
      /inconnu/,
    );
    expect(() => normaliseGrid([fit({ importance: 0 })], strict)).toThrow(
      /au moins un critère/,
    );
    expect(() =>
      normaliseGrid(
        Array.from({ length: MAX_FIT + 1 }, (_, i) => fit({ label: `T ${i}` })),
        strict,
      ),
    ).toThrow(/au plus/);
    expect(() =>
      normaliseGrid(
        [fit(), { kind: 'MUST', family: 'LOCATION', label: 'Sur place' }],
        { strict: true, remote: true },
      ),
    ).toThrow(/à distance/);
    expect(() =>
      normaliseGrid(
        [fit(), { kind: 'MUST', family: 'EXPERIENCE', label: 'Trois ans' }],
        strict,
      ),
    ).toThrow(/durée/);
  });

  it('leaves the same things out of what the model proposes', () => {
    const items = normaliseGrid(
      [
        fit({ label: 'Moins de 30 ans' }),
        fit({ family: 'BEAUTY' }),
        fit({ family: 'EXPERIENCE', label: 'Expérience', months: 36 }),
        fit({ family: 'EXPERIENCE', label: 'Encore', months: 12 }),
        { kind: 'MUST', family: 'LOCATION', label: 'Sur place' },
      ],
      { strict: false, remote: true },
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ family: 'EXPERIENCE', months: 36 });
  });

  it('keeps the keys it knows and makes new ones for the rest', () => {
    const items = normaliseGrid(
      [fit({ key: 'known' }), fit({ key: 'known' }), fit({ key: 'invented' })],
      { strict: true, keys: new Set(['known']) },
    );
    expect(items[0].key).toBe('known');
    expect(new Set(items.map((i) => i.key)).size).toBe(3);
    expect(items.map((i) => i.key)).not.toContain('invented');
  });

  it('lists what is asked once, for skills and tools only', () => {
    const [skills, tasks] = normaliseGrid(
      [
        fit({
          family: 'SKILLS',
          label: 'Compétences',
          asked: [
            { label: 'Excel', importance: 3 },
            { label: ' excel ' },
            { label: '' },
            { label: 'Sage' },
          ],
        }),
        fit({ asked: [{ label: 'Excel' }] }),
      ],
      { strict: true },
    );
    expect(skills).toMatchObject({
      asked: [
        { label: 'Excel', importance: 3 },
        { label: 'Sage', importance: 2 },
      ],
    });
    expect(tasks).not.toHaveProperty('asked');
  });
});

describe('a list of one', () => {
  it('is marked, not all or nothing', () => {
    const [tools] = normaliseGrid(
      [fit({ family: 'TOOLS', label: 'Outils', asked: [{ label: 'Sage' }] })],
      { strict: true },
    );
    expect(tools).toMatchObject({ label: 'Outils : Sage' });
    expect(tools).not.toHaveProperty('asked');
  });
});

describe('needsReading', () => {
  const grid = normaliseGrid(
    [
      fit({
        family: 'SKILLS',
        label: 'Compétences',
        asked: [{ label: 'Excel' }, { label: 'Sage' }],
      }),
      fit({ family: 'EXPERIENCE', label: 'Expérience', months: 24 }),
      fit(),
      { kind: 'MUST', family: 'LICENCE', label: 'Permis B' },
    ],
    { strict: true },
  );
  const changed = (index: number, over: object): GridItem[] =>
    grid.map((i, n) => (n === index ? { ...i, ...over } : i));

  it('is not needed for importances, durations or what is taken out', () => {
    expect(needsReading(grid, grid)).toBe(false);
    expect(needsReading(grid, changed(2, { importance: 3 }))).toBe(false);
    expect(needsReading(grid, changed(1, { months: 60 }))).toBe(false);
    expect(needsReading(grid, grid.slice(0, 2))).toBe(false);
    expect(
      needsReading(
        grid,
        changed(0, {
          asked: [{ label: 'sage' }, { label: 'excel', importance: 1 }],
        }),
      ),
    ).toBe(false);
    expect(
      needsReading(grid.slice(0, 1), [
        ...grid.slice(0, 1),
        {
          kind: 'MUST',
          key: 'x',
          family: 'EXPERIENCE',
          label: 'Deux ans',
          months: 24,
        },
      ]),
    ).toBe(false);
  });

  it('is needed for a new or reworded item', () => {
    expect(needsReading(grid, changed(2, { label: 'Autre chose' }))).toBe(true);
    expect(needsReading(grid, changed(3, { label: 'Permis C' }))).toBe(true);
    expect(
      needsReading(
        grid,
        changed(0, { asked: [{ label: 'Excel' }, { label: 'Word' }] }),
      ),
    ).toBe(true);
    expect(needsReading(grid.slice(1), grid)).toBe(true);
  });
});

describe('parseProposal', () => {
  it('reads what the models write, fences and plain words included', () => {
    const items = parseProposal(
      'Voici :\n```json\n' +
        JSON.stringify({
          fit: [
            {
              family: 'skills',
              label: 'Comptabilité',
              importance: '3',
              asked: ['Sage', { label: 'Excel', importance: 1 }],
            },
            { family: 'EXPERIENCE', label: 'Expérience', months: '36' },
          ],
          must: [{ family: 'DIPLOMA', label: 'Bac+3', months: null }],
        }) +
        '\n```',
      { remote: false },
    );
    expect(items?.filter(isFit)).toMatchObject([
      {
        family: 'SKILLS',
        importance: 3,
        asked: [
          { label: 'Sage', importance: 2 },
          { label: 'Excel', importance: 1 },
        ],
      },
      { family: 'EXPERIENCE', importance: 2, months: 36 },
    ]);
    expect(items?.filter(isMust)).toMatchObject([
      { family: 'DIPLOMA', label: 'Bac+3' },
    ]);
  });

  it('is null when there is too little to score on', () => {
    expect(parseProposal('non', { remote: false })).toBeNull();
    expect(
      parseProposal('{"fit": [], "must": []}', { remote: false }),
    ).toBeNull();
  });

  it('scores no personal quality: a CV cannot prove one', () => {
    const items = parseProposal(
      JSON.stringify({
        fit: [
          { family: 'TASKS', label: 'Suivi de projets', importance: 3 },
          {
            family: 'SKILLS',
            label: 'Autonomie et rigueur',
            importance: 2,
            asked: ['Autonomie', 'Souci du détail'],
          },
          {
            family: 'SKILLS',
            label: 'Organisation et communication',
            importance: 3,
            asked: [
              'Compétences organisationnelles',
              'Compétences de communication',
            ],
          },
          {
            family: 'SKILLS',
            label: 'Compétences',
            importance: 2,
            asked: [
              'Rédaction de rapports',
              'Rigueur',
              'Organisation de réunions',
            ],
          },
          { family: 'TRAINING', label: 'Diplôme en gestion', importance: 1 },
        ],
      }),
      { remote: false },
    );
    expect(items?.filter(isFit).map((i) => i.label)).toEqual([
      'Suivi de projets',
      'Compétences',
      'Diplôme en gestion',
    ]);
    expect(items?.filter(isFit)[1].asked?.map((a) => a.label)).toEqual([
      'Rédaction de rapports',
      'Organisation de réunions',
    ]);
  });

  it.each([
    'Communication interne et externe',
    'Organisation de réunions',
    'Gestion de projet',
    'Conception de systèmes autoportés',
    'Organisation du travail en atelier',
    'Community management',
  ])('keeps the work « %s »', (label) => {
    expect(isQuality(label)).toBe(false);
  });

  it('keeps « essentiel » for three', () => {
    const items = parseProposal(
      JSON.stringify({
        fit: Array.from({ length: 6 }, (_, i) => ({
          family: 'TASKS',
          label: `Tâche ${i}`,
          importance: 3,
        })),
      }),
      { remote: false },
    );
    expect(items?.filter(isFit).map((i) => i.importance)).toEqual([
      3, 3, 3, 2, 2, 2,
    ]);
  });

  it('lets the business ask for a quality if it wants to', () => {
    expect(
      normaliseGrid([fit({ label: 'Ponctualité' })], { strict: true }),
    ).toHaveLength(1);
  });

  it('scores a duration asked as a must-have', () => {
    const items = parseProposal(
      JSON.stringify({
        fit: Array.from({ length: MAX_FIT }, (_, i) => ({
          family: 'TASKS',
          label: `Tâche ${i}`,
          importance: 2,
        })),
        must: [{ family: 'EXPERIENCE', label: 'Deux ans', months: 24 }],
      }),
      { remote: false },
    )!;
    expect(items.filter(isFit)).toHaveLength(MAX_FIT);
    expect(
      items
        .filter((i) => i.family === 'EXPERIENCE')
        .map((i) => [i.kind, i.months]),
    ).toEqual([
      ['FIT', 24],
      ['MUST', 24],
    ]);
  });

  it('has a grid to fall back on', () => {
    expect(
      defaultGrid('fr')
        .filter(isFit)
        .map((i) => i.importance),
    ).toEqual([3, 3, 2, 1]);
  });
});
