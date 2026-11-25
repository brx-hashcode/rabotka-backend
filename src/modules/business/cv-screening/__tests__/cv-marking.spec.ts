import { normaliseGrid, type GridItem } from '../cv-grid';
import { evaluate, findQuote, gridBlock, parseMarking } from '../cv-marking';

const NOW = new Date('2026-11-25T00:00:00Z');
const CV = `Clarisse Ngoma
Comptable, Atlantique Négoce, 03/2020 à aujourd'hui. Sage Comptabilité 100,
rapprochements bancaires. Licence en comptabilité, 2018.
clarisse@example.com`;

const grid: GridItem[] = normaliseGrid(
  [
    {
      kind: 'FIT',
      family: 'SKILLS',
      label: 'Compétences',
      importance: 3,
      asked: [
        { label: 'Rapprochements bancaires', importance: 3 },
        { label: 'Liasse fiscale', importance: 1 },
      ],
    },
    {
      kind: 'FIT',
      family: 'EXPERIENCE',
      label: 'Expérience',
      importance: 3,
      months: 36,
    },
    { kind: 'FIT', family: 'TASKS', label: 'Tâches', importance: 2 },
    { kind: 'FIT', family: 'RESULTS', label: 'Résultats', importance: 1 },
    { kind: 'MUST', family: 'DIPLOMA', label: 'Bac+3' },
    { kind: 'MUST', family: 'LICENCE', label: 'Permis B' },
    { kind: 'MUST', family: 'EXPERIENCE', label: 'Trois ans', months: 36 },
  ],
  { strict: true },
);
const [skills, experience, tasks, results, diploma, licence, years] = grid.map(
  (i) => i.key,
);

const answer = (items: object, over: object = {}) =>
  JSON.stringify({
    isCv: true,
    candidate: {
      name: 'Clarisse Ngoma',
      experiences: [
        {
          title: 'Comptable',
          start: '2020-03',
          end: null,
          current: true,
          type: 'FULL_TIME',
          relevance: 'HIGH',
        },
      ],
    },
    items,
    summary: 'Bon profil',
    strengths: ['Sage'],
    gaps: [],
    ...over,
  });

const good = {
  [skills]: {
    found: [
      { label: 'rapprochements bancaires', quote: 'rapprochements bancaires' },
      { label: 'Liasse fiscale', quote: 'Liasse fiscale et bilan' },
    ],
  },
  [tasks]: { mark: '80', quote: 'Sage comptabilité 100, rapprochements' },
  [diploma]: { status: 'MET', quote: 'Licence en comptabilité' },
  [licence]: { status: 'MET', quote: 'Permis B valide' },
};

describe('findQuote', () => {
  it('keeps only the words of the CV or of an answer', () => {
    expect(findQuote('Licence en comptabilite – 2018', CV, [])).toEqual({
      text: 'Licence en comptabilite – 2018',
      from: 'CV',
    });
    expect(findQuote('Master en comptabilité', CV, [])).toBeNull();
    // Whole words: « age » is not in « Sage ».
    expect(findQuote('age Comptabilité', CV, [])).toBeNull();
    expect(
      findQuote('Oui, permis B', '', [
        { question: 'Permis ?', answer: 'Oui, permis B' },
      ]),
    ).toMatchObject({ from: 'ANSWER' });
    expect(findQuote('', CV, [])).toBeNull();
  });

  it('never keeps a contact', () => {
    expect(
      findQuote('2018. clarisse@example.com', CV, [])?.text ?? '',
    ).not.toContain('clarisse@example.com');
  });
});

