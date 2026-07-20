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
