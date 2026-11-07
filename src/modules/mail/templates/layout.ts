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

/**
 * Stands in the footer for the address the email goes to; MailService.sendMail
 * puts it in when the email is queued (« Cet e-mail était destiné à … »).
 * One place for every email, rather than each template passing its recipient.
 * A phishing copy cannot know the address, so this line is what tells the
 * real email from a fake.
 */
export const RECIPIENT_TOKEN = '{{rk:recipient}}';

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

            <!-- The brand's green closes the card. A row rather than a
                 border-bottom: with border-collapse and rounded corners,
                 clients (and Chrome) drop the table's own border. -->
            <tr>
              <td height="4" bgcolor="#25d366" style="height:4px;line-height:4px;font-size:0;background:#25d366;">&nbsp;</td>
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
 * The foot of the email, under the card on the page's own background, in
 * three sections as retail emails do (Patagonia's, Apple's):
 *
 * 1. « Suivez-nous » and the networks as icons (when any link is set);
 * 2. « Besoin d'aide ? »: customer service phone, email and site;
 * 3. the small print: who this email was for and why, then copyright, legal
 *    name, RCCM and address in one line, then the legal links.
 *
 * Short rules separate them. Each line shows only when its setting is filled
 * in (Settings → Contact). A business's email points to
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
  const sep = `&nbsp;&nbsp;<span style="color:#c4c2ba;">|</span>&nbsp;&nbsp;`;
  // A short centred rule between sections.
  const rule = `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:26px auto;">
                <tr><td width="56" height="1" bgcolor="#d9d7cf" style="width:56px;height:1px;line-height:1px;font-size:0;background:#d9d7cf;">&nbsp;</td></tr>
              </table>`;

  // 1. The networks, under the same kind of heading as « Besoin d’aide ? ».
  const socials = footer?.socials ?? [];
  const follow = socials.length
    ? [
        p(
          'Suivez-nous',
          `font-size:15px;line-height:22px;font-weight:600;color:${ink};`,
          '0 0 12px',
        ),
        `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
                <tr>${socials
                  .map(
                    ({ network, url }) => `
                  <td style="padding:0 6px;">
                    <a href="${escapeHtml(url)}" target="_blank" style="text-decoration:none;">
                      <img src="cid:${socialIconCid(network)}" width="36" height="36" alt="${SOCIAL_LABELS[network]}"
                        style="display:block;width:36px;height:36px;border:0;outline:none;">
                    </a>
                  </td>`,
                  )
                  .join('')}
                </tr>
              </table>`,
        rule,
      ].join('')
    : '';

  // 2. Help.
  const email = footer?.email?.trim() || 'noreply@rabotka.work';
  const phone = footer?.phone?.trim();
  const site =
    product === 'business' ? 'business.rabotka.work' : 'www.rabotka.work';
  const help = [
    p(
      'Besoin d’aide ?',
      `font-size:15px;line-height:22px;font-weight:600;color:${ink};`,
      '0 0 8px',
    ),
    phone
      ? p(
          `Service client : ${link(`tel:${phone.replace(/[^\d+]/g, '')}`, `<strong>${escapeHtml(displayPhone(phone))}</strong>`)}`,
          `font-size:14px;line-height:22px;color:${ink};`,
        )
      : '',
    p(
      [
        link(`mailto:${email}`, escapeHtml(email)),
        link(`https://${site}`, site),
      ].join(sep),
      `font-size:13px;line-height:20px;color:${ink};`,
    ),
  ].join('');

  // 3. The small print.
  const legalName = footer?.legalName?.trim() || 'Rabotka';
  const small = `font-size:12px;line-height:18px;color:${grey};`;
  const fine = [
    p(
      `Cet e-mail était destiné à ${RECIPIENT_TOKEN}. Vous le recevez parce que vous utilisez ${product === 'business' ? 'Rabotka Business' : 'Rabotka'}.`,
      small,
      '0 0 10px',
    ),
    // One sentence, as a company signs: copyright, legal name, RCCM, address.
    p(
      [
        `&copy; ${new Date().getFullYear()} ${escapeHtml(legalName)}`,
        footer?.rccm?.trim() ? `RCCM ${escapeHtml(footer.rccm.trim())}` : '',
        footer?.address?.trim() ? escapeHtml(footer.address.trim()) : '',
      ]
        .filter(Boolean)
        .join('&nbsp;&middot;&nbsp;') + '. Tous droits réservés.',
      small,
      '0 0 10px',
    ),
    p(
      [
        link(`${LEGAL_SITE}/terms`, 'Conditions d’utilisation', '#515154'),
        link(`${LEGAL_SITE}/privacy`, 'Confidentialité', '#515154'),
      ].join(sep),
      small,
      '0',
    ),
  ].join('');

  return `<!-- Footer -->
          <table class="rk-foot" width="600" cellpadding="0" cellspacing="0" border="0" role="presentation">
            <tr>
              <td align="center" style="padding:36px 32px 0;text-align:center;">
              ${follow}
              ${help}
              ${rule}
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
