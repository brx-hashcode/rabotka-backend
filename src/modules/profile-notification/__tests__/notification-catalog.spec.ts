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
  {
    type: 'JOB_INVITATION',
    jobOfferId: 'o-1',
    jobTitle: 'Serveuse',
    businessName: 'Love Life',
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

  it('invites a worker to apply to an offer, by name', () => {
    expect(
      renderNotification({
        type: 'JOB_INVITATION',
        jobOfferId: 'o-1',
        jobTitle: 'Serveuse',
        businessName: 'Love Life',
      }),
    ).toEqual({
      title: 'Invitation à postuler',
      body: 'Love Life vous invite à postuler à « Serveuse ».',
      link: '/offres/o-1',
    });
  });

  it('sends a business to its candidates, never to WhatsApp', () => {
    const out = renderNotification({
      type: 'CONTACT_UNLOCKED',
      recipientRole: 'BUSINESS',
      applicationId: 'a-1',
      counterpartName: 'Awa K.',
      jobTitle: 'Plombier',
    });
    expect(out.link).toBe('/espace/candidatures?candidature=a-1');
    expect(out.body).not.toContain('WhatsApp');
    // The space's words, not the mechanics.
    expect(`${out.title} ${out.body}`).not.toMatch(/débloqu|déblocage/i);
    expect(out.body).not.toContain('..');
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

describe('admin subscription notices', () => {
  const later = new Date(Date.now() + 10 * 86400000).toISOString();
  const end = new Date(Date.now() + 40 * 86400000).toISOString();

  it('says when a granted plan only takes over later', () => {
    const out = renderNotification({
      type: 'BUSINESS_SUBSCRIPTION_GRANTED',
      planName: 'Pro',
      startsAt: later,
      endsAt: end,
    });
    expect(out.title).toBe('Formule attribuée');
    expect(out.body).toContain('prendra le relais');
    expect(out.link).toBe('/espace/abonnement');
  });

  it('says a plan granted to start now is active', () => {
    const out = renderNotification({
      type: 'BUSINESS_SUBSCRIPTION_GRANTED',
      planName: 'Pro',
      startsAt: new Date().toISOString(),
      endsAt: end,
    });
    expect(out.body).toContain('active jusqu’au');
    expect(out.body).not.toContain('prendra le relais');
  });

  it('adds the motif to a cancellation only when there is one', () => {
    const base = {
      type: 'BUSINESS_SUBSCRIPTION_CANCELLED',
      planName: 'Pro',
    } as const;
    expect(
      renderNotification({ ...base, reason: 'Fin du partenariat' }).body,
    ).toContain('Motif : Fin du partenariat.');
    expect(
      renderNotification({ ...base, reason: 'Contrat terminé.' }).body,
    ).toMatch(/Motif : Contrat terminé\.$/);
    for (const reason of [null, '   ']) {
      const out = renderNotification({ ...base, reason });
      expect(out.body).not.toContain('Motif');
      expect(out.body).not.toContain('null');
    }
  });
});

describe('business notices open the candidature they are about', () => {
  it('links a business contact notice to its candidature', () => {
    const out = renderNotification({
      type: 'CONTACT_UNLOCKED',
      recipientRole: 'BUSINESS',
      applicationId: 'a-1',
      counterpartName: 'Bakari Y.',
      jobTitle: 'Encadreur',
    });
    expect(out.link).toBe('/espace/candidatures?candidature=a-1');
  });

  it('falls back to the list without an application', () => {
    const out = renderNotification({
      type: 'CONTACT_UNLOCKED',
      recipientRole: 'BUSINESS',
      applicationId: null,
      counterpartName: 'Bakari Y.',
      jobTitle: null,
    });
    expect(out.link).toBe('/espace/candidatures');
  });

  it('carries the candidature on mission notices, keeping the mission path', () => {
    for (const type of [
      'APPLICATION_CANCELLED',
      'MISSION_COMPLETED',
    ] as const) {
      expect(
        renderNotification({
          type,
          jobOfferId: 'o-1',
          applicationId: 'a-1',
          jobTitle: 'Plombier',
          workerName: 'Awa K.',
        }).link,
      ).toBe('/missions/o-1?candidature=a-1');
    }
  });

  it('opens the candidature of an answered interview, else the interviews', () => {
    const base = {
      type: 'INTERVIEW_ANSWERED',
      candidateName: 'Awa K.',
      jobTitle: 'Plombier',
      when: 'jeudi 29 octobre à 10:00',
      answer: 'CONFIRMED',
    } as const;
    expect(renderNotification({ ...base, applicationId: 'a-1' }).link).toBe(
      '/espace/candidatures?candidature=a-1',
    );
    expect(renderNotification({ ...base, applicationId: null }).link).toBe(
      '/espace/entretiens',
    );
  });
});
