import {
  answerHtml,
  buildChatReportFilename,
  buildChatReportHtml,
  verdict,
  type ChatReportInput,
} from '../cv-chat-report';

const input = (over: Partial<ChatReportInput> = {}): ChatReportInput => ({
  businessName: 'ZuaFood',
  jobTitle: 'Hôtesse d’accueil — salon',
  candidates: [
    {
      name: 'Awa Diallo',
      title: 'Hôtesse',
      city: 'Brazzaville',
      yearsExperience: 5,
      score: 82,
      summary: 'Solide expérience.',
    },
  ],
  messages: [
    {
      role: 'user',
      content: 'Ses points faibles ?',
      createdAt: new Date('2026-10-27T10:00:00Z'),
    },
    {
      role: 'assistant',
      content: 'Deux :\n- **Anglais** limité\n- Loin du lieu',
      createdAt: new Date('2026-10-27T10:00:05Z'),
    },
  ],
  generatedAt: new Date('2026-10-27T12:00:00Z'),
  ...over,
});

describe('cv-chat-report', () => {
  it('prints the candidate, the question and the formatted answer', () => {
    const html = buildChatReportHtml(input());
    expect(html).toContain('ANALYSE DE CV');
    expect(html).toContain('Awa Diallo');
    expect(html).toContain('Très adapté');
    expect(html).toContain('Ses points faibles ?');
    expect(html).toContain('<strong');
    expect(html).toContain('1 question');
  });

  it('escapes what the AI and the business wrote', () => {
    const html = buildChatReportHtml(
      input({
        messages: [
          {
            role: 'user',
            content: '<script>x</script>',
            createdAt: new Date(),
          },
          { role: 'assistant', content: '**<b>**', createdAt: new Date() },
        ],
      }),
    );
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;');
  });

  it('titles a comparison with every candidate', () => {
    const two = input({
      candidates: [
        { ...input().candidates[0] },
        {
          name: 'Tessia N.',
          title: null,
          city: null,
          yearsExperience: null,
          score: 66,
          summary: null,
        },
      ],
    });
    const html = buildChatReportHtml(two);
    expect(html).toContain('COMPARAISON DE CV');
    expect(html).toContain('Awa Diallo · Tessia N.');
    expect(buildChatReportFilename(two)).toBe(
      'comparaison-cv-hotesse-d-accueil-salon-2026-10-27.pdf',
    );
  });

  it('names a one-CV file after the candidate', () => {
    expect(buildChatReportFilename(input())).toBe(
      'analyse-cv-awa-diallo-2026-10-27.pdf',
    );
  });

  it('turns « - » lines into a list and keeps paragraphs', () => {
    const html = answerHtml('Intro\nsuite\n\n- un\n- deux');
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html).toContain('Intro<br>suite');
  });

  it('words a score as the business space does', () => {
    expect([verdict(85), verdict(60), verdict(45), verdict(10)]).toEqual([
      'Très adapté',
      'Adapté',
      'Partiel',
      'Peu adapté',
    ]);
  });
});
