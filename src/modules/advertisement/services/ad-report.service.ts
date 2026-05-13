import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { AdAnalyticsService, AdStats } from './ad-analytics.service';

@Injectable()
export class AdReportService {
  constructor(private readonly analytics: AdAnalyticsService) {}

  async getStats(advertisementId: string): Promise<AdStats> {
    return this.analytics.getStats(advertisementId);
  }

  async getAnalytics(advertisementId: string) {
    return this.analytics.getAnalytics(advertisementId);
  }

  async generateExcel(
    advertisementId: string,
    adTitle: string,
  ): Promise<Buffer> {
    const data = await this.analytics.getAnalytics(advertisementId);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Rabotka';
    workbook.created = new Date();

    // ── Sheet 1: Summary ──────────────────────────────────────────────────────
    const summary = workbook.addWorksheet('Résumé');
    summary.columns = [
      { header: 'Indicateur', key: 'label', width: 30 },
      { header: 'Valeur', key: 'value', width: 20 },
    ];
    this.styleHeaderRow(summary, 1);

    const pct = (n: number) => `${(n * 100).toFixed(1)} %`;
    const fmt = (d: Date | null) =>
      d ? new Date(d).toLocaleDateString('fr-FR') : '—';

    summary.addRows([
      { label: 'Titre de la campagne', value: adTitle },
      { label: 'Total envoyés', value: data.totalSent },
      { label: 'Total ouverts', value: data.totalOpened },
      { label: 'Total clics', value: data.totalClicks },
      { label: "Taux d'ouverture", value: pct(data.openRate) },
      { label: 'Taux de clic (CTR)', value: pct(data.clickThroughRate) },
    ]);

    // ── Sheet 2: Daily Timeline ───────────────────────────────────────────────
    const timeline = workbook.addWorksheet('Chronologie');
    timeline.columns = [
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Envoyés', key: 'sent', width: 12 },
      { header: 'Cliqués', key: 'clicked', width: 12 },
      { header: 'Échoués', key: 'failed', width: 12 },
    ];
    this.styleHeaderRow(timeline, 1);
    for (const pt of data.timeline) {
      timeline.addRow({
        date: pt.date,
        sent: pt.sent,
        clicked: pt.clicked,
        failed: pt.failed,
      });
    }

    // ── Sheet 3: Delivery Logs ────────────────────────────────────────────────
    const logs = workbook.addWorksheet('Logs de livraison');
    logs.columns = [
      { header: 'Nom', key: 'name', width: 24 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Canal', key: 'channel', width: 12 },
      { header: 'Statut', key: 'status', width: 14 },
      { header: 'Envoyé le', key: 'sentAt', width: 16 },
      { header: 'Ouvert le', key: 'openedAt', width: 16 },
      { header: 'Cliqué le', key: 'clickedAt', width: 16 },
    ];
    this.styleHeaderRow(logs, 1);
    for (const log of data.deliveryLogs) {
      logs.addRow({
        name: log.profileName,
        email: log.profileEmail,
        channel: log.channel,
        status: log.status,
        sentAt: fmt(log.sentAt),
        openedAt: fmt(log.openedAt),
        clickedAt: fmt(log.clickedAt),
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  private styleHeaderRow(sheet: ExcelJS.Worksheet, rowNumber: number): void {
    const row = sheet.getRow(rowNumber);
    row.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF059669' },
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    row.height = 22;
  }
}
