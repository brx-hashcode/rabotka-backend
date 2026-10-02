import { ApiReference } from '@scalar/nestjs-api-reference';
import type { Request, Response } from 'express';
import { createDocsSessionScript } from './docs-session.script';

/**
 * Scalar, pinned. The package defaults to the unversioned CDN url — whatever
 * jsDelivr calls "latest" at page load — on a page that can call the API with
 * the reader's session. Bump deliberately.
 */
export const SCALAR_CDN =
  'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.4';

type ApiReferenceOptions = Parameters<typeof ApiReference>[0];

/**
 * The `/api-docs` page: Scalar as the package renders it, plus the docs
 * session script (docs-session.script.ts) loaded FIRST, so its fetch wrapper
 * is in place before Scalar sends anything.
 *
 * Replaces the package's own `apiReference()` middleware, whose page template
 * has no slot for a script: its options are serialised to JSON, so a request
 * hook cannot be passed through them either.
 */
export function apiDocsPage(options: ApiReferenceOptions, apiPrefix: string) {
  const html = `<!DOCTYPE html>
<html>
  <head>
    <title>${escapeHtml(options.title ?? 'Rabotka API Reference')}</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <script>${createDocsSessionScript(apiPrefix)}</script>
  </head>
  <body>
    ${ApiReference({ ...options, cdn: SCALAR_CDN })}
  </body>
</html>`;

  return (_req: Request, res: Response): void => {
    res.type('html').send(html);
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
