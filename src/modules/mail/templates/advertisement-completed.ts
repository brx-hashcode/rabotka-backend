import { escapeHtml, wrapEmailHtml } from './layout';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)} %`;
}

export function advertisementCompletedEmail(params: {
  adTitle: string;
  startDate: string;
  endDate: string;
  stats: {
    totalSent: number;
    totalOpened: number;
    totalClicks: number;
    openRate: number;
    clickThroughRate: number;
  };
}): string {
  const { adTitle, startDate, endDate, stats } = params;

  const kpiCard = (label: string, value: string, accent: string) => `
    <td style="width:20%;padding:0 8px;text-align:center;vertical-align:top;">
      <div style="background:#f9fafb;border-radius:12px;padding:20px 12px;border-top:4px solid ${accent};">
        <div style="font-size:28px;font-weight:700;color:${accent};line-height:1.1;">${escapeHtml(value)}</div>
        <div style="font-size:12px;color:#6b7280;margin-top:6px;font-weight:500;text-transform:uppercase;letter-spacing:0.05em;">${escapeHtml(label)}</div>
      </div>
    </td>`;

  const body = `
    <!-- Hero -->
    <div style="background:linear-gradient(135deg,#059669 0%,#047857 100%);border-radius:12px;padding:32px 28px;margin-bottom:28px;text-align:center;">
      <div style="display:inline-block;background:rgba(255,255,255,0.2);border-radius:999px;padding:6px 18px;font-size:13px;color:#d1fae5;font-weight:600;letter-spacing:0.08em;margin-bottom:14px;">
        ✅ CAMPAGNE TERMINÉE
      </div>
      <h1 style="margin:0 0 10px;font-size:26px;font-weight:700;color:#ffffff;line-height:1.3;">
        ${escapeHtml(adTitle)}
      </h1>
      <p style="margin:0;font-size:14px;color:#a7f3d0;">
        ${formatDate(startDate)} → ${formatDate(endDate)}
      </p>
    </div>

    <!-- Intro -->
    <p style="color:#374151;font-size:15px;margin:0 0 24px;">
      Bonjour,<br /><br />
      Votre campagne publicitaire sur <strong>Rabotka</strong> est maintenant terminée.
      Retrouvez ci-dessous un résumé de ses performances, et en pièce jointe le rapport complet au format Excel.
    </p>

    <!-- KPI Cards -->
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:28px;">
      <tr>
        ${kpiCard('Envoyés', String(stats.totalSent), '#059669')}
        ${kpiCard('Ouverts', String(stats.totalOpened), '#0ea5e9')}
        ${kpiCard('Clics', String(stats.totalClicks), '#f59e0b')}
        ${kpiCard("Taux d'ouverture", pct(stats.openRate), '#8b5cf6')}
        ${kpiCard('CTR', pct(stats.clickThroughRate), '#ef4444')}
      </tr>
    </table>

    <!-- Divider -->
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 24px;" />

    <!-- Attachment note -->
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:16px 20px;margin-bottom:24px;display:flex;align-items:flex-start;gap:12px;">
      <span style="font-size:20px;flex-shrink:0;">📎</span>
      <div>
        <strong style="color:#92400e;font-size:14px;">Rapport Excel joint</strong><br />
        <span style="color:#78350f;font-size:13px;">
          Le fichier Excel en pièce jointe contient le détail complet :
          chronologie quotidienne, logs de livraison par destinataire et résumé des indicateurs.
        </span>
      </div>
    </div>

    <!-- CTA -->
    <div style="text-align:center;margin:28px 0;">
      <p style="color:#6b7280;font-size:14px;margin:0 0 20px;">
        Merci d'avoir fait confiance à Rabotka pour cette campagne.<br />
        Notre équipe reste à votre disposition pour toute question.
      </p>
    </div>

    <!-- Footer -->
    <div style="border-top:1px solid #e5e7eb;padding-top:20px;text-align:center;">
      <p style="margin:0 0 4px;font-size:13px;color:#9ca3af;">
        Cet email vous a été envoyé automatiquement suite à la fin de votre campagne.
      </p>
      <p style="margin:0;font-size:13px;font-weight:600;color:#059669;">L'équipe Rabotka</p>
    </div>
  `;

  return wrapEmailHtml(body, {
    previewText: `Votre campagne "${adTitle}" est terminée — consultez votre rapport de performance`,
  });
}
