import { wrapEmailHtml } from '../templates/layout';
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
