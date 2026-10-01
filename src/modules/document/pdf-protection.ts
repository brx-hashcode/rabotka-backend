import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from '@nestjs/common';

const execFileAsync = promisify(execFile);

/** qpdf's exit code for "done, with warnings" — the output is written. */
const QPDF_EXIT_WARNINGS = 3;

const QPDF_TIMEOUT_MS = 30_000;

/**
 * The qpdf command line that protects one generated PDF.
 *
 * - **No user password** (the empty string): anyone the PDF is sent to opens
 *   it normally. Only what they may DO with it is restricted.
 * - **A random owner password nobody holds.** The owner password lifts the
 *   restrictions, and nothing in Rabotka ever needs to lift them: a document
 *   is re-rendered, never edited.
 * - **256-bit AES**, qpdf's current strength.
 * - Printing allowed in full; editing and copying text out are not.
 *
 * Written out by hand rather than through `node-qpdf`, which this replaced:
 * that library pushes `options.password` straight onto the command line, so
 * the `{ owner, user }` object it was given became the literal text
 * "[object Object]" — as BOTH passwords, meaning every PDF would have asked
 * its recipient for a password to open it. Its restriction names (`copy`,
 * `useSubset`) are not qpdf flags either. None of it ever ran in production
 * only because the qpdf binary was not installed.
 */
export function qpdfEncryptArgs(
  ownerPassword: string,
  inputPath: string,
  outputPath: string,
): string[] {
  return [
    '--encrypt',
    '',
    ownerPassword,
    '256',
    '--print=full',
    '--modify=none',
    '--extract=n',
    '--',
    inputPath,
    outputPath,
  ];
}

type Run = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<unknown>;

/**
 * Protect a generated PDF against editing and copying, or hand it back as it
 * was if that cannot be done.
 *
 * Never throws for a protection failure: the contract or invoice reaching the
 * person matters more than its restrictions, so a failure is logged loudly and
 * the unprotected document is delivered.
 */
export async function protectPdf(
  pdf: Buffer,
  logger: Pick<Logger, 'warn' | 'error'>,
  run: Run = execFileAsync,
): Promise<Buffer> {
  // Random file names: two PDFs protected at the same moment must not read or
  // overwrite each other's files.
  const id = `${Date.now()}_${randomBytes(6).toString('hex')}`;
  const inputPath = join(tmpdir(), `rabotka_${id}_in.pdf`);
  const outputPath = join(tmpdir(), `rabotka_${id}_out.pdf`);
  const owner = randomBytes(24).toString('base64url');

  try {
    await writeFile(inputPath, pdf);
    try {
      await run('qpdf', qpdfEncryptArgs(owner, inputPath, outputPath), {
        timeout: QPDF_TIMEOUT_MS,
      });
    } catch (err: unknown) {
      const code = (err as { code?: unknown }).code;
      if (code === 'ENOENT') {
        logger.warn(
          'qpdf is not installed — delivering the PDF without protection',
        );
        return pdf;
      }
      // Exit 3 is success with warnings; the protected file is there.
      if (code !== QPDF_EXIT_WARNINGS) throw err;
    }
    return await readFile(outputPath);
  } catch (err: unknown) {
    logger.error(
      `PDF protection failed — delivering the PDF without protection: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return pdf;
  } finally {
    await unlink(inputPath).catch(() => undefined);
    await unlink(outputPath).catch(() => undefined);
  }
}
