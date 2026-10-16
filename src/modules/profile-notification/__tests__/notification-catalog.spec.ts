import { PaymentRequestType } from '@prisma/client';
import {
  paymentKindOf,
  personName,
  renderNotification,
  type NotificationInput,
} from '../notification-catalog';

/** One representative input per type — the list must stay exhaustive. */
const SAMPLES: NotificationInput[] = [
  { type: 'PROFILE_VIEW', sector: 'Restauration', city: 'Brazzaville' },
  { type: 'JOB_RECOMMENDATION', jobOfferId: 'o-1', jobTitle: 'Plombier' },
  {
    type: 'APPLICATION_ACCEPTED',
    applicationId: 'a-1',
    jobTitle: 'Plombier',
    paymentPending: false,
  },
  { type: 'APPLICATION_REJECTED', jobTitle: 'Plombier', automatic: false },
  { type: 'HIRE_CANCELLED', jobTitle: 'Plombier' },
  {
    type: 'JOB_OFFER_UPDATED',
    applicationId: 'a-1',
    jobTitle: 'Plombier',
    changes: ['la date', 'le lieu'],
  },
  {
    type: 'MISSION_RATED',
    score: 4,
    jobTitle: 'Plombier',
    rateeRole: 'WORKER',
    applicationId: 'a-1',
    jobOfferId: 'o-1',
  },
  {
    type: 'NEW_APPLICATION',
    applicationId: 'a-1',
    jobTitle: 'Plombier',
    workerName: 'Awa K.',
  },
  {
    type: 'APPLICATION_CANCELLED',
    jobOfferId: 'o-1',
    jobTitle: 'Plombier',
    workerName: 'Awa K.',
  },
  {
    type: 'MISSION_COMPLETED',
    jobOfferId: 'o-1',
    jobTitle: 'Plombier',
    workerName: 'Awa K.',
  },
  {
    type: 'CONTACT_UNLOCKED',
    recipientRole: 'EMPLOYER',
    applicationId: 'a-1',
    counterpartName: 'Awa K.',
    jobTitle: 'Plombier',
  },
  { type: 'PAYMENT_SUCCEEDED', amount: 2500, kind: 'WALLET_TOP_UP' },
  { type: 'PAYMENT_FAILED', amount: 2500, kind: 'PENALTY' },
  { type: 'CLAIM_COMMENTED', claimId: 'c-1', claimTitle: 'Paiement' },
  {
    type: 'CLAIM_STATUS_CHANGED',
    claimId: 'c-1',
    claimTitle: 'Paiement',
    status: 'COMPLETED',
  },
  {
    type: 'SIMILAR_PROFILE_HIRED',
    categoryName: 'Manutention',
    city: 'Brazzaville',
    step: 'PORTFOLIO',
  },
  {
    type: 'MISSION_REMINDER',
    when: 'TOMORROW',
    applicationId: 'a-1',
    jobTitle: 'Plombier',
    schedule: '01/06/2026 11:00',
    address: 'Poto-Poto',
  },
  { type: 'MISSION_STARTED', jobOfferId: 'o-1', jobTitle: 'Plombier' },
  { type: 'MISSION_STATUS_CHECK', jobOfferId: 'o-1', jobTitle: 'Plombier' },
  {
    type: 'JOB_OFFER_EXPIRED',
    recipientRole: 'EMPLOYER',
    jobOfferId: 'o-1',
    jobTitle: 'Plombier',
  },
  { type: 'KYC_REJECTED', reason: 'Pièce illisible' },
  { type: 'ACCOUNT_SUSPENDED', reason: null },
  { type: 'UNLOCK_CONVERTED_TO_CREDIT', amount: 500 },
];

