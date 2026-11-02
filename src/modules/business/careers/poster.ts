import { EmploymentType, type PaymentFlow } from '@prisma/client';

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const TYPE: Record<EmploymentType, string> = {
  MISSION: 'Mission',
  CDD: 'CDD',
  CDI: 'CDI',
  STAGE: 'Stage',
};

const PER: Partial<Record<PaymentFlow, string>> = {
  TASK: 'la mission',
  HOURLY: 'heure',
  DAILY: 'jour',
  MONTHLY: 'mois',
};

export type PosterInput = {
  company: string;
  logoUrl: string | null;
  title: string;
  description: string;
  employmentType: EmploymentType;
  closesAt: Date | null;
  place: string | null;
  amount: number | null;
  paymentFlow: PaymentFlow | null;
  qrDataUrl: string;
  /** Shown under the code, for those who type it. */
  url: string;
};

/** The offer as an A4 poster: who hires, what, and a QR code to apply. */
export function posterHtml(p: PosterInput): string {
  const excerpt =
    p.description.length > 420
      ? `${p.description.slice(0, 417).trimEnd()}…`
      : p.description;
  const per = p.paymentFlow ? PER[p.paymentFlow] : undefined;
  const pay =
    p.amount === null
      ? null
      : `${p.amount.toLocaleString('fr-FR')} FCFA${per ? ` / ${per}` : ''}`;
  const date = p.closesAt
    ? p.closesAt.toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'long',
        timeZone: 'Africa/Brazzaville',
      })
    : null;
  const facts = [
    TYPE[p.employmentType],
    p.place,
    pay,
    date
      ? p.employmentType === EmploymentType.MISSION
        ? `Le ${date}`
        : `Jusqu'au ${date}`
      : null,
  ].filter((x): x is string => !!x);

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; }
  .page { min-height: 258mm; display: flex; flex-direction: column; }
  body { font-family: 'Space Grotesk', 'Helvetica Neue', Arial, sans-serif; color: #0f2414; }
  .band { background: #cbffa5; border-radius: 28px; padding: 36px 40px; }
  .who { display: flex; align-items: center; gap: 16px; font-size: 20px; font-weight: 500; }
  .who img { width: 64px; height: 64px; border-radius: 16px; object-fit: cover; }
  h1 { font-size: 58px; line-height: 1.05; font-weight: 700; margin-top: 22px; letter-spacing: -0.02em; }
  .facts { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 22px; }
  .facts span { background: #fff; border-radius: 999px; padding: 10px 18px; font-size: 19px; font-weight: 500; }
  .text { margin-top: 32px; font-size: 17px; line-height: 1.55; color: #3f5f3a; white-space: pre-line; }
  .apply { display: flex; align-items: center; gap: 32px; margin-top: auto; background: #f2f4f1; border-radius: 28px; padding: 28px; }
  .apply img { width: 250px; height: 250px; }
  .apply h2 { font-size: 36px; font-weight: 700; }
  .apply p { margin-top: 8px; font-size: 15px; color: #3f5f3a; }
  .apply .url { margin-top: 14px; font-size: 13px; color: #0f2414; word-break: break-all; }
</style></head>
<body><div class="page">
  <div class="band">
    <div class="who">${p.logoUrl ? `<img src="${esc(p.logoUrl)}" alt="">` : ''}<span>${esc(p.company)} recrute</span></div>
    <h1>${esc(p.title)}</h1>
    <div class="facts">${facts.map((f) => `<span>${esc(f)}</span>`).join('')}</div>
  </div>
  <p class="text">${esc(excerpt)}</p>
  <div class="apply">
    <img src="${p.qrDataUrl}" alt="">
    <div>
      <h2>Scannez pour postuler</h2>
      <p>Avec l'appareil photo de votre téléphone. Votre candidature arrive directement chez ${esc(p.company)}.</p>
      <p class="url">${esc(p.url)}</p>
    </div>
  </div>
</div></body></html>`;
}
