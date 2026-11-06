import { displayPhone, wrapEmailHtml } from '../templates/layout';
import {
  RABOTKA_LOGO_CID,
  rabotkaLogoBuffer,
} from '../templates/logo-asset';

describe('wrapEmailHtml', () => {
  it('references the logo as an inline attachment, not an external URL', () => {
    // The whole point: clients block external images by default, so a linked
    // logo is never seen unless the recipient opts in.
    const html = wrapEmailHtml('<p>hi</p>');

    expect(html).toContain(`src="cid:${RABOTKA_LOGO_CID}"`);
    expect(html).not.toContain('http://');
    expect(html).not.toContain('r2.dev');
  });

  it('keeps the alt text, which is what shows before images load', () => {
    expect(wrapEmailHtml('<p>hi</p>')).toContain('alt="Rabotka"');
  });

  it('aligns the logo left, flush with the content cell', () => {
    const html = wrapEmailHtml('<p>hi</p>');
    // 32px matches the content cell's padding, so the two line up.
    expect(html).toContain('align="left" style="padding:28px 32px 0;');
    expect(html).toContain('text-align:left;');
  });

  it('draws the logo at 36px', () => {
    const html = wrapEmailHtml('<p>hi</p>');
    expect(html).toContain('width="36" height="36"');
    expect(html).toContain('width:36px;height:36px;');
  });

  it('labels a business email « Business » beside the logo, and only that', () => {
    expect(wrapEmailHtml('<p>hi</p>', { product: 'business' })).toContain(
      '>Business</span>',
    );
    expect(wrapEmailHtml('<p>hi</p>')).not.toContain('>Business</span>');
  });

  it('does not depend on any environment variable', () => {
    // Regression guard: the logo used to come from CLOUDFLARE_PUBLIC_BASE_URL
    // read at module load, which is always unset that early in a real boot.
    const previous = process.env.CLOUDFLARE_PUBLIC_BASE_URL;
    delete process.env.CLOUDFLARE_PUBLIC_BASE_URL;
    try {
      const html = wrapEmailHtml('<p>hi</p>');
      expect(html).toContain(`src="cid:${RABOTKA_LOGO_CID}"`);
      expect(html).not.toContain('undefined');
    } finally {
      if (previous !== undefined) {
        process.env.CLOUDFLARE_PUBLIC_BASE_URL = previous;
      }
    }
  });

  it('renders content and footer', () => {
    const html = wrapEmailHtml('<p>hello</p>', {
      footer: { email: 'contact@rabotka.co' },
    });

    expect(html).toContain('<p>hello</p>');
    expect(html).toContain('contact@rabotka.co');
  });

  describe('footer', () => {
    const footer = {
      email: 'contact@rabotka.work',
      address: 'Brazzaville, Congo',
      legalName: 'Rabotka SARL',
      rccm: 'CG-BZV-01-2025-B12-00042',
      socials: [
        { network: 'facebook' as const, url: 'https://facebook.com/rabotka' },
        {
          network: 'linkedin' as const,
          url: 'https://linkedin.com/company/rabotka',
        },
      ],
    };

    it('shows the company, its RCCM, address, contact and legal links', () => {
      // No logo or tagline down there: the card's header already carries the brand.
      const html = wrapEmailHtml('<p>hi</p>', { footer });
      expect(html).toContain(
        'Rabotka SARL&nbsp;&middot;&nbsp;RCCM CG-BZV-01-2025-B12-00042',
      );
      expect(html).toContain('Brazzaville, Congo');
      expect(html).toContain('href="mailto:contact@rabotka.work"');
      expect(html).toContain('href="https://www.rabotka.work/terms"');
      expect(html).toContain('href="https://www.rabotka.work/privacy"');
      expect(html).toContain(
        `&copy; ${new Date().getFullYear()} Rabotka SARL.`,
      );
    });

    it('draws an icon per network set, embedded, linking to it', () => {
      const html = wrapEmailHtml('<p>hi</p>', { footer });
      expect(html).toContain('src="cid:rabotka-social-facebook"');
      expect(html).toContain('href="https://facebook.com/rabotka"');
      expect(html).toContain('alt="LinkedIn"');
      expect(html).not.toContain('rabotka-social-instagram');
    });

    it('leaves out what is not set: no RCCM, no address, no icons', () => {
      const html = wrapEmailHtml('<p>hi</p>', {
        footer: { email: 'contact@rabotka.work' },
      });
      expect(html).not.toContain('RCCM');
      expect(html).not.toContain('rabotka-social-');
      expect(html).toContain(`${new Date().getFullYear()} Rabotka.`);
    });

    it('points a business email to business.rabotka.work', () => {
      expect(
        wrapEmailHtml('<p>hi</p>', { footer, product: 'business' }),
      ).toContain('href="https://business.rabotka.work"');
      expect(wrapEmailHtml('<p>hi</p>', { footer })).toContain(
        'href="https://www.rabotka.work"',
      );
    });

    it('escapes what the settings hold', () => {
      const html = wrapEmailHtml('<p>hi</p>', {
        footer: { rccm: '<b>x</b>', address: '"><script>' },
      });
      expect(html).not.toContain('<script>');
      expect(html).toContain('RCCM &lt;b&gt;x&lt;/b&gt;');
    });
  });

  describe('displayPhone', () => {
    it('spaces a Congo number as people write it, leaves others alone', () => {
      expect(displayPhone('+242055183391')).toBe('+242 05 518 33 91');
      expect(displayPhone('+242 05 518 33 91')).toBe('+242 05 518 33 91');
      expect(displayPhone('+33 6 12 34 56 78')).toBe('+33 6 12 34 56 78');
    });

    it('shows it under « Besoin d’aide ? », dialable', () => {
      const html = wrapEmailHtml('<p>hi</p>', { footer: { phone: '+242055183391' } });
      expect(html).toContain('Besoin d’aide ?');
      expect(html).toContain('href="tel:+242055183391"');
      expect(html).toContain('+242 05 518 33 91');
    });
  });

  it('leaves the raw layout alone', () => {
    // rawLayout templates supply their own full markup; injecting a logo there
    // would duplicate whatever header they already draw.
    const html = wrapEmailHtml('<div>custom</div>', { rawLayout: true });

    expect(html).not.toContain(`cid:${RABOTKA_LOGO_CID}`);
    expect(html).toContain('<div>custom</div>');
  });

  it('escapes the preview text rather than trusting it', () => {
    const html = wrapEmailHtml('<p>hi</p>', {
      previewText: '<script>alert(1)</script>',
    });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('logo asset', () => {
  it('decodes to a real PNG', () => {
    const buf = rabotkaLogoBuffer();
    // PNG magic number — catches a truncated or corrupted base64 blob.
    expect(buf.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('stays small enough to ride on every email', () => {
    // The source image is 339 KB; shipping that on each send would be absurd.
    expect(rabotkaLogoBuffer().length).toBeLessThan(20 * 1024);
  });
});
