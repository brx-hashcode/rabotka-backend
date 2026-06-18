const RABOTKA_GREEN = '#1FBA52';


export type EmailLayoutOptions = {
  previewText?: string;
  rawLayout?: boolean;
};

export function wrapEmailHtml(
  content: string,
  options?: EmailLayoutOptions,
): string {
  const previewText = options?.previewText ?? '';
  const previewSpan = previewText
    ? `<span style="display:none;max-height:0;overflow:hidden;">${escapeHtml(previewText)}</span>`
    : '';

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

            <!-- Green top accent bar -->
            <tr>
              <td height="6" bgcolor="${RABOTKA_GREEN}" style="background-color:${RABOTKA_GREEN};font-size:0;line-height:0;">&nbsp;</td>
            </tr>

            <!-- Content -->
            <tr>
              <td style="padding:32px;font-size:15px;color:#2a322e;line-height:1.65;font-family:'Ubuntu',sans-serif;">
                ${content}
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td align="center" style="padding:20px 32px 28px;border-top:1px solid #e6e4dd;font-size:12px;color:#9aa39d;font-family:'Ubuntu',sans-serif;">
                &copy; ${new Date().getFullYear()} Rabotka &nbsp;&middot;&nbsp; noreply@rabotka.work
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
