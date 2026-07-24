import { buildPortfolioReply, PORTFOLIO_UNAVAILABLE } from '../portfolio-link';
import { WHATSAPP_TEMPLATES } from '../../../../common/constants/whatsapp-templates';

describe('buildPortfolioReply', () => {
  it('encodes the CTA template with the worker name and slug', async () => {
    const portfolioService = {
      ensurePortfolioSlug: jest.fn().mockResolvedValue('alice-dupont-abc123'),
    } as never;

    const reply = await buildPortfolioReply(
      'worker-1',
      'Alice Dupont',
      portfolioService,
    );

    const sid = WHATSAPP_TEMPLATES.viewWorkerPortfolio.contentSid;
    expect(reply.startsWith(`[TPL:${sid}]`)).toBe(true);
    const vars = JSON.parse(reply.slice(`[TPL:${sid}]`.length)) as Record<
      string,
      string
    >;
    // {{1}} is the body name, {{2}} the URL suffix — the template's URL is
    // https://rabotka.work/p/{{2}}.
    expect(vars).toEqual({ '1': 'Alice Dupont', '2': 'alice-dupont-abc123' });
  });

  it('degrades to plain text instead of throwing when the slug fails', async () => {
    const portfolioService = {
      ensurePortfolioSlug: jest.fn().mockRejectedValue(new Error('db down')),
    } as never;

    const reply = await buildPortfolioReply(
      'worker-1',
      'Alice Dupont',
      portfolioService,
    );

    expect(reply).toBe(PORTFOLIO_UNAVAILABLE);
  });
});
