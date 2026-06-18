import { escapeHtml, wrapEmailHtml } from './layout';
import type {
  AdStats,
  AdTimelinePoint,
} from '../../advertisement/services/ad-analytics.service';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function formatDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatDayLabel(dateStr: string): string {
  const d = new Date(dateStr);
  const day = d
    .toLocaleDateString('fr-FR', { weekday: 'short' })
    .toUpperCase()
    .slice(0, 3);
  const dayNum = d
    .toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })
    .toUpperCase();
  return `${day} · ${dayNum}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)} %`;
}

function pctOf(value: number, total: number): string {
  if (total === 0) return '0 %';
  return `${((value / total) * 100).toFixed(1)} %`;
}

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/(^-|-$)/g, '')
    .slice(0, 60);
}

export function advertisementCompletedEmail(params: {
  adTitle: string;
  startDate: string;
  endDate: string;
  stats: AdStats;
  timeline?: AdTimelinePoint[];
}): string {
  const { adTitle, startDate, endDate, stats, timeline = [] } = params;

  const totalSent = stats.totalSent;
  const totalOpened = stats.totalOpened;
  const totalClicks = stats.totalClicks;
  const clickedDeliveries = stats.clickedDeliveries;
  const totalFailed = Number(
    stats.totalFailed ?? timeline.reduce((s, d) => s + d.failed, 0),
  );
  const totalAttempts = totalSent + totalFailed;
  const totalDelivered = totalSent;

  const openRatePct = pct(stats.openRate);
  const ctrPct = pct(stats.clickThroughRate);

  const maxDaySent = Math.max(...timeline.map((d) => d.sent), 1);
  const barW = (val: number) => `${Math.round((val / maxDaySent) * 100)}%`;

  const startFmt = formatDateShort(startDate);
  const endFmt = formatDateShort(endDate);
  const today = formatDate(new Date().toISOString());
  const durationDays =
    timeline.length ||
    Math.round(
      (new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000,
    ) + 1;
  const slugTitle = slugify(adTitle);
  const reportRef = `RPT-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}${String(new Date().getDate()).padStart(2, '0')}-${slugTitle.slice(0, 4).toUpperCase()}`;

  const daysCapped = timeline.slice(0, 7);
  const dayWidth =
    daysCapped.length > 0 ? `${Math.floor(100 / daysCapped.length)}%` : '33%';

  const dayCells = daysCapped
    .map(
      (d) => `
    <td style="width:${dayWidth};padding:28px 32px 12px;border-right:1px solid #e6e8e4;vertical-align:top;">
      <div style="font-family:'Courier New',Courier,monospace;font-size:10px;color:#6b7570;letter-spacing:0.04em;margin-bottom:10px;">${escapeHtml(formatDayLabel(d.date))}</div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;">
        <span style="width:52px;font-size:10.5px;color:#9aa39d;letter-spacing:0.03em;">Envoyés</span>
        <span style="flex:1;height:4px;background:#eef0ec;border-radius:99px;overflow:hidden;display:block;">
          <span style="display:block;height:100%;width:${barW(d.sent)};background:#1FBA52;border-radius:99px;"></span>
        </span>
        <span style="width:16px;text-align:right;font-size:10.5px;color:#0e1411;font-weight:600;">${d.sent}</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;">
        <span style="width:52px;font-size:10.5px;color:#9aa39d;letter-spacing:0.03em;">Ouverts</span>
        <span style="flex:1;height:4px;background:#eef0ec;border-radius:99px;overflow:hidden;display:block;">
          <span style="display:block;height:100%;width:${barW(Number(d.opened))};background:#0f7a36;border-radius:99px;"></span>
        </span>
        <span style="width:16px;text-align:right;font-size:10.5px;color:#0e1411;font-weight:600;">${Number(d.opened)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="width:52px;font-size:10.5px;color:#9aa39d;letter-spacing:0.03em;">Clics</span>
        <span style="flex:1;height:4px;background:#eef0ec;border-radius:99px;overflow:hidden;display:block;">
          <span style="display:block;height:100%;width:${barW(d.clicked)};background:#0e1411;border-radius:99px;"></span>
        </span>
        <span style="width:16px;text-align:right;font-size:10.5px;color:#0e1411;font-weight:600;">${d.clicked}</span>
      </div>
    </td>`,
    )
    .join('');

  const timelineSection =
    daysCapped.length > 0
      ? `
    <!-- Section head: Chronologie -->
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr>
        <td style="padding:28px 32px 12px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-size:12px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:#0e1411;">CHRONOLOGIE QUOTIDIENNE</td>
              <td style="text-align:right;font-family:'Courier New',Courier,monospace;font-size:11px;color:#9aa39d;">${durationDays} jours</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-top:1px solid #e6e8e4;border-bottom:1px solid #e6e8e4;margin-bottom:28px;">
      <tr>${dayCells}<td style="display:none"></td></tr>
    </table>`
      : '';

  const xlsxFilename = `rabotka-${slugTitle}_rapport_${new Date().toISOString().slice(0, 10)}.xlsx`;

  const logoSvg = `<svg width="22" height="22" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" style="vertical-align:middle;margin-right:8px;"><rect width="40" height="40" rx="8" fill="#1FBA52"/><path d="M10 28V12h8c2.2 0 3.9.5 5 1.6 1.1 1 1.7 2.4 1.7 4.1 0 1.8-.6 3.2-1.8 4.2-1.2 1-2.9 1.5-5.1 1.5H14v4.6H10zm4-7.8h3.7c1.1 0 2-.3 2.5-.8.6-.5.9-1.2.9-2.1 0-.9-.3-1.6-.9-2.1-.6-.5-1.4-.8-2.5-.8H14v5.8z" fill="white"/></svg>`;

  const xlsIconSvg = `<svg width="40" height="48" viewBox="0 0 40 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="40" height="48" rx="3" fill="#fff" stroke="#e6e8e4"/><path d="M28 0l12 12H28V0z" fill="#eef0ec"/><rect x="0" y="20" width="32" height="18" rx="2" fill="#1FBA52"/><text x="16" y="33" font-family="Arial,sans-serif" font-size="9" font-weight="700" fill="white" text-anchor="middle" letter-spacing="0.5">XLSX</text></svg>`;

  const body = `
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#fbfaf6;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;">
  <tr>
    <td align="center" valign="top" style="padding:40px 16px 64px;">

      <table width="680" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#ffffff;border:1px solid #e6e8e4;border-radius:6px;color:#0e1411;box-shadow:0 24px 48px -24px rgba(14,20,17,.12);">

  <!-- Brand bar -->
  <tr>
    <td style="padding:16px 32px;border-bottom:1px solid #e6e8e4;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="font-size:15px;font-weight:600;color:#0e1411;letter-spacing:-0.01em;">
            ${logoSvg}Rabotka
          </td>
          <td style="text-align:right;font-family:'Courier New',Courier,monospace;font-size:11px;color:#6b7570;letter-spacing:0.02em;">${escapeHtml(reportRef)}</td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Status row -->
  <tr>
    <td style="padding:20px 32px 0;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#6b7570;font-weight:500;">
            <span style="display:inline-block;width:7px;height:7px;border-radius:99px;background:#1FBA52;margin-right:8px;vertical-align:middle;box-shadow:0 0 0 3px #eaf7ee;"></span>Campagne terminée
          </td>
          <td style="text-align:right;font-family:'Courier New',Courier,monospace;font-size:11px;color:#9aa39d;letter-spacing:0.04em;">${durationDays} jours &middot; ${escapeHtml(startFmt)} &ndash; ${escapeHtml(endFmt)}</td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Title block -->
  <tr>
    <td style="padding:12px 32px 24px;border-bottom:1px solid #e6e8e4;">
      <h1 style="margin:6px 0 16px;font-size:28px;font-weight:600;line-height:1.15;letter-spacing:-0.02em;color:#0e1411;">${escapeHtml(adTitle)}</h1>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eef0ec;">
        <tr>
          <td style="padding:12px 16px 0 0;width:33%;vertical-align:top;">
            <div style="font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#9aa39d;font-weight:500;margin-bottom:3px;">Période</div>
            <div style="font-size:13px;color:#0e1411;font-weight:500;">${escapeHtml(startFmt)} &#x2192; ${escapeHtml(endFmt)}</div>
          </td>
          <td style="padding:12px 16px 0 0;width:33%;vertical-align:top;">
            <div style="font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#9aa39d;font-weight:500;margin-bottom:3px;">Annonceur</div>
            <div style="font-size:13px;color:#0e1411;font-weight:500;">Rabotka</div>
          </td>
          <td style="padding:12px 0 0;width:33%;vertical-align:top;">
            <div style="font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#9aa39d;font-weight:500;margin-bottom:3px;">Préparé le</div>
            <div style="font-size:13px;color:#0e1411;font-weight:500;">${escapeHtml(today)}</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Intro -->
  <tr>
    <td style="padding:24px 32px 8px;font-size:14.5px;color:#2a322e;line-height:1.65;">
      <p style="margin:0 0 12px;">Bonjour,</p>
      <p style="margin:0 0 12px;">Votre campagne <strong style="color:#0e1411;">${escapeHtml(adTitle)}</strong> est désormais clôturée. Vous trouverez ci&#8209;dessous une lecture synthétique de ses performances. Le détail complet &mdash; chronologie quotidienne, journaux de livraison par destinataire, et résumé par indicateur &mdash; est disponible dans le fichier Excel joint.</p>
    </td>
  </tr>

  <!-- Section head: Performance -->
  <tr>
    <td style="padding:24px 32px 12px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="font-size:12px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:#0e1411;">PERFORMANCE</td>
          <td style="text-align:right;font-family:'Courier New',Courier,monospace;font-size:11px;color:#9aa39d;">5 indicateurs &middot; vue d&rsquo;ensemble</td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- KPI headline: open rate + CTR -->
  <tr>
    <td style="padding:0 32px;border-top:1px solid #e6e8e4;border-bottom:1px solid #e6e8e4;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="padding:22px 24px 22px 0;width:50%;vertical-align:top;">
            <div style="font-size:10.5px;letter-spacing:0.14em;text-transform:uppercase;color:#0f7a36;font-weight:600;margin-bottom:6px;">TAUX D&rsquo;OUVERTURE</div>
            <div style="font-family:Georgia,'Times New Roman',serif;font-size:56px;line-height:1;letter-spacing:-0.02em;color:#0f7a36;">${openRatePct.replace(' %', '')}<span style="font-size:22px;color:#6b7570;margin-left:2px;vertical-align:middle;"> %</span></div>
            <div style="font-size:12px;color:#6b7570;margin-top:6px;">${totalOpened} ouverture${totalOpened !== 1 ? 's' : ''} sur ${totalSent} envois &middot; benchmark secteur 21,3 %</div>
          </td>
          <td style="padding:22px 0 22px 24px;width:50%;vertical-align:top;border-left:1px solid #e6e8e4;">
            <div style="font-size:10.5px;letter-spacing:0.14em;text-transform:uppercase;color:#6b7570;font-weight:500;margin-bottom:6px;">TAUX DE CLIC (CTR)</div>
            <div style="font-family:Georgia,'Times New Roman',serif;font-size:56px;line-height:1;letter-spacing:-0.02em;color:#0e1411;">${ctrPct.replace(' %', '')}<span style="font-size:22px;color:#6b7570;margin-left:2px;vertical-align:middle;"> %</span></div>
            <div style="font-size:12px;color:#6b7570;margin-top:6px;">${clickedDeliveries} destinataire${clickedDeliveries !== 1 ? 's' : ''} ayant cliqué sur ${totalSent} envois &middot; benchmark secteur 2,6 %</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- KPI row: Envoyés / Ouvertures / Clics -->
  <tr>
    <td style="border-bottom:1px solid #e6e8e4;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="padding:16px 32px 20px;width:33%;border-right:1px solid #e6e8e4;vertical-align:top;">
            <div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#6b7570;font-weight:500;margin-bottom:4px;">Envoyés</div>
            <div style="font-size:24px;font-weight:500;letter-spacing:-0.01em;color:#0e1411;line-height:1.1;">${totalSent}</div>
            <div style="font-size:11px;color:#6b7570;margin-top:3px;">100 % de l&rsquo;audience ciblée</div>
          </td>
          <td style="padding:16px 32px 20px;width:33%;border-right:1px solid #e6e8e4;vertical-align:top;">
            <div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#6b7570;font-weight:500;margin-bottom:4px;">Ouvertures uniques</div>
            <div style="font-size:24px;font-weight:500;letter-spacing:-0.01em;color:#0e1411;line-height:1.1;">${totalOpened}</div>
            <div style="font-size:11px;color:#6b7570;margin-top:3px;">${pctOf(totalOpened, totalSent)} du total envoyé</div>
          </td>
          <td style="padding:16px 32px 20px;width:33%;vertical-align:top;">
            <div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#6b7570;font-weight:500;margin-bottom:4px;">Clics uniques</div>
            <div style="font-size:24px;font-weight:500;letter-spacing:-0.01em;color:#0e1411;line-height:1.1;">${stats.clickedDeliveries}</div>
            <div style="font-size:11px;color:#6b7570;margin-top:3px;">${pctOf(stats.clickedDeliveries, totalSent)} du total envoyé &middot; ${totalClicks} clic${totalClicks !== 1 ? 's' : ''} au total</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Section head: Répartition -->
  <tr>
    <td style="padding:24px 32px 12px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="font-size:12px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:#0e1411;">RÉPARTITION DE LA LIVRAISON</td>
          <td style="text-align:right;font-family:'Courier New',Courier,monospace;font-size:11px;color:#9aa39d;">${totalSent} destinataires</td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Funnel bar -->
  <tr>
    <td style="padding:0 32px 24px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#eef0ec;border-radius:99px;height:10px;overflow:hidden;">
        <tr>
          <td style="width:${pctOf(totalDelivered, totalAttempts)};background:#1FBA52;height:10px;font-size:1px;">&nbsp;</td>
          <td style="width:${pctOf(totalOpened, totalAttempts)};background:#0f7a36;height:10px;font-size:1px;">&nbsp;</td>
          <td style="width:${pctOf(clickedDeliveries, totalAttempts)};background:#0e1411;height:10px;font-size:1px;">&nbsp;</td>
          <td style="width:${pctOf(totalFailed, totalAttempts)};background:#d9b066;height:10px;font-size:1px;">&nbsp;</td>
          <td style="background:#eef0ec;height:10px;font-size:1px;">&nbsp;</td>
        </tr>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eef0ec;margin-top:14px;">
        <tr>
          <td style="padding-top:12px;width:25%;vertical-align:top;padding-right:8px;">
            <div style="font-size:10.5px;letter-spacing:0.1em;text-transform:uppercase;color:#6b7570;font-weight:500;margin-bottom:4px;"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#1FBA52;margin-right:4px;vertical-align:middle;"></span>Livrés</div>
            <div style="font-size:18px;font-weight:500;color:#0e1411;letter-spacing:-0.01em;">${totalDelivered} <span style="font-size:11px;color:#9aa39d;font-weight:400;">${pctOf(totalDelivered, totalSent)}</span></div>
          </td>
          <td style="padding-top:12px;width:25%;vertical-align:top;padding-right:8px;">
            <div style="font-size:10.5px;letter-spacing:0.1em;text-transform:uppercase;color:#6b7570;font-weight:500;margin-bottom:4px;"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#0f7a36;margin-right:4px;vertical-align:middle;"></span>Ouverts</div>
            <div style="font-size:18px;font-weight:500;color:#0e1411;letter-spacing:-0.01em;">${totalOpened} <span style="font-size:11px;color:#9aa39d;font-weight:400;">${pctOf(totalOpened, totalSent)}</span></div>
          </td>
          <td style="padding-top:12px;width:25%;vertical-align:top;padding-right:8px;">
            <div style="font-size:10.5px;letter-spacing:0.1em;text-transform:uppercase;color:#6b7570;font-weight:500;margin-bottom:4px;"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#0e1411;margin-right:4px;vertical-align:middle;"></span>Cliqués</div>
            <div style="font-size:18px;font-weight:500;color:#0e1411;letter-spacing:-0.01em;">${clickedDeliveries} <span style="font-size:11px;color:#9aa39d;font-weight:400;">${pctOf(clickedDeliveries, totalAttempts)}</span></div>
          </td>
          <td style="padding-top:12px;width:25%;vertical-align:top;">
            <div style="font-size:10.5px;letter-spacing:0.1em;text-transform:uppercase;color:#6b7570;font-weight:500;margin-bottom:4px;"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#d9b066;margin-right:4px;vertical-align:middle;"></span>Échecs</div>
            <div style="font-size:18px;font-weight:500;color:#0e1411;letter-spacing:-0.01em;">${totalFailed} <span style="font-size:11px;color:#9aa39d;font-weight:400;">${pctOf(totalFailed, totalSent)}</span></div>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  ${timelineSection}

  <!-- Section head: Pièce jointe -->
  <tr>
    <td style="padding:4px 32px 12px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="font-size:12px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:#0e1411;">PIÈCE JOINTE</td>
          <td style="text-align:right;font-family:'Courier New',Courier,monospace;font-size:11px;color:#9aa39d;">1 fichier</td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Attachment card -->
  <tr>
    <td style="padding:0 32px 24px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e6e8e4;border-radius:4px;background:#fcfbf7;">
        <tr>
          <td style="padding:14px 16px;width:56px;vertical-align:middle;">${xlsIconSvg}</td>
          <td style="padding:14px 8px;vertical-align:middle;">
            <div style="font-weight:600;font-size:13.5px;color:#0e1411;margin-bottom:3px;word-break:break-all;">${escapeHtml(xlsxFilename)}</div>
            <div style="font-size:12px;color:#6b7570;line-height:1.5;">Chronologie quotidienne &middot; journal de livraison par destinataire &middot; résumé des indicateurs.</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Sign off -->
  <tr>
    <td style="padding:4px 32px 32px;font-size:13.5px;color:#2a322e;line-height:1.65;">
      <p style="margin:0 0 10px;">Pour toute question sur la lecture du rapport ou la prochaine campagne, votre interlocuteur reste disponible &mdash; il suffit de répondre à ce courriel.</p>
      <p style="margin:0 0 16px;">Merci pour votre confiance,</p>
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-style:italic;color:#0e1411;line-height:1;">L&rsquo;équipe Rabotka</div>
      <div style="font-size:11.5px;color:#6b7570;margin-top:4px;letter-spacing:0.02em;">Performance &amp; reporting</div>
    </td>
  </tr>

  <!-- Footer -->
  <tr>
    <td style="padding:18px 32px 20px;border-top:1px solid #e6e8e4;background:#faf9f4;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="font-size:12px;color:#6b7570;">
            ${logoSvg.replace('margin-right:8px;', 'margin-right:6px;')}Rabotka SAS &middot; noreply@rabotka.africa
          </td>
          <td style="text-align:right;">
            <a href="#" style="font-size:12px;color:#6b7570;text-decoration:none;margin-left:16px;">Tableau de bord</a>
            <a href="#" style="font-size:12px;color:#6b7570;text-decoration:none;margin-left:16px;">Préférences</a>
            <a href="#" style="font-size:12px;color:#6b7570;text-decoration:none;margin-left:16px;">Aide</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Legalese -->
  <tr>
    <td style="padding:14px 32px 22px;text-align:center;font-size:10.5px;color:#9aa39d;line-height:1.6;">
      Vous recevez ce message car vous êtes l&rsquo;administrateur d&rsquo;une campagne Rabotka.
      <a href="#" style="color:#6b7570;text-decoration:underline;">Se désabonner des rapports</a> &middot;
      <a href="#" style="color:#6b7570;text-decoration:underline;">Mentions légales</a>
    </td>
  </tr>

      </table>
    </td>
  </tr>
</table>
`;

  return wrapEmailHtml(body, {
    previewText: `Votre campagne « ${adTitle} » est terminée — consultez votre rapport de performance`,
    rawLayout: true,
  });
}
