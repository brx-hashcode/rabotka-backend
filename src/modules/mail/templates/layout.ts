export type EmailLayoutOptions = {
  headerText?: string;
  previewText?: string;
  headerFont?: string;
  bodyFont?: string;
};

const UBUNTU_FONT = "'Ubuntu', sans-serif";

export function wrapEmailHtml(
  content: string,
  options?: EmailLayoutOptions,
): string {
  const headerText = options?.headerText ?? '';
  const previewText = options?.previewText ?? '';
  const font = options?.headerFont ?? options?.bodyFont ?? UBUNTU_FONT;

  const styleBlock = `
    body {
      font-family: ${font};
      font-size: 16px;
      line-height: 1.5;
      color: #333;
      margin: 0;
      padding: 0;
    }
    .email-header {
      font-family: ${font};
      font-size: 16px;
      font-weight: 400;
      margin-bottom: 1rem;
    }
    .email-body {
      max-width: 600px;
      padding: 1rem;
    }
    .preview-text {
      display: none;
      max-height: 0;
      overflow: hidden;
    }
  `.replaceAll(/\n\s+/g, ' ');

  const headParts = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '<link href="https://fonts.googleapis.com/css2?family=Ubuntu:wght@400;500&display=swap" rel="stylesheet">',
    `<style>${styleBlock.trim()}</style>`,
  ].filter(Boolean);

  const bodyParts = [
    previewText
      ? `<span class="preview-text">${escapeHtml(previewText)}</span>`
      : '',
    headerText
      ? `<div class="email-header">${escapeHtml(headerText)}</div>`
      : '',
    `<div class="email-body">${content}</div>`,
  ].filter(Boolean);

  return `
    <!DOCTYPE html>
      <html lang="en">
        <head>
        ${headParts.join('\n')}
        </head>
        <body>
        ${bodyParts.join('\n')}
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
