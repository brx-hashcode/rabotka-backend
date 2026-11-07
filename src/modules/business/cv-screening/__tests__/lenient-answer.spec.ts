import { answerSnippet } from '../lenient-answer';

describe('answerSnippet', () => {
  it('keeps the start of an answer, without contact details', () => {
    const out = answerSnippet(
      'Voici : {"candidate": {"email": "awa.ngoma@mail.cg", "phone": "+242 06 123 45 67"}}',
    );
    expect(out).not.toContain('awa.ngoma@mail.cg');
    expect(out).not.toContain('123 45 67');
    expect(out).toContain('[e-mail]');
    expect(out).toContain('[téléphone]');
    expect(answerSnippet('x'.repeat(1000))).toHaveLength(300);
  });
});
