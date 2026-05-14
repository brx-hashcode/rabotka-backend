import { eventCreatedEmail } from '../event-created';
import { eventUpdatedEmail } from '../event-updated';
import { advertisementCreatedEmail } from '../advertisement-created';
import { kycRejectedEmail } from '../kyc-rejected';
import { paymentRejectedEmail } from '../payment-rejected';
import { paymentSuccessEmail } from '../payment-success';

describe('Mail Templates', () => {
  describe('eventCreatedEmail', () => {
    it('generates email with all fields', () => {
      const html = eventCreatedEmail(
        'Alice',
        'Team Meeting',
        '2026-06-01T09:00:00Z',
        '2026-06-01T10:00:00Z',
        'Meeting description',
        'Office',
        'https://calendar.google.com/event',
      );
      expect(html).toContain('Alice');
      expect(html).toContain('Team Meeting');
      expect(html).toContain('Office');
      expect(html).toContain('Meeting description');
      expect(html).toContain('Google Calendar');
    });

    it('generates email without optional fields', () => {
      const html = eventCreatedEmail(
        'Bob',
        'Meeting',
        '2026-06-01T09:00:00Z',
        '2026-06-01T10:00:00Z',
      );
      expect(html).toContain('Bob');
      expect(html).not.toContain('Google Calendar');
    });
  });

  describe('eventUpdatedEmail', () => {
    it('generates updated event email', () => {
      const html = eventUpdatedEmail(
        'Alice',
        'Team Meeting',
        '2026-06-01T09:00:00Z',
        '2026-06-01T10:00:00Z',
      );
      expect(html).toContain('Alice');
      expect(html).toContain('Team Meeting');
    });

    it('generates updated event email with all fields', () => {
      const html = eventUpdatedEmail(
        'Bob',
        'Update Meeting',
        '2026-06-01T09:00:00Z',
        '2026-06-01T10:00:00Z',
        'Description',
        'Office',
        'https://calendar.google.com',
      );
      expect(html).toContain('Bob');
      expect(html).toContain('Office');
    });
  });

  describe('advertisementCreatedEmail', () => {
    it('generates advertisement email with all fields', () => {
      const html = advertisementCreatedEmail({
        name: 'John',
        title: 'Amazing Ad',
        startDate: '2026-06-01T00:00:00Z',
        endDate: '2026-06-30T00:00:00Z',
        description: 'Great product\nNew line',
        callToAction: 'Learn More',
        ctaUrl: 'https://example.com',
        imageUrl: 'https://example.com/image.jpg',
        tags: ['tag1', 'tag2'],
      });
      expect(html).toContain('John');
      expect(html).toContain('Amazing Ad');
      expect(html).toContain('tag1');
      expect(html).toContain('Learn More');
    });

    it('generates advertisement email with minimal fields', () => {
      const html = advertisementCreatedEmail({
        name: 'John',
        title: 'Simple Ad',
        startDate: '2026-06-01T00:00:00Z',
        endDate: '2026-06-30T00:00:00Z',
      });
      expect(html).toContain('John');
      expect(html).toContain('Simple Ad');
    });
  });

  describe('kycRejectedEmail', () => {
    it('generates KYC rejected email', () => {
      const html = kycRejectedEmail('Alice', 'Documents manquants');
      expect(html).toContain('Alice');
      expect(html).toContain('Documents manquants');
    });

    it('generates KYC rejected email without reason', () => {
      const html = kycRejectedEmail('Bob');
      expect(html).toContain('Bob');
    });
  });

  describe('paymentRejectedEmail', () => {
    it('generates payment rejected email with reason', () => {
      const html = paymentRejectedEmail('Fonds insuffisants');
      expect(html).toContain('rejet');
    });

    it('generates payment rejected email without reason', () => {
      const html = paymentRejectedEmail();
      expect(html).toContain('rejet');
    });
  });

  describe('paymentSuccessEmail', () => {
    it('generates payment success email', () => {
      const html = paymentSuccessEmail('Alice', 'Paiement de service', 5000);
      expect(html).toContain('Alice');
      expect(html).toContain('Paiement de service');
    });
  });
});
