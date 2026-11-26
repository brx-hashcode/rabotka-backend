import { escapeHtml } from './layout';
import { signOff, type EmailAudience } from '../audience';

export interface PaymentReceipt {
  /** What was paid for, in words: « Déblocage du contact - Saisie de factures ». */
  description: string;
  amount: number;
  paidAt: Date;
  /** « MTN Mobile Money », « Airtel Money », « Portefeuille Rabotka »… */
  method: string | null;
  /** The payment's reference, as support finds it. */
  reference: string;
  /** False when the PDF could not be made: the mail still goes, without it. */
  invoiceAttached: boolean;
}

/**
 * « Pack Rabotka Business — 4 CV » → « Pack Rabotka Business - 4 CV ».
 * Descriptions are written with long dashes across the app; the receipt
 * shows a plain hyphen, in its subject as in its body.
 */
export function plainDashes(text: string): string {
  return text
    .split(/[—–]/u)
    .map((part) => part.trim())
    .join(' - ');
}

/** The receipt's subject: « Paiement confirmé - Pack Rabotka Business - 4 CV ». */
export function paymentReceiptSubject(description: string): string {
  return `Paiement confirmé - ${plainDashes(description)}`;
}

const MUTED = '#6b6b66';
const LINE = '#e6e6e0';

/**
 * One line of the receipt: the label short and on one line, the value on the
 * right. The first version had a grey label column at 40 %: on a phone
 * « Moyen de paiement » broke over two lines and every row doubled in height.
 */
const line = (label: string, value: string) => `
        <tr>
          <td style="padding:12px 0;border-top:1px solid ${LINE};color:${MUTED};font-size:14px;white-space:nowrap;vertical-align:top;">${label}</td>
          <td style="padding:12px 0 12px 16px;border-top:1px solid ${LINE};font-size:14px;font-weight:500;text-align:right;word-break:break-word;">${value}</td>
        </tr>`;

/**
 * THE one e-mail a payment sends: the confirmation and the invoice together.
 *
 * A payment used to send two — « Paiement confirmé » with a recap, then
 * « Votre facture » with the PDF, saying the same thing a minute apart.
 */
export function paymentReceiptEmail(
  name: string,
  r: PaymentReceipt,
  audience: EmailAudience = 'worker',
): string {
  const where =
    audience === 'business' ? 'dans votre espace' : "dans l'application";
  const paidAt = r.paidAt.toLocaleString('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Brazzaville',
  });
  return `
    <p>Bonjour <strong>${escapeHtml(name)}</strong>,</p>

    <p>
      Votre paiement est <strong>confirmé</strong>.
      ${
        r.invoiceAttached
          ? 'Votre facture est jointe à ce message.'
          : `Votre facture sera disponible ${where}.`
      }
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;width:100%;margin:20px 0;background:#f7f7f2;border-radius:12px;">
      <tr>
        <td style="padding:20px 20px 8px;">
          <div style="color:${MUTED};font-size:13px;">Montant payé</div>
          <div style="font-size:26px;font-weight:600;line-height:1.3;margin-top:2px;">${r.amount.toLocaleString('fr-FR')} FCFA</div>
          <div style="font-size:14px;margin-top:4px;">${escapeHtml(plainDashes(r.description))}</div>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 20px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;">
            ${line('Date', escapeHtml(paidAt))}
            ${r.method ? line('Paiement', escapeHtml(r.method)) : ''}
            ${line('Référence', escapeHtml(r.reference))}
          </table>
        </td>
      </tr>
    </table>

    <p>
      Conservez ce message : il fait foi de paiement. Vos factures restent
      aussi disponibles ${where}.
    </p>

    <p>
      Cordialement,<br />
      <strong>${signOff(audience)}</strong>
    </p>
  `;
}
