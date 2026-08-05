/**
 * Regenerates `src/modules/geo/data/geo-dataset.json` from GeoNames.
 *
 * The output is CHECKED IN and this script is not part of the build. Onboarding
 * is the most critical funnel in the product and runs over unreliable mobile
 * data — it must not be able to fail because someone else's API is down, rate
 * limiting us, or slow. So the list ships with the image and this script only
 * runs when a human decides to refresh it.
 *
 * Coverage is `cities500` — every populated place above 500 inhabitants,
 * worldwide. A 15 000 floor would have been a tenth of the size, but it knows
 * only 23 places in Congo, so most people here could not find the town they
 * actually live in. Applying the same fine floor everywhere rather than to a
 * short list of "focus" countries keeps that from being true for the next
 * market too — a user is never told their own town does not exist.
 *
 * Country names come from Node's own ICU data (`Intl.DisplayNames` in French),
 * not from GeoNames — no dependency, and they match what the rest of the app
 * shows the user.
 *
 * Data: GeoNames (https://www.geonames.org), CC BY 4.0.
 *
 * Invoke tsx directly, NOT through pnpm: pnpm's verifyDepsBeforeRun check runs
 * first and reinstalls node_modules whenever the lockfile looks out of step,
 * which on a server turns a read-only report into a several-minute install.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/build-geo-dataset.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Relative to the repo root — this is a `node_modules/.bin/tsx scripts/…` script. */
const OUT = join(process.cwd(), 'src/modules/geo/data/geo-dataset.json');

const BASE = 'https://download.geonames.org/export/dump';

// Absolute, so the tools resolved here can't depend on an inherited PATH.
const CURL = '/usr/bin/curl';
const UNZIP = '/usr/bin/unzip';

/** GeoNames dump columns we care about, by index. */
const COL = { name: 1, countryCode: 8, population: 14 } as const;

function download(work: string, file: string): string {
  const zip = join(work, file);
  console.log(`  ↓ ${file}`);
  execFileSync(CURL, ['-sSf', '-o', zip, `${BASE}/${file}`]);
  execFileSync(UNZIP, ['-o', '-q', zip, '-d', work]);
  return readFileSync(join(work, file.replace('.zip', '.txt')), 'utf8');
}

/** `{ CG: Set<'Brazzaville'|…> }`. A Set, so repeated names collapse. */
function collect(tsv: string, into: Map<string, Set<string>>): void {
  for (const line of tsv.split('\n')) {
    if (!line) continue;
    const cols = line.split('\t');
    const country = cols[COL.countryCode];
    const name = cols[COL.name]?.trim();
    if (!country || !name) continue;
    // Population 0 means GeoNames has no figure; those rows are mostly
    // administrative entries rather than places someone would name as home.
    if (Number(cols[COL.population]) <= 0) continue;
    let set = into.get(country);
    if (!set) {
      set = new Set();
      into.set(country, set);
    }
    set.add(name);
  }
}

function main(): void {
  const work = mkdtempSync(join(tmpdir(), 'rabotka-geo-'));
  try {
    console.log('Building the country/city dataset from GeoNames…');

    const cities = new Map<string, Set<string>>();
    collect(download(work, 'cities500.zip'), cities);

    console.log('  ↓ countryInfo.txt');
    const info = execFileSync(CURL, [
      '-sSf',
      `${BASE}/countryInfo.txt`,
    ]).toString('utf8');

    const french = new Intl.DisplayNames(['fr'], { type: 'region' });

    const countries: { code: string; name: string }[] = [];
    for (const line of info.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const code = line.split('\t')[0];
      if (!/^[A-Z]{2}$/.test(code)) continue;
      // `of()` returns the input unchanged for a code ICU doesn't know; those
      // would surface as a bare "XK" in the combobox, so drop them.
      const name = french.of(code);
      if (!name || name === code) continue;
      countries.push({ code, name });
    }
    countries.sort((a, b) => a.name.localeCompare(b.name, 'fr'));

    const citiesByCountry: Record<string, string[]> = {};
    for (const [code, set] of [...cities].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      citiesByCountry[code] = [...set].sort((a, b) => a.localeCompare(b, 'fr'));
    }

    writeFileSync(
      OUT,
      JSON.stringify({
        source: 'GeoNames (https://www.geonames.org), CC BY 4.0',
        generatedAt: new Date().toISOString().slice(0, 10),
        countries,
        cities: citiesByCountry,
      }) + '\n',
    );

    const total = Object.values(citiesByCountry).reduce(
      (n, l) => n + l.length,
      0,
    );
    console.log(
      `\n${countries.length} countries, ${total} cities → ${OUT}\n` +
        `Congo: ${citiesByCountry.CG?.length ?? 0} cities.`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
