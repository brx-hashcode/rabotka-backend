import { BadRequestException } from '@nestjs/common';
import {
  answerText,
  candidateQuestion,
  checkAnswers,
  normalizeQuestions,
  ownerQuestion,
} from '../offer-questions';

const permis = {
  id: 'q1',
  kind: 'YES_NO' as const,
  label: 'Avez-vous le permis B ?',
  options: [],
  required: true,
  knockout: true,
  accepted: ['yes'],
  position: 0,
};
const dispo = {
  id: 'q2',
  kind: 'CHOICE' as const,
  label: 'Disponibilité',
  options: ['Immédiate', 'Sous 1 mois', 'Plus tard'],
  required: true,
  knockout: true,
  accepted: ['Immédiate', 'Sous 1 mois'],
  position: 1,
};
const motivation = {
  id: 'q3',
  kind: 'SHORT_TEXT' as const,
  label: 'Pourquoi ce poste ?',
  options: [],
  required: false,
  knockout: false,
  accepted: [],
  position: 2,
};
const QUESTIONS = [permis, dispo, motivation];

describe('normalizeQuestions', () => {
  it('cleans and orders what the business asks', () => {
    const rows = normalizeQuestions([
      {
        kind: 'YES_NO',
        label: '  Avez-vous   le permis B ? ',
        knockout: true,
        accepted: ['yes'],
      },
      {
        kind: 'CHOICE',
        label: 'Langue',
        options: [' Lingala', 'Kituba', 'Lingala', ''],
        required: false,
      },
      { kind: 'SHORT_TEXT', label: 'Prétentions ?' },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        label: 'Avez-vous le permis B ?',
        knockout: true,
        accepted: ['yes'],
        required: true,
        position: 0,
      }),
      expect.objectContaining({
        options: ['Lingala', 'Kituba'],
        required: false,
        accepted: [],
        position: 1,
      }),
      expect.objectContaining({
        kind: 'SHORT_TEXT',
        required: true,
        position: 2,
      }),
    ]);
  });

  it('keeps an « éliminatoire » question asked', () => {
    const [q] = normalizeQuestions([
      {
        kind: 'YES_NO',
        label: 'Permis B ?',
        required: false,
        knockout: true,
        accepted: ['no'],
      },
    ]);
    expect(q.required).toBe(true);
  });

  it.each([
    [
      [
        { kind: 'YES_NO', label: 'Ok?' },
        ...Array(5).fill({ kind: 'YES_NO', label: 'Encore ?' }),
      ],
      /5 questions/,
    ],
    [[{ kind: 'YES_NO', label: 'a' }], /entre 3/],
    [[{ kind: 'CHOICE', label: 'Langue', options: ['Lingala'] }], /de 2 à 6/],
    [
      [
        {
          kind: 'CHOICE',
          label: 'Langue',
          options: ['A', 'B'],
          knockout: true,
          accepted: ['A', 'B'],
        },
      ],
      /sans les prendre toutes/,
    ],
    [
      [
        {
          kind: 'CHOICE',
          label: 'Langue',
          options: ['A', 'B'],
          knockout: true,
          accepted: ['C'],
        },
      ],
      /réponses acceptées/,
    ],
    [[{ kind: 'YES_NO', label: 'Permis ?', knockout: true }], /oui ou non/],
    [
      [{ kind: 'SHORT_TEXT', label: 'Motivation ?', knockout: true }],
      /ne peut pas être éliminatoire/,
    ],
    [[{ kind: 'YES_NO', label: 'Appelez le 06 123 45 67 ?' }], /coordonnées/],
  ])('refuses %j', (input, message) => {
    expect(() => normalizeQuestions(input as never)).toThrow(message);
  });
});

describe('question views', () => {
  it('never shows a candidate which answers are accepted', () => {
    const c = candidateQuestion(permis);
    expect(c).toEqual({
      id: 'q1',
      kind: 'YES_NO',
      label: 'Avez-vous le permis B ?',
      options: [],
      required: true,
    });
    expect(ownerQuestion(permis)).toMatchObject({
      knockout: true,
      accepted: ['yes'],
    });
  });
});