describe('parseMarking', () => {
  it('counts a skill only when the CV shows it, a must-have only with proof', () => {
    const read = parseMarking(answer(good), grid, CV, [], NOW);
    expect(read?.reading.items[skills].found).toEqual([
      {
        label: 'Rapprochements bancaires',
        quote: { text: 'rapprochements bancaires', from: 'CV' },
      },
    ]);
    expect(read?.reading.items[tasks]).toMatchObject({ mark: 80 });
    expect(read?.reading.items[diploma].status).toBe('MET');
    // Said met, but nothing in the CV says it.
    expect(read?.reading.items[licence].status).toBe('UNCLEAR');
    expect(read?.reading.items[results]).toBeUndefined();
    expect(read?.candidate.relevantMonths).toBe(81);
    expect(read?.criteria).toEqual({});
  });

  it('keeps a mark whose quote is not in the CV, without the quote', () => {
    const read = parseMarking(
      answer({ ...good, [tasks]: { mark: 70, quote: 'Inventé de toutes' } }),
      grid,
      CV,
    );
    expect(read?.reading.items[tasks]).toEqual({ mark: 70, quote: null });
  });

  it('takes an « éliminatoire » answer as proof, an ordinary one as declared', () => {
    const met = { [licence]: { status: 'MET', quote: 'Oui, permis B' } };
    const at = (over: object, items: object = met) =>
      parseMarking(answer(items), grid, CV, [
        { question: 'Permis B ?', answer: 'Oui, permis B', ...over },
      ])?.reading.items[licence].status;
    expect(at({ knockoutPassed: true })).toBe('MET');
    expect(at({ knockoutFailed: true })).toBe('MISSING');
    expect(at({})).toBe('UNCLEAR');
  });

  it('does not refuse a scan for want of text', () => {
    const read = parseMarking(answer(good), grid, null);
    expect(read?.reading.checked).toBe(false);
    expect(read?.reading.items[skills].found).toHaveLength(2);
    expect(read?.reading.items[diploma].status).toBe('UNCLEAR');
  });

  it('asks again when nothing of the grid is answered', () => {
    expect(parseMarking(answer({}), grid, CV)).toBeNull();
    expect(parseMarking(answer({ other: { mark: 90 } }), grid, CV)).toBeNull();
    expect(parseMarking('pas de JSON', grid, CV)).toBeNull();
    expect(parseMarking(answer({}, { isCv: false }), grid, CV)?.isCv).toBe(
      false,
    );
  });

  it('keeps the practical facts, without contacts', () => {
    const read = parseMarking(
      answer(good, {
        practical: {
          availability: 'Immédiate',
          expectedPay: null,
          mobility: 'Écrire à clarisse@example.com',
        },
      }),
      grid,
      CV,
    );
    expect(read?.reading.practical).toMatchObject({
      availability: 'Immédiate',
      expectedPay: null,
      contract: null,
    });
    expect(read?.reading.practical.mobility).not.toContain('@example.com');
  });
});

describe('evaluate', () => {
  const read = parseMarking(answer(good), grid, CV, [], NOW)!;

  it('makes the score from what was read', () => {
    const e = evaluate(grid, read.reading);
    // Skills 3 of 4, experience full, tasks 80, results not shown:
    // (3×75 + 3×100 + 2×80 + 1×0) / 9 = 685 / 9
    expect(e.marks).toEqual({
      [skills]: 75,
      [experience]: 100,
      [tasks]: 80,
      [results]: null,
    });
    expect(e.score).toBe(76);
    expect(e.musts).toEqual({
      [diploma]: 'MET',
      [licence]: 'UNCLEAR',
      [years]: 'MET',
    });
    expect(e.missing).toBe(0);
  });

  it('checks a minimum duration on the dates', () => {
    const at = (relevant: number | null, direct: number | null) =>
      evaluate(grid, {
        ...read.reading,
        relevantMonths: relevant,
        directMonths: direct,
      });
    expect(at(20, 20).musts[years]).toBe('MISSING');
    expect(at(null, null).musts[years]).toBe('UNCLEAR');
    expect(at(20, 20).missing).toBe(1);
    // Years in work only close to it are not years in the post.
    expect(at(60, 0).musts[years]).toBe('MISSING');
    expect(at(60, 36).musts[years]).toBe('MET');
  });

  it('is computed again for other importances, without the model', () => {
    const other = grid.map((i) =>
      i.key === results ? { ...i, importance: 0 as const } : i,
    );
    // (225 + 300 + 160) / 8
    expect(evaluate(other, read.reading).score).toBe(86);
  });
});

describe('gridBlock', () => {
  it('asks the model nothing the server computes or nobody counts', () => {
    const block = gridBlock(
      grid.map((i) =>
        i.key === results ? { ...i, importance: 0 as const } : i,
      ),
    );
    expect(block).toContain(`${skills} · liste`);
    expect(block).toContain(`${tasks} · note`);
    expect(block).toContain(`${licence} · exigence`);
    for (const key of [experience, results, years]) {
      expect(block).not.toContain(key);
    }
  });
});
