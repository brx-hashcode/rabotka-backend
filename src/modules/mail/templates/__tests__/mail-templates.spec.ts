import { eventCreatedEmail } from '../event-created';
import { eventUpdatedEmail } from '../event-updated';
import { advertisementCreatedEmail } from '../advertisement-created';
import { accountSuspendedEmail } from '../account-suspended';
import { kycRejectedEmail } from '../kyc-rejected';
import { paymentRejectedEmail } from '../payment-rejected';
import { paymentSuccessEmail } from '../payment-success';

describe('Mail Templates', () => {
  describe('eventCreatedEmail', () => {
    it('generates email with all fields', () => {
      const html = eventCreatedEmail({
        name: 'Alice',
        title: 'Team Meeting',
        startDate: '2026-06-01T09:00:00Z',
        endDate: '2026-06-01T10:00:00Z',
        description: 'Meeting description',
        location: 'Office',
        googleCalendarUrl: 'https://calendar.google.com/event',
      });
      expect(html).toContain('Alice');
      expect(html).toContain('Team Meeting');
      expect(html).toContain('Office');
      expect(html).toContain('Meeting description');
      expect(html).toContain('Google Calendar');
    });

    it('generates email without optional fields', () => {
      const html = eventCreatedEmail({
        name: 'Bob',
        title: 'Meeting',
        startDate: '2026-06-01T09:00:00Z',
        endDate: '2026-06-01T10:00:00Z',
      });
      expect(html).toContain('Bob');
      expect(html).not.toContain('Google Calendar');
    });

    it('says nothing about repetition for a one-off event', () => {
      const html = eventCreatedEmail({
        name: 'Bob',
        title: 'Meeting',
        startDate: '2026-06-01T09:00:00Z',
        endDate: '2026-06-01T10:00:00Z',
      });
      expect(html).not.toContain('Répétition');
    });

    it('spells out the repeat rule when the event is a series', () => {
      // The only place a recipient is told the event recurs — they get one
      // message for the whole series, not one per occurrence.
      const html = eventCreatedEmail({
        name: 'Alice',
        title: 'Standup',
        startDate: '2026-06-01T09:00:00Z',
        endDate: '2026-06-01T09:15:00Z',
        // Midday rather than end-of-day: these templates format dates in the
        // server's timezone (as every other line in them does), so a 23:59Z
        // value would render as the following day on any host east of UTC and
        // make this assertion depend on where it runs.
        recurrence: { frequency: 'WEEKLY', until: '2026-12-31T12:00:00Z' },
      });
      expect(html).toContain('Répétition');
      expect(html).toContain('Toutes les semaines');
      expect(html).toContain('31 décembre 2026');
    });

    it('states the occurrence count when the series ends by count', () => {
      const html = eventCreatedEmail({
        name: 'Alice',
        title: 'Standup',
        startDate: '2026-06-01T09:00:00Z',
        endDate: '2026-06-01T09:15:00Z',
        recurrence: { frequency: 'DAILY', count: 10 },
      });
      expect(html).toContain('Tous les jours, 10 fois');
    });
  });

  describe('eventUpdatedEmail', () => {
    it('generates updated event email', () => {
      const html = eventUpdatedEmail({
        name: 'Alice',
        title: 'Team Meeting',
        startDate: '2026-06-01T09:00:00Z',
        endDate: '2026-06-01T10:00:00Z',
      });
      expect(html).toContain('Alice');
      expect(html).toContain('Team Meeting');
    });

    it('generates updated event email with all fields', () => {
      const html = eventUpdatedEmail({
        name: 'Bob',
        title: 'Update Meeting',
        startDate: '2026-06-01T09:00:00Z',
        endDate: '2026-06-01T10:00:00Z',
        description: 'Description',
        location: 'Office',
        googleCalendarUrl: 'https://calendar.google.com',
      });
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

  describe('accountSuspendedEmail', () => {
    it('states the reason the account was suspended', () => {
      const html = accountSuspendedEmail('Alice', 'Trois pénalités impayées');
      expect(html).toContain('Alice');
      expect(html).toContain('Motif :');
      expect(html).toContain('Trois pénalités impayées');
    });

    it('omits the motive block when no reason was given', () => {
      const html = accountSuspendedEmail('Bob');
      expect(html).toContain('Bob');
      expect(html).not.toContain('Motif :');
    });

    it('escapes a reason typed by an admin', () => {
      // The reason is free text from the admin console and lands in HTML.
      const html = accountSuspendedEmail('Alice', '<script>alert(1)</script>');
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
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
