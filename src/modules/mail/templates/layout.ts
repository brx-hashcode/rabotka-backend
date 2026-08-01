import { RABOTKA_LOGO_CID } from './logo-asset';


export type FooterInfo = {
  description?: string | null;
  email?: string | null;
  address?: string | null;
};

export type EmailLayoutOptions = {
  previewText?: string;
  rawLayout?: boolean;
  footer?: FooterInfo;
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
                <img src="cid:${RABOTKA_LOGO_CID}" width="56" height="56" alt="Rabotka"
                  style="display:block;width:56px;height:56px;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;">
              </td>
            </tr>

            <!-- Content -->
            <tr>
              <td style="padding:32px;font-size:16px;color:#2a322e;line-height:1.7;font-family:'Ubuntu',sans-serif;">
                ${content}
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td align="center" style="padding:20px 32px 28px;border-top:1px solid #e6e4dd;font-family:'Ubuntu',sans-serif;">
                ${footer?.description ? `<p style="margin:0 0 10px;font-size:13px;color:#2a322e;font-weight:500;">${escapeHtml(footer.description)}</p>` : ''}
                <p style="margin:0;font-size:12px;color:#9aa39d;">
                  &copy; ${new Date().getFullYear()} Rabotka${footer?.email ? ` &nbsp;&middot;&nbsp; ${escapeHtml(footer.email)}` : ' &nbsp;&middot;&nbsp; noreply@rabotka.work'}${footer?.address ? ` &nbsp;&middot;&nbsp; ${escapeHtml(footer.address)}` : ''}
                </p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function escapeHtml(raw: string): string {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