describe('renderNotification', () => {
  it.each(SAMPLES.map((s) => [s.type, s] as const))(
    '%s renders a title, a body and an in-app link',
    (_type, input) => {
      const out = renderNotification(input);
      expect(out.title.trim()).not.toBe('');
      expect(out.body.trim()).not.toBe('');
      // Either an in-app path or deliberately nothing to open.
      if (out.link !== null) expect(out.link).toMatch(/^\//);
      expect(out.body).not.toContain('undefined');
      expect(out.body).not.toContain('null');
    },
  );

  it('keeps profile views anonymous', () => {
    const out = renderNotification(SAMPLES[0]);
    expect(out.body).toBe(
      'Un employeur du secteur Restauration à Brazzaville a consulté votre profil.',
    );
  });

  it('makes an unlock informational, whoever receives it', () => {
    for (const recipientRole of ['EMPLOYER', 'WORKER'] as const) {
      for (const applicationId of ['a-1', null]) {
        const out = renderNotification({
          type: 'CONTACT_UNLOCKED',
          recipientRole,
          applicationId,
          counterpartName: 'Awa K.',
          jobTitle: null,
        });
        expect(out.link).toBeNull();
        // The initial's full stop is not doubled.
        expect(out.body).not.toContain('..');
        expect(out.body).toContain('WhatsApp');
      }
    }
  });

  it('never links to the hidden contacts list', () => {
    for (const input of SAMPLES) {
      expect(renderNotification(input).link ?? '').not.toContain(
        'profils-contactes',
      );
    }
    expect(
      renderNotification({
        type: 'PAYMENT_SUCCEEDED',
        amount: 1000,
        kind: 'RECOMMENDATION_CONTACT',
      }).link,
    ).toBe('/portefeuille');
  });

  it('sends an accepted worker who still owes the fee to the payment page', () => {
    expect(
      renderNotification({
        type: 'APPLICATION_ACCEPTED',
        applicationId: 'a-1',
        jobTitle: 'X',
        paymentPending: true,
      }).link,
    ).toBe('/applications/a-1/paiement');
  });

  it('formats amounts with plain spaces', () => {
    const out = renderNotification({
      type: 'PAYMENT_SUCCEEDED',
      amount: 1234567,
      kind: 'WALLET_TOP_UP',
    });
    expect(out.body).toContain('1 234 567 FCFA');
  });

  it('sends a failed penalty payment back to the payment page', () => {
    expect(
      renderNotification({ type: 'PAYMENT_FAILED', amount: 1, kind: 'PENALTY' })
        .link,
    ).toBe('/penalites/paiement');
  });

  it('drops the title quote when there is no title', () => {
    const out = renderNotification({
      type: 'APPLICATION_REJECTED',
      jobTitle: null,
      automatic: true,
    });
    expect(out.body).not.toContain('«');
  });
});

describe('paymentKindOf', () => {
  it('maps request types, treating null as a penalty', () => {
    expect(paymentKindOf(PaymentRequestType.WALLET_TOP_UP)).toBe(
      'WALLET_TOP_UP',
    );
    expect(paymentKindOf(PaymentRequestType.CONTACT_UNLOCK)).toBe(
      'CONTACT_UNLOCK',
    );
    expect(paymentKindOf(PaymentRequestType.RECOMMENDATION_CONTACT)).toBe(
      'RECOMMENDATION_CONTACT',
    );
    expect(paymentKindOf(PaymentRequestType.PENALTY_BATCH)).toBe('PENALTY');
    expect(paymentKindOf(null)).toBe('PENALTY');
  });
});

describe('personName', () => {
  it('shortens to first name and initial', () => {
    expect(personName('Awa', 'kouassi', 'X')).toBe('Awa K.');
    expect(personName('Awa', '', 'X')).toBe('Awa');
    expect(personName('  ', 'K', 'Un travailleur')).toBe('Un travailleur');
  });
});

describe('SIMILAR_PROFILE_HIRED', () => {
  it('names the trade and the area, never the person, and gives one step', () => {
    const r = renderNotification({
      type: 'SIMILAR_PROFILE_HIRED',
      categoryName: 'Manutention',
      city: 'Brazzaville',
      step: 'PHOTO',
    });
    expect(r.title).toBe('Des profils comme le vôtre sont recrutés');
    expect(r.body).toContain('recruté en Manutention à Brazzaville');
    // The step leads: the bell clips the body to two lines.
    expect(r.body).toMatch(/^Ajoutez une photo/);
    expect(r.link).toBe('/profile');
  });

  it('links the portfolio step to the portfolio', () => {
    expect(
      renderNotification({
        type: 'SIMILAR_PROFILE_HIRED',
        categoryName: 'Couture',
        city: null,
        step: 'PORTFOLIO',
      }),
    ).toMatchObject({ link: '/profile/portfolio' });
  });

  describe('events moved off WhatsApp', () => {
    it('reminds the worker the day before, with the place, linking to the mission', () => {
      expect(
        renderNotification({
          type: 'MISSION_REMINDER',
          when: 'TOMORROW',
          applicationId: 'a-1',
          jobTitle: 'Plombier',
          schedule: '01/06/2026 11:00',
          address: 'Poto-Poto',
        }),
      ).toEqual({
        title: 'Votre mission commence demain',
        body: '« Plombier » — 01/06/2026 11:00 · Poto-Poto. Prévenez l’employeur au plus tôt si vous ne pouvez plus venir.',
        link: '/applications/a-1',
      });
    });

    it('sends an expired applicant to the offers, the employer to their offer', () => {
      const base = { jobOfferId: 'o-1', jobTitle: 'Plombier' };
      expect(
        renderNotification({
          type: 'JOB_OFFER_EXPIRED',
          recipientRole: 'WORKER',
          ...base,
        }).link,
      ).toBe('/recherche-offres');
      expect(
        renderNotification({
          type: 'JOB_OFFER_EXPIRED',
          recipientRole: 'EMPLOYER',
          ...base,
        }).link,
      ).toBe('/job-offers/o-1');
    });

    it('says why when a reason is given, and stays readable without one', () => {
      expect(
        renderNotification({ type: 'KYC_REJECTED', reason: 'Pièce illisible' })
          .body,
      ).toContain('Motif : Pièce illisible.');
      expect(
        renderNotification({ type: 'ACCOUNT_SUSPENDED', reason: null }).body,
      ).toContain('Motif : non précisé.');
    });
  });
});
