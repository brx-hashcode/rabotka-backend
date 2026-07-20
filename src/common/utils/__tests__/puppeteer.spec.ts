import { browserLaunchOptions } from '../puppeteer';

describe('browserLaunchOptions', () => {
  const ORIGINAL_PATH = process.env.PUPPETEER_EXECUTABLE_PATH;

  afterEach(() => {
    if (ORIGINAL_PATH === undefined) {
      delete process.env.PUPPETEER_EXECUTABLE_PATH;
    } else {
      process.env.PUPPETEER_EXECUTABLE_PATH = ORIGINAL_PATH;
    }
  });

  // In the Docker image Chromium comes from apt, not from Puppeteer's own
  // download — so the executable has to be taken from the environment or the
  // launch fails with "Could not find Chromium".
  it('uses PUPPETEER_EXECUTABLE_PATH when set', () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = '/usr/bin/chromium';

    expect(browserLaunchOptions().executablePath).toBe('/usr/bin/chromium');
  });

  // Locally the variable is unset and Puppeteer must fall back to the browser
  // it downloaded itself, so the option has to be absent rather than ''.
  it('omits executablePath when the variable is unset', () => {
    delete process.env.PUPPETEER_EXECUTABLE_PATH;

    expect(browserLaunchOptions().executablePath).toBeUndefined();
  });

  it('treats an empty variable as unset', () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = '';

    expect(browserLaunchOptions().executablePath).toBeUndefined();
  });

  // Docker gives a container 64MB of /dev/shm; without this flag Chromium
  // exhausts it and crashes mid-render. The sandbox flags are required
  // because the container runs as a non-root user.
  it('always passes the container-safe flags', () => {
    const { args, headless } = browserLaunchOptions();

    expect(headless).toBe(true);
    expect(args).toEqual(
      expect.arrayContaining([
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ]),
    );
  });
});
