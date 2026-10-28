/**
 * The page the consent screen's popup lands on: it tells the portal (its
 * opener, same origin) how it went, then closes. Static text only.
 */
export type CallbackStatus =
  'connected' | 'denied' | 'scope' | 'api_disabled' | 'error';

const TEXT: Record<CallbackStatus, string> = {
  connected: 'Messagerie connectée. Vous pouvez fermer cette fenêtre.',
  denied: 'Connexion annulée. Vous pouvez fermer cette fenêtre.',
  scope:
    'L’accès à vos e-mails n’a pas été autorisé : réessayez et cochez la case qui permet à Rabotka de lire vos e-mails.',
  api_disabled:
    'La lecture des e-mails n’est pas encore activée pour Rabotka chez ce fournisseur. Réessayez plus tard.',
  error: 'La connexion n’a pas abouti. Fermez cette fenêtre et réessayez.',
};

export function callbackPage(status: CallbackStatus): string {
  const text = TEXT[status];
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rabotka Business</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:0 16px;background:#f6f6f4;color:#151515;text-align:center}@media (prefers-color-scheme:dark){body{background:#121212;color:#f2f2f2}}</style>
</head><body><p>${text}</p>
<script>
try { if (window.opener) window.opener.postMessage({ rabotkaMailbox: ${JSON.stringify(status)} }, window.location.origin); } catch (e) {}
${
  // A failure stays open, so its reason can be read.
  status === 'connected' || status === 'denied'
    ? `setTimeout(function () { window.close(); }, ${status === 'connected' ? 600 : 2500});`
    : ''
}
</script>
</body></html>`;
}
