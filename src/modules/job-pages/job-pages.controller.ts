import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { clientAppUrl } from '../mail/audience';
import {
  cityFacets,
  cityOf,
  offerIdFromParam,
  offerPath,
} from './job-page-model';
import {
  gonePage,
  listingPage,
  notFoundPage,
  offerPage,
  sitemapXml,
} from './job-pages.render';
import { JobPagesService } from './job-pages.service';

/**
 * The public job pages of the candidate site: `/emplois…` there is forwarded
 * here (`vite.config.ts` in rabotka-client) as `/api/v1/public/emplois…`.
 *
 * HTML, not JSON: what search engines and link previews read. The candidate
 * site names its own origin in `X-Rabotka-Site` so the canonical links point
 * at it; called directly, the pages fall back to FRONTEND_URL.
 */
@ApiExcludeController()
@Controller('public/emplois')
export class JobPagesController {
  constructor(private readonly pages: JobPagesService) {}

  @Public()
  @Get()
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  async all(
    @Req() req: Request,
    @Res() res: Response,
    @Query('page') page?: string,
    @Query('metier') trade?: string,
  ) {
    const site = siteOf(req);
    const listing = await this.pages.listing({
      trade: trade?.trim() || undefined,
      page: pageOf(page),
    });
    if (!listing) return sendHtml(res, 404, notFoundPage(site, '/emplois'));
    sendHtml(res, 200, listingPage(site, listing));
  }

  @Public()
  @Get('sitemap.xml')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async sitemap(@Req() req: Request, @Res() res: Response) {
    const entries = await this.pages.sitemap();
    res
      .status(200)
      .type('application/xml; charset=utf-8')
      .setHeader('Cache-Control', 'public, max-age=900');
    res.send(sitemapXml(siteOf(req), entries));
  }

  @Public()
  @Get('offre/:slug')
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  async offer(
    @Req() req: Request,
    @Res() res: Response,
    @Param('slug') slug: string,
  ) {
    const site = siteOf(req);
    const id = offerIdFromParam(slug);
    const found = id ? await this.pages.offer(id) : null;
    if (!found) {
      return sendHtml(res, 404, notFoundPage(site, `/emplois/offre/${slug}`));
    }
    const { offer, open } = found;
    // Old words in the url (the title changed): one address per offer.
    const path = offerPath(offer);
    if (`/emplois/offre/${slug}` !== path) {
      return res.redirect(301, path);
    }
    const [similar, listing] = await Promise.all([
      this.pages.similar(offer),
      this.pages.listing({ page: 1 }),
    ]);
    const cities = listing?.cities ?? [];
    if (!open) {
      // 410 tells search engines to drop it now rather than retry.
      return sendHtml(res, 410, gonePage(site, offer, similar, cities));
    }
    const city = cityOf(offer);
    const citySlug = city ? (cityFacets([city])[0]?.slug ?? null) : null;
    sendHtml(res, 200, offerPage(site, offer, similar, cities, citySlug));
  }

  @Public()
  @Get(':city')
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  async city(
    @Req() req: Request,
    @Res() res: Response,
    @Param('city') city: string,
    @Query('page') page?: string,
  ) {
    return this.list(req, res, { city, page: pageOf(page) });
  }

  @Public()
  @Get(':city/:trade')
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  async cityTrade(
    @Req() req: Request,
    @Res() res: Response,
    @Param('city') city: string,
    @Param('trade') trade: string,
    @Query('page') page?: string,
  ) {
    return this.list(req, res, { city, trade, page: pageOf(page) });
  }

  private async list(
    req: Request,
    res: Response,
    q: { city: string; trade?: string; page: number },
  ) {
    const site = siteOf(req);
    const listing = await this.pages.listing(q);
    if (!listing) {
      const path = `/emplois/${q.city}${q.trade ? `/${q.trade}` : ''}`;
      return sendHtml(res, 404, notFoundPage(site, path));
    }
    sendHtml(res, 200, listingPage(site, listing));
  }
}

const SITE = /^https?:\/\/[a-z0-9.-]+(:\d{2,5})?$/i;

/** The candidate site's origin, as it names itself, else FRONTEND_URL's. */
export function siteOf(req: Pick<Request, 'headers'>): string {
  const named = req.headers['x-rabotka-site'];
  const value = (Array.isArray(named) ? named[0] : named)
    ?.trim()
    .replace(/\/+$/, '');
  return value && SITE.test(value) ? value : clientAppUrl();
}

function pageOf(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '1', 10);
  return Number.isFinite(n) && n > 0 && n < 10_000 ? n : 1;
}

/**
 * Inline styles and JSON-LD only: no script runs on these pages. Images from
 * the site itself and the public storage (logos).
 */
const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'self' https: data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function sendHtml(res: Response, status: number, html: string): void {
  res
    .status(status)
    .type('text/html; charset=utf-8')
    .setHeader('Content-Security-Policy', CSP)
    .setHeader('X-Content-Type-Options', 'nosniff')
    // Short: an offer that closes should not linger in a shared cache.
    .setHeader(
      'Cache-Control',
      status === 200 ? 'public, max-age=300' : 'public, max-age=60',
    );
  res.send(html);
}
