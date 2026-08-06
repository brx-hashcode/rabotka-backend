import { sendWelcomeEmail } from '../templates/welcome';

const OPTS = { appUrl: 'https://rabotka.work', creditedBalance: 0 };

describe('sendWelcomeEmail', () => {
  describe('the copy that was wrong', () => {
    // This email is sent the moment the profile is created, when the KYC
    // documents have just been submitted and the account is PENDING_ACTIVATION.
    // It used to read as a task list for work the user had already done.
    it('does not ask the user to complete a profile they just submitted', () => {
      const html = sendWelcomeEmail('Jean', OPTS);

      expect(html).not.toContain('Pour activer votre compte');
      expect(html).not.toContain('compléter votre profil');
    });

    it('promises no phone call, because no code path makes one', () => {
      expect(sendWelcomeEmail('Jean', OPTS)).not.toContain('appeler');
    });

    it('frames activation as following verification', () => {
      expect(sendWelcomeEmail('Jean', OPTS)).toContain(
        'Une fois vos informations vérifiées, votre compte sera activé',
      );
    });

    it('closes on the same sentence as the onboarding success screen', () => {
      // Both land on the user at the same moment; they must not disagree.
      // Mirror of `statusPagesContent.success.whatsappMessage` in the client.
      expect(sendWelcomeEmail('Jean', OPTS)).toContain(
        'Vous recevrez un message sur WhatsApp dès que votre compte sera activé.',
      );
    });
  });

  describe('welcome credit', () => {
    it('announces the credit, formatted as the success screen formats it', () => {
      const html = sendWelcomeEmail('Jean', { ...OPTS, creditedBalance: 1000 });

      expect(html).toContain('crédit de bienvenue');
      expect(html).toContain((1000).toLocaleString('fr-FR'));
      expect(html).toContain('FCFA');
    });

    it('hides the block entirely when the grant failed', () => {
      // `grantWelcomeCredit` returns 0 on failure. An empty gift box reads
      // worse than no gift box, and the success screen hides it the same way.
      const html = sendWelcomeEmail('Jean', { ...OPTS, creditedBalance: 0 });

      expect(html).not.toContain('crédit de bienvenue');
      expect(html).not.toContain('FCFA');
      expect(html).not.toContain('🎁');
    });
  });

  describe('call to action', () => {
    it('links to the app — the old version named a next step with no destination', () => {
      expect(sendWelcomeEmail('Jean', OPTS)).toContain(
        'href="https://rabotka.work"',
      );
    });
  });

  it('escapes the name', () => {
    const html = sendWelcomeEmail('<script>alert(1)</script>', OPTS);

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