describe('checkAnswers', () => {
  it('asks nothing of an app that sends no answers', () => {
    expect(checkAnswers(QUESTIONS, undefined)).toEqual({
      rows: [],
      knockedOut: false,
    });
  });

  it('keeps the answers, and passes the right ones', () => {
    const r = checkAnswers(QUESTIONS, [
      { questionId: 'q2', value: 'Immédiate' },
      { questionId: 'q1', value: 'yes' },
      { questionId: 'q3', value: '  J’aime conduire  ' },
    ]);
    expect(r.knockedOut).toBe(false);
    expect(r.rows).toEqual([
      {
        question_id: 'q1',
        label: 'Avez-vous le permis B ?',
        kind: 'YES_NO',
        value: 'yes',
        passed: true,
      },
      {
        question_id: 'q2',
        label: 'Disponibilité',
        kind: 'CHOICE',
        value: 'Immédiate',
        passed: true,
      },
      {
        question_id: 'q3',
        label: 'Pourquoi ce poste ?',
        kind: 'SHORT_TEXT',
        value: 'J’aime conduire',
        passed: null,
      },
    ]);
  });

  it('flags a wrong « éliminatoire » answer without refusing it', () => {
    const r = checkAnswers(QUESTIONS, [
      { questionId: 'q1', value: 'no' },
      { questionId: 'q2', value: 'Plus tard' },
    ]);
    expect(r.knockedOut).toBe(true);
    expect(r.rows.map((x) => x.passed)).toEqual([false, false]);
  });

  it.each([
    [
      [{ questionId: 'q2', value: 'Immédiate' }],
      /Répondez à la question « Avez-vous le permis B/,
    ],
    [
      [
        { questionId: 'q1', value: 'peut-être' },
        { questionId: 'q2', value: 'Immédiate' },
      ],
      /oui ou par non/,
    ],
    [
      [
        { questionId: 'q1', value: 'yes' },
        { questionId: 'q2', value: 'Demain' },
      ],
      /une des réponses proposées/,
    ],
    [
      [
        { questionId: 'q1', value: 'yes' },
        { questionId: 'q2', value: 'Immédiate' },
        { questionId: 'q3', value: 'Appelez-moi au 06 123 45 67' },
      ],
      /coordonnées/,
    ],
  ])('refuses %j', (answers, message) => {
    expect(() => checkAnswers(QUESTIONS, answers)).toThrow(BadRequestException);
    expect(() => checkAnswers(QUESTIONS, answers)).toThrow(message);
  });

  it('reads yes and no as words', () => {
    expect(answerText({ kind: 'YES_NO', value: 'yes' })).toBe('Oui');
    expect(answerText({ kind: 'YES_NO', value: 'no' })).toBe('Non');
    expect(answerText({ kind: 'CHOICE', value: 'Immédiate' })).toBe(
      'Immédiate',
    );
  });
});

describe('long answers, numbers and dates', () => {
  const years = {
    id: 'n1',
    kind: 'NUMBER' as const,
    label: 'Années d’expérience',
    options: [],
    required: true,
    knockout: true,
    accepted: ['3'],
    position: 0,
  };
  const start = {
    id: 'd1',
    kind: 'DATE' as const,
    label: 'Disponible à partir du',
    options: [],
    required: true,
    knockout: true,
    accepted: ['2026-12-01'],
    position: 1,
  };
  const letter = {
    id: 'l1',
    kind: 'LONG_TEXT' as const,
    label: 'Lettre de motivation',
    options: [],
    required: false,
    knockout: false,
    accepted: [],
    position: 2,
  };

  it('keeps the minimum and the latest date of « éliminatoires »', () => {
    const [n, d] = normalizeQuestions([
      { ...years, accepted: ['2,5'] },
      { ...start },
    ]);
    expect(n.accepted).toEqual(['2.5']);
    expect(d.accepted).toEqual(['2026-12-01']);
  });

  it('refuses an « éliminatoire » with no threshold, or on a long answer', () => {
    expect(() => normalizeQuestions([{ ...years, accepted: [] }])).toThrow(
      'minimum',
    );
    expect(() =>
      normalizeQuestions([{ ...start, accepted: ['01/12/2026'] }]),
    ).toThrow('date limite');
    expect(() => normalizeQuestions([{ ...letter, knockout: true }])).toThrow(
      BadRequestException,
    );
  });

  it('passes the minimum and an early enough date, and flags the rest', () => {
    const ok = checkAnswers(
      [years, start],
      [
        { questionId: 'n1', value: '3' },
        { questionId: 'd1', value: '2026-11-20' },
      ],
    );
    expect(ok.knockedOut).toBe(false);

    const late = checkAnswers(
      [years, start],
      [
        { questionId: 'n1', value: '1,5' },
        { questionId: 'd1', value: '2027-01-10' },
      ],
    );
    expect(late.rows.map((r) => r.passed)).toEqual([false, false]);
    expect(late.rows[0].value).toBe('1.5');
  });

  it('refuses what is not a number or a date', () => {
    expect(() =>
      checkAnswers([years], [{ questionId: 'n1', value: 'trois' }]),
    ).toThrow('nombre');
    expect(() =>
      checkAnswers([start], [{ questionId: 'd1', value: '2026-02-30' }]),
    ).toThrow('date');
  });

  it('takes a cover letter past the short-answer limit', () => {
    const value = 'Bonjour. '.repeat(100);
    const r = checkAnswers([letter], [{ questionId: 'l1', value }]);
    expect(r.rows[0].value).toBe(value.trim());
    expect(() =>
      checkAnswers([letter], [{ questionId: 'l1', value: 'x'.repeat(3001) }]),
    ).toThrow('3000');
  });

  it('writes a date out for the business', () => {
    expect(answerText({ kind: 'DATE', value: '2026-12-01' })).toBe(
      '1 décembre 2026',
    );
  });
});
