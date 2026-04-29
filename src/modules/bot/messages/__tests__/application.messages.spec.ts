import {
  formatCandidaturesListPage,
  formatCandidatureDetail,
  formatMyApplicationsList,
  formatMyApplicationDetailWithCancel,
  formatMyApplicationDetailReadOnly,
  formatApplyConfirmation,
  formatApplicationSentSuccess,
  formatNewApplicationToEmployer,
  formatApplicationAcceptedToWorker,
  formatApplicationRejectedToWorker,
  formatCancellationToEmployer,
  formatFilledJobsListPage,
  formatFilledJobDetail,
  formatJobCompletedToWorker,
  formatJobCancelledByEmployerToWorker,
  type CandidatureListItem,
  type ApplicationForList,
  type FilledJobListItem,
} from '../application.messages';

const date = new Date('2026-03-20T09:00:00');

function makeCandidate(
  overrides: Partial<CandidatureListItem> = {},
): CandidatureListItem {
  return {
    id: 'c1',
    fullName: 'Jean Dupont',
    firstName: 'Jean',
    lastName: 'Dupont',
    email: 'jean@test.com',
    status: 'PENDING',
    score: 85,
    ...overrides,
  };
}

function makeApplication(overrides = {}): ApplicationForList {
  return {
    id: 'a1',
    status: 'PENDING',
    job_offer: {
      id: 'o1',
      title: 'Livreur',
      scheduled_at: date,
      amount: 10000,
      payment_flow: 'DAILY',
      address: 'Kinshasa, Gombe',
      status: 'ACTIVE',
    },
    ...overrides,
  };
}

function makeFilledJob(
  overrides: Partial<FilledJobListItem> = {},
): FilledJobListItem {
  return {
    applicationId: 'a1',
    title: 'Livreur',
    workerName: 'Jean Dupont',
    scheduled_at: date,
    amount: 10000,
    payment_flow: 'DAILY',
    ...overrides,
  };
}

describe('formatCandidaturesListPage', () => {
  it('renders candidature list', () => {
    const msg = formatCandidaturesListPage([makeCandidate()], false);
    expect(msg).toContain('Jean');
    expect(msg).toContain('Dupont');
    expect(msg).toContain('85/100');
  });

  it('renders offerTitle when provided', () => {
    const msg = formatCandidaturesListPage(
      [makeCandidate({ offerTitle: 'Livreur' })],
      false,
    );
    expect(msg).toContain('Livreur');
  });

  it('shows "Voir plus" when hasMore=true', () => {
    const msg = formatCandidaturesListPage([makeCandidate()], true);
    expect(msg).toContain('Voir plus');
  });

  it('does not show "Voir plus" when hasMore=false', () => {
    const msg = formatCandidaturesListPage([makeCandidate()], false);
    expect(msg).not.toContain('Voir plus');
  });
});

describe('formatCandidatureDetail', () => {
  it('renders detail without avatar', () => {
    const msg = formatCandidatureDetail({
      firstName: 'Marie',
      lastName: 'Kanda',
      email: 'marie@test.com',
      status: 'VERIFIED',
      score: 90,
    });
    expect(msg).toContain('Marie');
    expect(msg).toContain('Vérifié');
    expect(msg).toContain('90/100');
  });

  it('renders with avatar URL as [IMG:...] prefix', () => {
    const msg = formatCandidatureDetail({
      firstName: 'Paul',
      lastName: 'Mbo',
      email: 'paul@test.com',
      status: 'PENDING',
      score: 75,
      avatarUrl: 'https://example.com/avatar.jpg',
    });
    expect(msg.startsWith('[IMG:https://example.com/avatar.jpg]')).toBe(true);
    expect(msg).toContain('Paul');
  });

  it('shows offerTitle when provided', () => {
    const msg = formatCandidatureDetail({
      firstName: 'X',
      lastName: 'Y',
      email: 'x@test.com',
      status: 'PENDING',
      score: 50,
      offerTitle: 'Manutentionnaire',
    });
    expect(msg).toContain('Manutentionnaire');
  });

  it('maps REJECTED status', () => {
    const msg = formatCandidatureDetail({
      firstName: 'A',
      lastName: 'B',
      email: 'a@b.com',
      status: 'REJECTED',
      score: 60,
    });
    expect(msg).toContain('Rejeté');
  });

  it('returns raw status for unknown status', () => {
    const msg = formatCandidatureDetail({
      firstName: 'A',
      lastName: 'B',
      email: 'a@b.com',
      status: 'UNKNOWN_STATUS',
      score: 60,
    });
    expect(msg).toContain('UNKNOWN_STATUS');
  });
});

