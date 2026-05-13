/**
 * Manual test script for the advertisement-completed email template.
 *
 * Run with:
 *   npx tsx src/modules/mail/templates/__tests__/advertisement-completed.manual.ts
 *
 * Writes the rendered HTML to /tmp/ad-report-preview.html so you can open it in a browser.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { advertisementCompletedEmail } from '../advertisement-completed';

const stats = {
  totalSent: 11,
  totalOpened: 1,
  totalClicks: 2,
  totalFailed: 6,
  openRate: 1 / 11,
  clickRate: 2 / 11,
  clickedDeliveries: 1,
  clickThroughRate: 1 / 11,
  remainingDays: 0,
  links: [
    {
      hash: 'abc123',
      originalUrl: 'https://rabotka.co',
      clickCount: 2,
      lastClickedAt: new Date('2026-05-01T10:30:00Z'),
    },
  ],
};

const timeline = [
  { date: '2026-05-01', sent: 4, opened: 1, clicked: 2, failed: 0 },
  { date: '2026-05-02', sent: 4, opened: 0, clicked: 0, failed: 0 },
  { date: '2026-05-03', sent: 3, opened: 0, clicked: 0, failed: 1 },
];

const html = advertisementCompletedEmail({
  adTitle: 'Rabotka ads test',
  startDate: '2026-05-01T00:00:00Z',
  endDate: '2026-05-03T23:59:59Z',
  stats,
  timeline,
});

const outPath = path.join(os.tmpdir(), 'ad-report-preview.html');
fs.writeFileSync(outPath, html, 'utf8');

console.log('✓ Email HTML rendered successfully');
console.log(`  Output: ${outPath}`);
console.log(`  Size:   ${(html.length / 1024).toFixed(1)} KB`);

// Basic sanity checks
const checks: [string, boolean][] = [
  ['Contains campaign title', html.includes('Rabotka ads test')],
  ['Contains brand bar', html.includes('Rabotka') && html.includes('Ads')],
  ['Contains open rate (9.1 %)', html.includes('9.1')],
  ['Contains CTR section', html.includes('CTR')],
  ['Contains sent count', html.includes('>11<')],
  ['Contains funnel bar', html.includes('RÉPARTITION DE LA LIVRAISON')],
  ['Contains timeline section', html.includes('CHRONOLOGIE QUOTIDIENNE')],
  ['Contains a day label', html.includes('01 MAI')],
  ['Contains XLSX attachment', html.includes('XLSX')],
  // sign-off uses HTML entity &rsquo; for the apostrophe
  ['Contains sign-off', html.includes('quipe Rabotka')],
  ['Contains footer', html.includes('noreply@rabotka')],
];

let allPassed = true;
for (const [label, passed] of checks) {
  const icon = passed ? '✓' : '✗';
  if (!passed) allPassed = false;
  console.log(`  ${icon} ${label}`);
}

if (!allPassed) {
  process.exit(1);
}
console.log('\nAll checks passed. Open the file in a browser to visually verify.');
