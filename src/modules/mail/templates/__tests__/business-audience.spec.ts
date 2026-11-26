import { accountSuspendedEmail } from '../account-suspended';
import { broadcastEmail } from '../broadcast';
import {
  businessApprovedEmail,
  businessDocumentRejectedEmail,
  businessRejectedEmail,
} from '../business-review';
import { paymentReceiptEmail } from '../payment-success';
import { referralRewardedEmail } from '../referral-rewarded';
import { businessWelcomeEmail } from '../welcome';

/**
 * Nothing sent to a business may point to WhatsApp or the client app: it
 * works from its dashboard, by email only.
 */
const RECEIPT = {
  description: 'Déblocage',
  amount: 5000,
  paidAt: new Date('2026-11-26T09:42:00Z'),
  method: 'Airtel Money',
  reference: 'PAY-1',
  invoiceAttached: true,
};

describe('emails to a business', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.FRONTEND_URL = 'https://client.example';
    process.env.BUSINESS_DASHBOARD_URL = 'https://business.example';
  });
  afterEach(() => {
    process.env = { ...env };
  });

  const dash = 'https://business.example/espace';
  const org = `${dash}/organisation`;
  const emails: [string, string][] = [
    [
      'welcome',
      businessWelcomeEmail('Awa', {
        businessName: 'Akieni',
        organisationUrl: org,
      }),
    ],
    ['approved', businessApprovedEmail('Awa', 'Akieni', dash)],
    ['refused', businessRejectedEmail('Awa', 'Akieni', 'Illisible', org)],
    [
      'document refused',
      businessDocumentRejectedEmail('Awa', 'Akieni', 'RCCM', 'Illisible', org),
    ],
    ['suspended', accountSuspendedEmail('Awa', 'Fraude', 'business')],
    ['receipt', paymentReceiptEmail('Awa', RECEIPT, 'business')],
    [
      'receipt without its PDF',
      paymentReceiptEmail(
        'Awa',
        { ...RECEIPT, invoiceAttached: false },
        'business',
      ),
    ],
    [
      'referral',
      referralRewardedEmail('Awa', {
        refereeName: 'Jo',
        creditedAmount: 500,
        appUrl: dash,
        audience: 'business',
      }),
    ],
    [
      'broadcast',
      broadcastEmail({
        firstName: 'Awa',
        body: 'Nouveau',
        link: '/recherche-offres',
        audience: 'business',
      }),
    ],
  ];

  it.each(emails)(
    '%s: signed Rabotka Business, no WhatsApp, no client link',
    (_name, html) => {
      expect(html).toContain("L'équipe Rabotka Business");
      expect(html).not.toMatch(/whatsapp/i);
      expect(html).not.toContain('client.example');
    },
  );

  it('opens the business space from a broadcast, never a client path', () => {
    const html = broadcastEmail({
      firstName: 'Awa',
      body: 'Nouveau',
      link: '/recherche-offres',
      audience: 'business',
    });
    expect(html).toContain(dash);
    expect(html).not.toContain('recherche-offres');
  });

  it('keeps the client link for a worker broadcast', () => {
    const html = broadcastEmail({
      firstName: 'Awa',
      body: 'Nouveau',
      link: '/recherche-offres',
    });
    expect(html).toContain('https://client.example/recherche-offres');
    expect(html).toContain("L'équipe Rabotka<");
  });
});
