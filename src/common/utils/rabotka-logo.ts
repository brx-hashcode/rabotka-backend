import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger } from '@nestjs/common';

/**
 * The Rabotka mark, inlined for PDF rendering.
 *
 * Puppeteer renders our documents from a string with no server behind it, so a
 * `<img src="/assets/...">` would resolve to nothing. The file has to travel
 * inside the markup as a data URI.
 *
 * Read once and cached for the life of the process: it is a few hundred
 * kilobytes and every report would otherwise re-read and re-encode it.
 *
 * A missing file is a warning, not an error — a report without the logo is
 * still a correct report, and failing the download over branding would be out
 * of proportion. `ResumeService` still carries its own copy of this logic; this
 * one exists so the consumption report did not add a third.
 */

const logger = new Logger('RabotkaLogo');

/** `''` means "already looked, not there" — distinct from "not looked yet". */
let cached: string | null = null;

export function rabotkaLogoDataUri(): string | null {
  if (cached !== null) return cached || null;

  try {
    const logoPath = path.join(process.cwd(), 'assets', 'rabotka-logo.png');
    const base64 = fs.readFileSync(logoPath).toString('base64');
    cached = `data:image/png;base64,${base64}`;
  } catch {
    logger.warn(
      'Rabotka logo not found at assets/rabotka-logo.png — rendering without it.',
    );
    cached = '';
  }

  return cached || null;
}
