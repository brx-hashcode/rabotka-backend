import { BadRequestException } from '@nestjs/common';
import { OfferQuestionKind } from '@prisma/client';
import { detectContacts } from '../profile-chat/moderation/detect';

/**
 * « Questions aux candidats »: a few questions an offer asks when a candidate
 * applies, some of them « éliminatoires ». Pure rules, shared by the offer
 * (what a business may ask) and the application (what a candidate answered).
 */

export const MAX_QUESTIONS = 5;
export const LABEL_MAX = 140;
export const OPTION_MAX = 60;
export const ANSWER_MAX = 300;
export const YES = 'yes';
export const NO = 'no';

export type QuestionInput = {
  kind: OfferQuestionKind;
  label: string;
  options?: string[];
  required?: boolean;
  knockout?: boolean;
  accepted?: string[];
};

export type QuestionRow = {
  kind: OfferQuestionKind;
  label: string;
  options: string[];
  required: boolean;
  knockout: boolean;
  accepted: string[];
  position: number;
};

type StoredQuestion = QuestionRow & { id: string };

const bad = (message: string) => new BadRequestException(message);

/** The business's questions, cleaned and checked, ready to store. */
export function normalizeQuestions(input: QuestionInput[]): QuestionRow[] {
  if (input.length > MAX_QUESTIONS) {
    throw bad(`${MAX_QUESTIONS} questions au plus par offre.`);
  }
  return input.map((q, position) => {
    const label = q.label?.trim().replace(/\s+/g, ' ') ?? '';
    if (label.length < 3 || label.length > LABEL_MAX) {
      throw bad(`Chaque question fait entre 3 et ${LABEL_MAX} caractères.`);
    }
    if (detectContacts(label).length > 0) {
      throw bad('Une question ne peut pas contenir de coordonnées.');
    }
    const knockout = !!q.knockout;
    let options: string[] = [];
    let accepted: string[] = [];

    if (q.kind === OfferQuestionKind.CHOICE) {
      options = [
        ...new Set((q.options ?? []).map((o) => o.trim()).filter(Boolean)),
      ];
      if (options.length < 2 || options.length > 6) {
        throw bad(`« ${label} » : proposez de 2 à 6 réponses.`);
      }
      if (options.some((o) => o.length > OPTION_MAX)) {
        throw bad(
          `Une réponse proposée fait ${OPTION_MAX} caractères au plus.`,
        );
      }
      if (knockout) {
        accepted = [...new Set(q.accepted ?? [])].filter((a) =>
          options.includes(a),
        );
        if (accepted.length === 0 || accepted.length === options.length) {
          throw bad(
            `« ${label} » : choisissez les réponses acceptées, sans les prendre toutes.`,
          );
        }
      }
    } else if (q.kind === OfferQuestionKind.YES_NO) {
      if (knockout) {
        const want = q.accepted?.[0];
        if (want !== YES && want !== NO) {
          throw bad(
            `« ${label} » : indiquez la réponse attendue (oui ou non).`,
          );
        }
        accepted = [want];
      }
    } else if (knockout) {
      throw bad('Une réponse libre ne peut pas être éliminatoire.');
    }

    return {
      kind: q.kind,
      label,
      options,
      // An « éliminatoire » question is always asked.
      required: knockout ? true : q.required !== false,
      knockout,
      accepted,
      position,
    };
  });
}

/** What a candidate sees: never which answers are accepted. */
export function candidateQuestion(q: StoredQuestion) {
  return {
    id: q.id,
    kind: q.kind,
    label: q.label,
    options: q.options,
    required: q.required,
  };
}

/** What the business sees, to edit its offer. */
export function ownerQuestion(q: StoredQuestion) {
  return {
    ...candidateQuestion(q),
    knockout: q.knockout,
    accepted: q.accepted,
  };
}

export type AnswerInput = { questionId: string; value: string };

export type AnswerRow = {
  question_id: string;
  label: string;
  kind: OfferQuestionKind;
  value: string;
  passed: boolean | null;
};

/**
 * A candidate's answers against the offer's questions. `answers` undefined
 * (the mobile app, a field agent applying for someone) is no check at all:
 * the application simply has no answers. Given, they must be complete and
 * valid. A wrong answer to an « éliminatoire » question is not refused here:
 * the application is kept and flagged (`knockedOut`).
 */
export function checkAnswers(
  questions: StoredQuestion[],
  answers: AnswerInput[] | undefined,
): { rows: AnswerRow[]; knockedOut: boolean } {
  if (answers === undefined || questions.length === 0) {
    return { rows: [], knockedOut: false };
  }
  const byId = new Map(answers.map((a) => [a.questionId, a.value]));
  const rows: AnswerRow[] = [];

  for (const q of [...questions].sort((a, b) => a.position - b.position)) {
    const raw = byId.get(q.id);
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
      if (q.required) throw bad(`Répondez à la question « ${q.label} ».`);
      continue;
    }
    if (q.kind === OfferQuestionKind.YES_NO && value !== YES && value !== NO) {
      throw bad(`« ${q.label} » : répondez par oui ou par non.`);
    }
    if (q.kind === OfferQuestionKind.CHOICE && !q.options.includes(value)) {
      throw bad(`« ${q.label} » : choisissez une des réponses proposées.`);
    }
    if (q.kind === OfferQuestionKind.SHORT_TEXT) {
      if (value.length > ANSWER_MAX) {
        throw bad(`« ${q.label} » : ${ANSWER_MAX} caractères au plus.`);
      }
      if (detectContacts(value).length > 0) {
        throw bad(
          'Votre réponse ne peut pas contenir de coordonnées (téléphone, e-mail, lien) : retirez-les.',
        );
      }
    }
    rows.push({
      question_id: q.id,
      label: q.label,
      kind: q.kind,
      value,
      passed: q.knockout ? q.accepted.includes(value) : null,
    });
  }
  return { rows, knockedOut: rows.some((r) => r.passed === false) };
}

/** An answer as the business reads it. */
export function answerText(a: { kind: OfferQuestionKind; value: string }) {
  if (a.kind === OfferQuestionKind.YES_NO)
    return a.value === YES ? 'Oui' : 'Non';
  return a.value;
}
