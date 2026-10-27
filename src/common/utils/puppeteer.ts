import type { Browser } from 'puppeteer';

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
): Promise<Buffer> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    // `setContent` performs no navigation, so 'networkidle0' would never
    // settle; 'load' waits for the Google Fonts stylesheet.
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `
        <div style="width:100%; padding:0 15mm; display:flex; justify-content:space-between;
                    font-family:'Space Grotesk','Helvetica Neue',Arial,sans-serif;
                    font-size:7px; font-weight:500; letter-spacing:0.16em;
                    text-transform:uppercase; color:#9AA49E;">
          <span>Rabotka&nbsp;&nbsp;·&nbsp;&nbsp;${footerLabel}</span>
          <span>P&nbsp;|&nbsp;<span class="pageNumber"></span>&nbsp;/&nbsp;<span class="totalPages"></span></span>
        </div>`,
      margin: { top: '16mm', right: '15mm', bottom: '18mm', left: '15mm' },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