describe('formatMyApplicationsList', () => {
  it('shows empty message when no applications', () => {
    const msg = formatMyApplicationsList([]);
    expect(msg).toContain("N'AVEZ AUCUNE CANDIDATURE");
  });

  it('renders applications list', () => {
    const msg = formatMyApplicationsList([makeApplication()]);
    expect(msg).toContain('Livreur');
    expect(msg).toContain('EN ATTENTE');
  });

  it('truncates long address', () => {
    const msg = formatMyApplicationsList([
      makeApplication({
        job_offer: { ...makeApplication().job_offer, address: 'A'.repeat(50) },
      }),
    ]);
    expect(msg).toContain('...');
  });

  it('renders ACCEPTED status', () => {
    const msg = formatMyApplicationsList([
      makeApplication({ status: 'ACCEPTED' }),
    ]);
    expect(msg).toContain('ACCEPTÉE');
  });

  it('renders VIEWED status', () => {
    const msg = formatMyApplicationsList([
      makeApplication({ status: 'VIEWED' }),
    ]);
    expect(msg).toContain("VUE PAR L'EMPLOYEUR");
  });

  it('renders REJECTED status', () => {
    const msg = formatMyApplicationsList([
      makeApplication({ status: 'REJECTED' }),
    ]);
    expect(msg).toContain('REFUSÉE');
  });

  it('renders CANCELLED status', () => {
    const msg = formatMyApplicationsList([
      makeApplication({ status: 'CANCELLED' }),
    ]);
    expect(msg).toContain('ANNULÉE');
  });
});

describe('formatMyApplicationDetailWithCancel', () => {
  it('renders detail with cancel action', () => {
    const msg = formatMyApplicationDetailWithCancel({
      jobTitle: 'Livreur',
      scheduled_at: date,
      amount: 10000,
      payment_flow: 'DAILY',
      address: 'Gombe',
      status: 'PENDING',
    });
    expect(msg).toContain('Livreur');
    expect(msg).toContain('Annuler');
    expect(msg).toContain('EN ATTENTE');
  });
});

describe('formatMyApplicationDetailReadOnly', () => {
  it('renders detail without cancel action', () => {
    const msg = formatMyApplicationDetailReadOnly({
      jobTitle: 'Cuisinier',
      scheduled_at: date,
      amount: 8000,
      payment_flow: 'HOURLY',
      address: 'Gombe',
      status: 'REJECTED',
    });
    expect(msg).toContain('Cuisinier');
    expect(msg).not.toContain('Annuler');
    expect(msg).toContain('REFUSÉE');
  });
});

describe('formatApplyConfirmation', () => {
  it('renders confirmation with worker info', () => {
    const msg = formatApplyConfirmation({
      title: 'Livreur',
      scheduled_at: date,
      amount: 10000,
      payment_flow: 'DAILY',
      address: 'Gombe',
      workerName: 'Jean Dupont',
      workerPhone: '06 000 000',
      workerEmail: 'jean@test.com',
      reliabilityScore: 90,
    });
    expect(msg).toContain('Livreur');
    expect(msg).toContain('Jean Dupont');
    expect(msg).toContain('06 000 000');
    expect(msg).toContain('90/100');
    expect(msg).toContain('Annulation < 4h avant');
  });

  it('uses lateCancellationThresholdHours from params', () => {
    const msg = formatApplyConfirmation({
      title: 'X',
      scheduled_at: date,
      amount: 1000,
      payment_flow: 'DAILY',
      address: 'Y',
      workerName: 'Z',
      workerPhone: '0',
      workerEmail: 'z@test.com',
      reliabilityScore: 80,
      lateCancellationThresholdHours: 12,
    });
    expect(msg).toContain('Annulation < 12h avant');
  });

  it('defaults reliabilityScore to 100 when null', () => {
    const msg = formatApplyConfirmation({
      title: 'X',
      scheduled_at: date,
      amount: 1000,
      payment_flow: 'DAILY',
      address: 'Y',
      workerName: 'Z',
      workerPhone: '0',
      workerEmail: 'z@test.com',
      reliabilityScore: null,
    });
    expect(msg).toContain('100/100');
  });
});

describe('formatApplicationSentSuccess', () => {
  it('includes offer title', () => {
    const msg = formatApplicationSentSuccess('Livreur express');
    expect(msg).toContain('Livreur express');
  });
});

