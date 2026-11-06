/**
 * The page LinkedIn's consent popup lands on: it tells the business space
 * (its opener, same origin) how it went, then closes. Static text only.
 */
export type LinkedinCallbackStatus = 'connected' | 'denied' | 'error';

const TEXT: Record<LinkedinCallbackStatus, string> = {
  connected: 'LinkedIn connecté. Vous pouvez fermer cette fenêtre.',
  denied: 'Connexion annulée. Vous pouvez fermer cette fenêtre.',
  error: 'La connexion n’a pas abouti. Fermez cette fenêtre et réessayez.',
};

export function linkedinCallbackPage(status: LinkedinCallbackStatus): string {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rabotka Business</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:0 16px;background:#f6f6f4;color:#151515;text-align:center}@media (prefers-color-scheme:dark){body{background:#121212;color:#f2f2f2}}</style>
</head><body><p>${TEXT[status]}</p>
<script>
try { if (window.opener) window.opener.postMessage({ rabotkaLinkedin: ${JSON.stringify(status)} }, window.location.origin); } catch (e) {}
${status === 'error' ? '' : `setTimeout(function () { window.close(); }, ${status === 'connected' ? 600 : 2500});`}
</script>
</body></html>`;
}
