import { JobPagesController, siteOf } from '../job-pages.controller';
import { row } from './offer-row.fixture';

const ID = 'a2a59adb-b517-48af-ab5c-b5cff8aa5529';
const req = { headers: { 'x-rabotka-site': 'https://rabotka.work' } } as any;

function res() {
  const r: any = { headers: {} as Record<string, string> };
  r.status = jest.fn(() => r);
  r.type = jest.fn(() => r);
  r.setHeader = jest.fn((k: string, v: string) => ((r.headers[k] = v), r));
  r.send = jest.fn();
  r.redirect = jest.fn();
  return r;
}

function setup(found: { offer: ReturnType<typeof row>; open: boolean } | null) {
  const pages = {
    offer: jest.fn().mockResolvedValue(found),
    similar: jest.fn().mockResolvedValue([]),
    listing: jest.fn().mockResolvedValue(null),
  };
  return { pages, ctrl: new JobPagesController(pages as any) };
}

describe('JobPagesController', () => {
  it('takes the site from the proxy header, only when it is an origin', () => {
    expect(siteOf(req)).toBe('https://rabotka.work');
    process.env.FRONTEND_URL = 'https://www.rabotka.work/';
    expect(
      siteOf({ headers: { 'x-rabotka-site': 'javascript:alert(1)' } }),
    ).toBe('https://www.rabotka.work');
    expect(siteOf({ headers: {} })).toBe('https://www.rabotka.work');
  });

  it('serves an open offer with a 200 and a strict CSP', async () => {
    const { ctrl } = setup({ offer: row(), open: true });
    const r = res();
    await ctrl.offer(req, r, `chauffeur-livreur-brazzaville-${ID}`);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.headers['Content-Security-Policy']).toContain(
      "default-src 'none'",
    );
    expect(r.send.mock.calls[0][0]).toContain('JobPosting');
  });

  it('redirects old words to the one address', async () => {
    const { ctrl } = setup({ offer: row(), open: true });
    const r = res();
    await ctrl.offer(req, r, `ancien-titre-${ID}`);
    expect(r.redirect).toHaveBeenCalledWith(
      301,
      `/emplois/offre/chauffeur-livreur-brazzaville-${ID}`,
    );
  });

  it('answers 410 for a closed offer, 404 for an unknown one', async () => {
    const closed = setup({ offer: row(), open: false });
    const r = res();
    await closed.ctrl.offer(req, r, `chauffeur-livreur-brazzaville-${ID}`);
    expect(r.status).toHaveBeenCalledWith(410);

    const missing = setup(null);
    const r2 = res();
    await missing.ctrl.offer(req, r2, 'pas-un-id');
    expect(r2.status).toHaveBeenCalledWith(404);
    expect(missing.pages.offer).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown city', async () => {
    const { ctrl } = setup(null);
    const r = res();
    await ctrl.city(req, r, 'atlantis');
    expect(r.status).toHaveBeenCalledWith(404);
  });
});