describe('formatNewApplicationToEmployer', () => {
  it('renders notification to employer', () => {
    const msg = formatNewApplicationToEmployer({
      offerTitle: 'Manutentionnaire',
      workerName: 'Ali Bakr',
      workerPhone: '07 111 222',
      workerEmail: 'ali@test.com',
      workerDescription: 'Expérimenté',
      reliabilityScore: 80,
      completedMissions: 7,
      scheduledAt: date,
      address: 'Kinshasa',
    });
    expect(msg).toContain('Manutentionnaire');
    expect(msg).toContain('Ali Bakr');
    expect(msg).toContain('80/100');
    expect(msg).toContain('7');
  });

  it('truncates long description', () => {
    const msg = formatNewApplicationToEmployer({
      offerTitle: 'X',
      workerName: 'Y',
      workerPhone: '0',
      workerEmail: 'y@test.com',
      workerDescription: 'D'.repeat(250),
      reliabilityScore: null,
      completedMissions: 0,
      scheduledAt: date,
      address: 'Z',
    });
    expect(msg).toContain('...');
    expect(msg).toContain('100/100');
  });
});

describe('formatApplicationAcceptedToWorker', () => {
  it('includes employer name and phone', () => {
    const msg = formatApplicationAcceptedToWorker('M. Dupont', '06 999 888');
    expect(msg).toContain('M. Dupont');
    expect(msg).toContain('06 999 888');
  });
});

describe('formatApplicationRejectedToWorker', () => {
  it('returns non-empty string', () => {
    expect(formatApplicationRejectedToWorker().length).toBeGreaterThan(0);
  });
});

describe('formatCancellationToEmployer', () => {
  it('renders cancellation without late penalty', () => {
    const msg = formatCancellationToEmployer({
      workerName: 'Jean',
      offerTitle: 'Livreur',
      scheduledAt: date,
      reason: 'Empêchement personnel',
      wasLatePenalty: false,
    });
    expect(msg).toContain('Jean');
    expect(msg).toContain('Empêchement personnel');
    expect(msg).not.toContain('tardive');
  });

  it('shows late penalty note when wasLatePenalty=true', () => {
    const msg = formatCancellationToEmployer({
      workerName: 'Paul',
      offerTitle: 'Livreur',
      scheduledAt: date,
      reason: null,
      wasLatePenalty: true,
    });
    expect(msg).toContain('tardive');
    expect(msg).toContain('Aucune raison donnée');
    expect(msg).toContain('< 4h)');
  });

  it('uses lateCancellationThresholdHours in late penalty note', () => {
    const msg = formatCancellationToEmployer({
      workerName: 'Paul',
      offerTitle: 'Livreur',
      scheduledAt: date,
      reason: null,
      wasLatePenalty: true,
      lateCancellationThresholdHours: 6,
    });
    expect(msg).toContain('< 6h)');
  });
});

describe('formatFilledJobsListPage', () => {
  it('shows empty message when no items', () => {
    const msg = formatFilledJobsListPage([], false);
    expect(msg).toContain('Aucune mission pourvue');
  });

  it('renders job items', () => {
    const msg = formatFilledJobsListPage([makeFilledJob()], false);
    expect(msg).toContain('Livreur');
    expect(msg).toContain('Jean Dupont');
  });

  it('shows "Voir plus" when hasMore=true', () => {
    const msg = formatFilledJobsListPage([makeFilledJob()], true);
    expect(msg).toContain('Voir plus');
  });

  it('handles string date in formatDatePublic', () => {
    const msg = formatFilledJobsListPage(
      [makeFilledJob({ scheduled_at: '2026-03-20T09:00:00' })],
      false,
    );
    expect(msg).toContain('Livreur');
  });

  it('handles null/invalid date gracefully', () => {
    const msg = formatFilledJobsListPage(
      [makeFilledJob({ scheduled_at: null as any })],
      false,
    );
    expect(msg).toContain('—');
  });
});

describe('formatFilledJobDetail', () => {
  it('renders detail with all actions', () => {
    const msg = formatFilledJobDetail(makeFilledJob());
    expect(msg).toContain('Livreur');
    expect(msg).toContain('Jean Dupont');
    expect(msg).toContain('Marquer comme terminée');
  });
});

describe('formatJobCompletedToWorker', () => {
  it('includes offer title and amount', () => {
    const msg = formatJobCompletedToWorker({
      offerTitle: 'Livreur',
      amount: 12000,
    });
    expect(msg).toContain('Livreur');
    expect(msg).toContain('12');
  });
});

describe('formatJobCancelledByEmployerToWorker', () => {
  it('includes offer title', () => {
    const msg = formatJobCancelledByEmployerToWorker('Cuisinier');
    expect(msg).toContain('Cuisinier');
  });
});
