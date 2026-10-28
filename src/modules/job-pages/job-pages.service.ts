import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { clientAppUrl } from '../mail/audience';
import {
  cityFacets,
  cityOf,
  isOpen,
  offerPath,
  openOffersWhere,
  PAGE_SIZE,
  PUBLIC_OFFER_SELECT,
  type CityFacet,
  type PublicOfferRow,
} from './job-page-model';

export type TradeFacet = { slug: string; name: string; count: number };

export type Listing = {
  city: CityFacet | null;
  trade: { slug: string; name: string } | null;
  offers: PublicOfferRow[];
  total: number;
  page: number;
  pages: number;
  /** Other cities (with the trade, when one is picked). */
  cities: CityFacet[];
  /** Trades in the city (or everywhere). */
  trades: TradeFacet[];
};

export type SitemapEntry = { path: string; lastmod: Date };

/** Reads for the public job pages; see `job-page-model.ts` for what is public. */
@Injectable()
export class JobPagesService {
  constructor(private readonly prisma: PrismaService) {}

  /** One offer, open or not (the page says when it is no longer open). */
  async offer(
    id: string,
    now = new Date(),
  ): Promise<{ offer: PublicOfferRow; open: boolean } | null> {
    const offer = await this.prisma.jobOffer.findFirst({
      where: { id, deleted_at: null },
      select: PUBLIC_OFFER_SELECT,
    });
    if (!offer) return null;
    return { offer, open: isOpen(offer, now) };
  }

  /**
   * The offer's public page, for its owner to share; null while it is not
   * open (a closed offer's page says so and is not worth sending).
   */
  async publicUrl(id: string, now = new Date()): Promise<string | null> {
    const found = await this.offer(id, now);
    return found?.open ? `${clientAppUrl()}${offerPath(found.offer)}` : null;
  }

  /** A few open offers like this one: same trade, same city first. */
  async similar(o: PublicOfferRow, now = new Date(), take = 4) {
    const city = cityOf(o);
    const rows = await this.prisma.jobOffer.findMany({
      where: {
        AND: [
          openOffersWhere(now),
          { id: { not: o.id } },
          {
            OR: [
              ...(o.category ? [{ category: { slug: o.category.slug } }] : []),
              ...(city ? [this.inCities([city])] : []),
            ],
          },
        ],
      },
      orderBy: { created_at: 'desc' },
      take: 20,
      select: PUBLIC_OFFER_SELECT,
    });
    const score = (r: PublicOfferRow) =>
      (r.category?.slug === o.category?.slug ? 2 : 0) +
      (city && cityOf(r) === city ? 1 : 0);
    return rows.sort((a, b) => score(b) - score(a)).slice(0, take);
  }

  /**
   * A listing page: all open offers, in a city, or of a trade in a city.
   * Null when the city or the trade is unknown (no open offer there at all).
   */
  async listing(
    q: { city?: string; trade?: string; page: number },
    now = new Date(),
  ): Promise<Listing | null> {
    const open = openOffersWhere(now);
    const facets = cityFacets(await this.openCities(open));

    let cityWhere: Prisma.JobOfferWhereInput | null = null;
    let city: (CityFacet & { spellings: string[] }) | null = null;
    if (q.city) {
      city = facets.find((c) => c.slug === q.city) ?? null;
      if (!city) return null;
      cityWhere = this.inCities(city.spellings);
    }

    let trade: { id: string; slug: string; name: string } | null = null;
    if (q.trade) {
      trade = await this.prisma.jobCategory.findUnique({
        where: { slug: q.trade },
        select: { id: true, slug: true, name: true },
      });
      if (!trade) return null;
    }

    const where: Prisma.JobOfferWhereInput = {
      AND: [
        open,
        ...(cityWhere ? [cityWhere] : []),
        ...(trade ? [{ category_id: trade.id }] : []),
      ],
    };
    const page = Math.max(1, q.page);
    const [total, offers, trades] = await Promise.all([
      this.prisma.jobOffer.count({ where }),
      this.prisma.jobOffer.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: PUBLIC_OFFER_SELECT,
      }),
      this.trades({ AND: [open, ...(cityWhere ? [cityWhere] : [])] }),
    ]);

    // With a trade picked, the other cities that have it.
    const cities = trade
      ? cityFacets(
          await this.openCities({ AND: [open, { category_id: trade.id }] }),
        )
      : facets;

    return {
      city: city && { slug: city.slug, name: city.name, count: city.count },
      trade: trade && { slug: trade.slug, name: trade.name },
      offers,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      cities: cities.map(({ slug, name, count }) => ({ slug, name, count })),
      trades,
    };
  }

  /** Every page worth indexing: the listings that have offers, and each open offer. */
  async sitemap(now = new Date()): Promise<SitemapEntry[]> {
    const open = openOffersWhere(now);
    const rows = await this.prisma.jobOffer.findMany({
      where: open,
      orderBy: { created_at: 'desc' },
      take: 5000,
      select: {
        id: true,
        title: true,
        is_remote: true,
        city: true,
        updated_at: true,
        category: { select: { slug: true } },
        employer: { select: { city: true } },
      },
    });
    const latest = new Map<string, Date>();
    const touch = (path: string, d: Date) => {
      const seen = latest.get(path);
      if (!seen || seen < d) latest.set(path, d);
    };
    for (const r of rows) {
      touch('/emplois', r.updated_at);
      const city = cityOf(r);
      const citySlug = city ? cityFacets([city])[0]?.slug : undefined;
      if (citySlug) {
        touch(`/emplois/${citySlug}`, r.updated_at);
        if (r.category) {
          touch(`/emplois/${citySlug}/${r.category.slug}`, r.updated_at);
        }
      }
      touch(offerPath(r), r.updated_at);
    }
    return [...latest.entries()].map(([path, lastmod]) => ({ path, lastmod }));
  }

  /** An offer's own city, or its employer's when it gives none. */
  private inCities(spellings: string[]): Prisma.JobOfferWhereInput {
    return {
      is_remote: false,
      OR: [
        { city: { in: spellings } },
        { city: null, employer: { city: { in: spellings } } },
      ],
    };
  }

  private async openCities(
    where: Prisma.JobOfferWhereInput,
  ): Promise<(string | null)[]> {
    const rows = await this.prisma.jobOffer.findMany({
      where,
      select: {
        is_remote: true,
        city: true,
        employer: { select: { city: true } },
      },
      take: 5000,
    });
    return rows.map(cityOf);
  }

  private async trades(
    where: Prisma.JobOfferWhereInput,
  ): Promise<TradeFacet[]> {
    const grouped = await this.prisma.jobOffer.groupBy({
      by: ['category_id'],
      where: { AND: [where, { category_id: { not: null } }] },
      _count: { _all: true },
    });
    const ids = grouped
      .map((g) => g.category_id)
      .filter((id): id is string => !!id);
    if (ids.length === 0) return [];
    const categories = await this.prisma.jobCategory.findMany({
      where: { id: { in: ids } },
      select: { id: true, slug: true, name: true },
    });
    const count = new Map(grouped.map((g) => [g.category_id, g._count._all]));
    return categories
      .map((c) => ({ slug: c.slug, name: c.name, count: count.get(c.id) ?? 0 }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'fr'));
  }
}
