import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Country = { code: string; name: string };

type GeoDataset = {
  source: string;
  generatedAt: string;
  countries: Country[];
  cities: Record<string, string[]>;
};

/**
 * Read at runtime rather than `import`ed. The file is ~400 KB of literal data;
 * with `resolveJsonModule` the compiler would infer a type for all 33 000
 * strings on every build and every test run, for no benefit — the shape is
 * asserted once below instead.
 *
 * `__dirname` resolves under both `src/` (jest, tsx) and `dist/src/` (the
 * image), where nest-cli copies the file as a configured asset.
 */
const DATA = JSON.parse(
  readFileSync(join(__dirname, 'data', 'geo-dataset.json'), 'utf8'),
) as GeoDataset;

/**
 * The reference list of countries and their cities.
 *
 * Read straight from a checked-in JSON file rather than an external API. This
 * feeds the country/city pickers in onboarding — the most critical funnel in
 * the product, run over unreliable mobile data — and a third party being down,
 * slow or rate-limiting must not be able to stop someone registering. The file
 * ships with the image, so the list is available for exactly as long as the
 * server is.
 *
 * It is also why nothing here is cached: the data is already in memory, parsed
 * once at import. A Redis round-trip would be strictly slower than the lookup
 * it replaced.
 *
 * Regenerate with `npx tsx scripts/build-geo-dataset.ts`.
 */
@Injectable()
export class GeoService {
  private readonly logger = new Logger(GeoService.name);

  /** Lower-cased code → the canonical entry, so lookups are case-insensitive. */
  private readonly byCode = new Map<string, Country>(
    DATA.countries.map((c) => [c.code.toLowerCase(), c]),
  );

  constructor() {
    this.logger.log(
      `Geo dataset ${DATA.generatedAt}: ${DATA.countries.length} countries, ` +
        `${Object.values(DATA.cities).reduce((n, l) => n + l.length, 0)} cities`,
    );
  }

  /** Every country, already sorted by French name. */
  listCountries(): Country[] {
    return DATA.countries;
  }

  /** The country for an ISO 3166-1 alpha-2 code, or null. */
  findCountry(code: string | null | undefined): Country | null {
    if (!code) return null;
    return this.byCode.get(code.trim().toLowerCase()) ?? null;
  }

  /**
   * Cities for a country, sorted.
   *
   * Throws for a code we don't know, but returns `[]` for a real country the
   * dataset has no cities for (a handful of microstates) — those are two
   * different answers and a caller that conflates them shows "unknown country"
   * to someone from Monaco.
   */
  listCities(code: string): string[] {
    const country = this.findCountry(code);
    if (!country) {
      throw new NotFoundException(`Unknown country code: ${code}`);
    }
    return DATA.cities[country.code] ?? [];
  }

  /**
   * The dataset's own spelling of `city`, or `city` trimmed if we don't know it.
   *
   * Snapping to a canonical spelling is what keeps "brazzaville", "Brazzaville "
   * and "BRAZZAVILLE" from becoming three groups the first time anyone filters
   * by city. Returning the input unchanged rather than throwing is deliberate —
   * see `resolveLocation` below for why an unknown city must not be able to
   * block a save.
   */
  /**
   * Turns the location fields of a DTO into the columns to write.
   *
   * Validation is deliberately asymmetric.
   *
   * The **country code** is rejected outright when we don't know it. ISO
   * 3166-1 alpha-2 codes are stable — the reference list will never stop
   * containing `CG` — so a bad code can only mean a broken or hostile client,
   * and letting it through would put a value in the column that no filter can
   * ever match.
   *
   * The **city** is normalised but never rejected. City names do change between
   * dataset refreshes, and a returning user whose stored city was renamed
   * upstream would otherwise be unable to save at all — locked out by a change
   * they had no part in. Matching names are snapped to the canonical spelling
   * so filters group cleanly; a straggler is a cosmetic outlier, which is the
   * far cheaper failure.
   *
   * `countryName` is taken from our own list rather than from the client, so
   * the stored display name always agrees with the code beside it.
   */
  resolveLocation(dto: { countryCode?: string; city?: string }): {
    country_code?: string;
    country_name?: string;
    city?: string;
  } {
    const data: {
      country_code?: string;
      country_name?: string;
      city?: string;
    } = {};

    if (dto.countryCode !== undefined) {
      const country = this.findCountry(dto.countryCode);
      if (!country) {
        throw new BadRequestException(`Pays inconnu : ${dto.countryCode}`);
      }
      data.country_code = country.code;
      data.country_name = country.name;
    }

    if (dto.city !== undefined) {
      data.city = dto.city
        ? this.canonicalCity(dto.countryCode ?? null, dto.city)
        : dto.city;
    }

    return data;
  }

  canonicalCity(countryCode: string | null, city: string): string {
    const trimmed = city.trim();
    const country = this.findCountry(countryCode);
    if (!country) return trimmed;
    const target = trimmed.toLowerCase();
    return (
      (DATA.cities[country.code] ?? []).find(
        (c) => c.toLowerCase() === target,
      ) ?? trimmed
    );
  }
}
