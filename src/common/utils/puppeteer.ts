import type { Browser, Page } from 'puppeteer';

/**
 * Launch the headless browser used for HTML -> PDF rendering.
 *
 * Shared by ResumeService (the CV download) and DocumentService (the docx->pdf
 * fallback), which previously each inlined this call with slightly different
 * assumptions.
 *
 * The executable is resolved from PUPPETEER_EXECUTABLE_PATH, which the Docker
 * image points at Debian's `chromium`. Locally the variable is unset and
 * Puppeteer falls back to the browser its own postinstall downloaded — the
 * production image deliberately skips that download and installs the system
 * package instead, so it also gets Chromium's shared libraries from apt.
 */
export function browserLaunchOptions() {
  return {
    headless: true as const,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      // Chromium's sandbox needs privileges the container's non-root user
      // does not have.
      '--no-sandbox',
      '--disable-setuid-sandbox',
      // Docker gives a container 64MB of /dev/shm by default, which Chromium
      // exhausts on anything non-trivial and then crashes mid-render.
      '--disable-dev-shm-usage',
    ],
  };
}

/**
 * Fonts in, and a frame later: a page's own `fonts.ready` callbacks (the
 * poster fitting its text) have run by then.
 */
async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  });
}

export async function launchBrowser(): Promise<Browser> {
  // Imported lazily: Puppeteer is heavy, and a failure to load it should be
  // catchable by the caller rather than taking the whole app down at boot.
  const puppeteer = await import('puppeteer');
  return puppeteer.launch(browserLaunchOptions());
}

/**
 * An HTML document as an A4 PDF with the running footer of Rabotka's
 * reports (label on the left, page numbers on the right), as the WhatsApp
 * consumption report prints it. Throws whatever the browser threw; callers
 * log it and answer a generic error.
 */
export async function htmlToPdf(
  html: string,
  footerLabel: string,
  opts: {
    /** The running footer with page numbers; off for a one-page poster. */
    pageNumbers?: boolean;
    /** All four sides; a full-bleed page passes '0'. */
    margin?: string;
  } = {},
): Promise<Buffer> {
  const { pageNumbers = true } = opts;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    // `setContent` performs no navigation, so 'networkidle0' would never
    // settle; 'load' waits for the Google Fonts stylesheet.
    await page.setContent(html, { waitUntil: 'load' });
    await settle(page);
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: pageNumbers,
      headerTemplate: '<span></span>',
      footerTemplate: `
        <div style="width:100%; padding:0 15mm; display:flex; justify-content:space-between;
                    font-family:'Space Grotesk','Helvetica Neue',Arial,sans-serif;
                    font-size:7px; font-weight:500; letter-spacing:0.16em;
                    text-transform:uppercase; color:#9AA49E;">
          <span>Rabotka&nbsp;&nbsp;·&nbsp;&nbsp;${footerLabel}</span>
          <span>P&nbsp;|&nbsp;<span class="pageNumber"></span>&nbsp;/&nbsp;<span class="totalPages"></span></span>
        </div>`,
      margin:
        opts.margin === undefined
          ? { top: '16mm', right: '15mm', bottom: '18mm', left: '15mm' }
          : {
              top: opts.margin,
              right: opts.margin,
              bottom: opts.margin,
              left: opts.margin,
            },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

/**
 * An HTML document as a PNG of the top left `width` x `height` CSS pixels,
 * once its fonts are in, drawn at `scale` times that: at 2 (the default) the
 * text stays sharp on a retina screen and when zoomed, and the networks scale
 * it down to their own size.
 */
export async function htmlToImage(
  html: string,
  size: { width: number; height: number },
  scale = 2,
): Promise<Buffer> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ ...size, deviceScaleFactor: scale });
    await page.setContent(html, { waitUntil: 'load' });
    await settle(page);
    const png = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, ...size },
    });
    return Buffer.from(png);
  } finally {
    await browser.close();
  }
}
