-- More ways to answer an offer's questions: a cover letter, a number, a date.
ALTER TYPE "OfferQuestionKind" ADD VALUE 'LONG_TEXT';
ALTER TYPE "OfferQuestionKind" ADD VALUE 'NUMBER';
ALTER TYPE "OfferQuestionKind" ADD VALUE 'DATE';
