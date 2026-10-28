import {
  gonePage,
  listingPage,
  listingPath,
  offerPage,
  sitemapXml,
} from '../job-pages.render';
import type { Listing } from '../job-pages.service';
import { row } from './offer-row.fixture';

const SITE = 'https://rabotka.work';

function listing(over: Partial<Listing> = {}): Listing {
  return {
    city: { slug: 'brazzaville', name: 'Brazzaville', count: 1 },
    trade: null,
    offers: [row()],
    total: 1,
    page: 1,
    pages: 1,
    cities: [{ slug: 'brazzaville', name: 'Brazzaville', count: 1 }],
    trades: [
      { slug: 'livraison-courses', name: 'Livraison & Courses', count: 1 },
    ],
    ...over,
  };
}

describe('job pages render', () => {
  it('renders an offer with its JobPosting, canonical and apply link', () => {
    const html = offerPage(
      SITE,
      row({ title: 'Chauffeur <script>' }),
      [],
      [],
      'brazzaville',
    );
    expect(html).toContain(
      '<link rel="canonical" href="https://rabotka.work/emplois/offre/chauffeur-script-brazzaville-',
    );
    expect(html).toContain('"@type":"JobPosting"');
    expect(html).toContain(
      'href="/offres/a2a59adb-b517-48af-ab5c-b5cff8aa5529"',
    );
    expect(html).toContain('Chauffeur &lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('index, follow');
  });

  it('never lets JSON-LD close its script tag', () => {
    const html = offerPage(
      SITE,
      row({ title: '</script><img src=x>' }),
      [],
      [],
      null,
    );
    const ld = html
      .split('<script type="application/ld+json">')[1]
      .split('</script>')[0];
    expect(ld).not.toContain('<');
  });

  it('masks contact details on the page', () => {
    const html = offerPage(
      SITE,
      row({ description: 'WhatsApp 06 991 66 44' }),
      [],
      [],
      null,
    );
    expect(html).not.toContain('991');
  });

  it('marks a closed offer noindex', () => {
    expect(gonePage(SITE, row(), [], [])).toContain('noindex, follow');
  });

  it('renders a listing, and noindex when empty', () => {
    const html = listingPage(SITE, listing());
    expect(html).toContain('<h1>Offres d&#39;emploi à Brazzaville</h1>');
    expect(html).toContain(
      'content="1 offre d&#39;emploi à Brazzaville sur Rabotka.',
    );
    expect(html).toContain('href="/emplois/brazzaville/livraison-courses"');
    expect(html).not.toContain('noindex');
    expect(listingPage(SITE, listing({ offers: [], total: 0 }))).toContain(
      'noindex',
    );
  });

  it('builds listing paths', () => {
    expect(listingPath({})).toBe('/emplois');
    expect(listingPath({ city: { slug: 'dolisie' } }, 2)).toBe(
      '/emplois/dolisie?page=2',
    );
    expect(
      listingPath({ city: { slug: 'dolisie' }, trade: { slug: 'menuiserie' } }),
    ).toBe('/emplois/dolisie/menuiserie');
    expect(listingPath({ trade: { slug: 'menuiserie' } }, 3)).toBe(
      '/emplois?metier=menuiserie&page=3',
    );
  });

  it('writes the sitemap with absolute urls', () => {
    const xml = sitemapXml(SITE, [
      { path: '/emplois', lastmod: new Date('2026-10-28T00:00:00Z') },
    ]);
    expect(xml).toContain(
      '<loc>https://rabotka.work/emplois</loc><lastmod>2026-10-28T00:00:00.000Z</lastmod>',
    );
  });
});
