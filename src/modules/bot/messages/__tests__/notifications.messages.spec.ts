import {
  formatAccountActivatedMessage,
  formatReminder24h,
  formatReminder2h,
} from '../notifications.messages';

const date = new Date('2026-03-15T08:00:00');

describe('notifications.messages', () => {
  describe('formatAccountActivatedMessage', () => {
    it('includes worker type label and actions', () => {
      const msg = formatAccountActivatedMessage({
        firstName: 'Jean',
        profileType: 'WORKER',
      });
      expect(msg).toContain('Jean');
      expect(msg).toContain('Worker');
      expect(msg).toContain("Consulter les offres d'emploi disponibles");
    });

    it('includes employer type label and actions', () => {
      const msg = formatAccountActivatedMessage({
        firstName: 'Marie',
        profileType: 'EMPLOYER',
      });
      expect(msg).toContain('Marie');
      expect(msg).toContain('Employer');
      expect(msg).toContain("Publier des offres d'emploi");
    });
  });

  describe('formatReminder24h', () => {
    it('includes offer title, address and employer info', () => {
      const msg = formatReminder24h({
        offerTitle: 'Livreur',
        scheduledAt: date,
        address: 'Kinshasa',
        amount: 15000,
        employerName: 'M. Dupont',
        employerPhone: '06 123 456',
        penaltyFcfa: 5000,
        thresholdHours: 4,
      });
      expect(msg).toContain('Livreur');
      expect(msg).toContain('Kinshasa');
      expect(msg).toContain('M. Dupont');
      expect(msg).toContain('06 123 456');
      expect(msg).toContain('15');
    });

    it('includes penalty warning', () => {
      const msg = formatReminder24h({
        offerTitle: 'X',
        scheduledAt: date,
        address: 'Y',
        amount: 5000,
        employerName: 'Z',
        employerPhone: '0',
        penaltyFcfa: 5000,
        thresholdHours: 4,
      });
      expect(msg).toContain('pénalité');
    });
  });

  describe('formatReminder2h', () => {
    it('includes offer title and employer info', () => {
      const msg = formatReminder2h({
        offerTitle: 'Manutentionnaire',
        scheduledAt: date,
        address: 'Gombe',
        employerName: 'Mme Martin',
        employerPhone: '07 654 321',
      });
      expect(msg).toContain('Manutentionnaire');
      expect(msg).toContain('Gombe');
      expect(msg).toContain('Mme Martin');
      expect(msg).toContain('07 654 321');
    });

    it('warns that cancellation deadline has passed', () => {
      const msg = formatReminder2h({
        offerTitle: 'X',
        scheduledAt: date,
        address: 'Y',
        employerName: 'Z',
        employerPhone: '0',
      });
      expect(msg).toContain("Dernier délai d'annulation");
    });
  });
});
