import { RABOTKA_LOGO_CID } from './logo-asset';
import {
  SOCIAL_LABELS,
  socialIconCid,
  type SocialNetwork,
} from './social-icons-asset';

/** The foot of every email, from Settings → Contact (getEmailFooterInfo). */
export type FooterInfo = {
  email?: string | null;
  address?: string | null;
  phone?: string | null;
  /** « Rabotka SARL »: the company the RCCM belongs to. */
  legalName?: string | null;
  rccm?: string | null;
  /** Only those with a link set, in the order to show them. */
  socials?: { network: SocialNetwork; url: string }[];
};

/** Where the terms and the privacy policy live, whatever the product. */
const LEGAL_SITE = 'https://www.rabotka.work';

export type EmailLayoutOptions = {
  previewText?: string;
  rawLayout?: boolean;
  footer?: FooterInfo;
  /**
   * « Business » beside the logo, as the dashboard's header lockup: every
   * email to a business carries it, so it never reads as the worker app's.
   */
  product?: 'business';
};

export function wrapEmailHtml(
  content: string,
  options?: EmailLayoutOptions,
): string {
  const previewText = options?.previewText ?? '';
  const previewSpan = previewText
    ? `<span style="display:none;max-height:0;overflow:hidden;">${escapeHtml(previewText)}</span>`
    : '';
  const footer = options?.footer;

  if (options?.rawLayout) {
    return `<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Ubuntu:wght@400;500;600&display=swap" rel="stylesheet">
  </head>
  <body style="margin:0;padding:0;">
    ${previewSpan}
    ${content}
  </body>
</html>`;
  }

  return `<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Ubuntu:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
      body { margin: 0; padding: 0; background-color: #f5f4ef; }
      @media only screen and (max-width: 640px) {
        .rk-card { width: 100% !important; border-radius: 0 !important; border-left: none !important; border-right: none !important; }
        .rk-foot { width: 100% !important; }
      }
    </style>
  </head>
  <body bgcolor="#f5f4ef" style="margin:0;padding:0;background-color:#f5f4ef;font-family:'Ubuntu',sans-serif;">
    ${previewSpan}
    <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f5f4ef" style="background-color:#f5f4ef;">
      <tr>
        <td align="center" valign="top" style="padding:40px 16px 64px;">

          <!-- Card -->
          <table class="rk-card" width="600" cellpadding="0" cellspacing="0" bgcolor="#ffffff"
            style="border-collapse:collapse;background:#ffffff;border:1px solid #e6e4dd;border-radius:8px;overflow:hidden;">

            <!-- Logo. width/height are set as attributes as well as inline
                 styles because Outlook ignores the CSS; alt carries the brand
                 when a client blocks images, which most do by default. The
                 32px left padding matches the content cell below, so the logo
                 lines up with the body text. align + text-align because some
                 clients honour only one of the two. -->
            <tr>
              <td align="left" style="padding:28px 32px 0;text-align:left;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td valign="middle">
                      <img src="cid:${RABOTKA_LOGO_CID}" width="36" height="36" alt="Rabotka"
                        style="display:block;width:36px;height:36px;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;">
                    </td>${
                      options?.product === 'business'
                        ? `
                    <td valign="middle" style="padding-left:12px;">
                      <span style="display:inline-block;padding-left:12px;border-left:1px solid #d9d7cf;font-family:'Ubuntu',sans-serif;font-size:17px;line-height:24px;color:#2a322e;">Business</span>
                    </td>`
                        : ''
                    }
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Content -->
            <tr>
              <td style="padding:32px;font-size:16px;color:#2a322e;line-height:1.7;font-family:'Ubuntu',sans-serif;">
                ${content}
              </td>
            </tr>

          </table>

          ${emailFooter(footer, options?.product)}
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * « +242055183391 » as people write it, « +242 05 518 33 91 »; anything else
 * (another country, already spaced) as it was entered.
 */
export function displayPhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  const congo = /^\+242(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(digits);
  return congo ? `+242 ${congo.slice(1).join(' ')}` : raw.trim();
}

/**
 * The foot of the email, under the card on the page's own background, kept
 * short: the networks as icons, one line to reach us (phone, email, site) and
 * the address, then the small print — why this email, and copyright, legal
 * name, RCCM and the legal links on one line. Each part shows only when its
 * setting is filled in (Settings → Contact). A business's email points to
 * business.rabotka.work, every other to www.rabotka.work.
 */
export function emailFooter(
  footer: FooterInfo | undefined,
  product?: 'business',
): string {
  const font = "font-family:'Ubuntu',Arial,sans-serif;";
  const ink = '#2a322e';
  const grey = '#86868b';
  const link = (href: string, label: string, color = ink) =>
    `<a href="${escapeHtml(href)}" target="_blank" style="color:${color};text-decoration:underline;">${label}</a>`;
  const p = (html: string, style: string, margin = '0 0 6px') =>
    `<p style="margin:${margin};${font}${style}">${html}</p>`;
  const dot = `&nbsp;<span style="color:#c4c2ba;">&middot;</span>&nbsp;`;

  const socials = footer?.socials ?? [];
  const icons = socials.length
    ? `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 18px;">
                <tr>${socials
                  .map(
                    ({ network, url }) => `
                  <td style="padding:0 5px;">
                    <a href="${escapeHtml(url)}" target="_blank" style="text-decoration:none;">
                      <img src="cid:${socialIconCid(network)}" width="30" height="30" alt="${SOCIAL_LABELS[network]}"
                        style="display:block;width:30px;height:30px;border:0;outline:none;">
                    </a>
                  </td>`,
                  )
                  .join('')}
                </tr>
              </table>`
    : '';

  const email = footer?.email?.trim() || 'noreply@rabotka.work';
  const phone = footer?.phone?.trim();
  const site =
    product === 'business' ? 'business.rabotka.work' : 'www.rabotka.work';
  const reach = p(
    [
      phone
        ? link(
            `tel:${phone.replace(/[^\d+]/g, '')}`,
            escapeHtml(displayPhone(phone)),
          )
        : '',
      link(`mailto:${email}`, escapeHtml(email)),
      link(`https://${site}`, site),
    ]
      .filter(Boolean)
      .join(dot),
    `font-size:13px;line-height:20px;color:${ink};`,
    footer?.address?.trim() ? '0 0 4px' : '0',
  );
  const address = footer?.address?.trim()
    ? p(
        escapeHtml(footer.address.trim()),
        `font-size:13px;line-height:20px;color:${grey};`,
        '0',
      )
    : '';

  const legalName = footer?.legalName?.trim() || 'Rabotka';
  const small = `font-size:12px;line-height:18px;color:${grey};`;
  const fine = [
    p(
      `Vous recevez cet e-mail parce que vous utilisez ${product === 'business' ? 'Rabotka Business' : 'Rabotka'}.`,
      small,
      '0 0 4px',
    ),
    p(
      [
        `&copy; ${new Date().getFullYear()} ${escapeHtml(legalName)}`,
        footer?.rccm?.trim() ? `RCCM ${escapeHtml(footer.rccm.trim())}` : '',
        link(`${LEGAL_SITE}/terms`, 'Conditions d’utilisation', '#515154'),
        link(`${LEGAL_SITE}/privacy`, 'Confidentialité', '#515154'),
      ]
        .filter(Boolean)
        .join(dot),
      small,
      '0',
    ),
  ].join('');

  return `<!-- Footer -->
          <table class="rk-foot" width="600" cellpadding="0" cellspacing="0" border="0" role="presentation">
            <tr>
              <td align="center" style="padding:28px 32px 0;text-align:center;">
              ${icons}
              ${reach}
              ${address}
              <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:18px auto;">
                <tr><td width="40" height="1" bgcolor="#d9d7cf" style="width:40px;height:1px;line-height:1px;font-size:0;background:#d9d7cf;">&nbsp;</td></tr>
              </table>
              ${fine}
              </td>
            </tr>
          </table>`;
}

/**
 * The one call-to-action button for transactional emails.
 *
 * A table rather than a styled `<a>`: Outlook ignores padding on inline
 * elements, so a bare anchor collapses to underlined text there. Colours are
 * inline and literal because email clients strip `<style>` blocks and have no
 * access to the design tokens — `#2a322e` is the body text colour used by
 * `wrapEmailHtml` above.
 */
export function emailButton(href: string, label: string): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
      <tr>
        <td align="center" bgcolor="#2a322e" style="border-radius:6px;">
          <a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 28px;font-family:'Ubuntu',Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(label)}</a>
        </td>
      </tr>
    </table>`;
}

export function escapeHtml(raw: string): string {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
