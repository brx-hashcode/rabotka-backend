import type { AgentCommissionSettings } from '../../system-config/system-config.service';
import {
  type CommissionFacts,
  decideCommission,
  samePhone,
} from '../agent-commission-rules';

const SETTINGS: AgentCommissionSettings = {
  amountFcfa: 400,
  releaseEvent: 'UNLOCKED',
  confirmationHours: 72,
  requiresMomoWorker: true,
  requiresMomoEmployer: true,
  multiSeatMode: 'PER_PLACEMENT',
};

const FACTS: CommissionFacts = {
  agentActive: true,
  agentPhone: '+242061111111',
  workerPhones: ['242062222222', null],
  employerPhone: '+242063333333',
  employerCoveredAtJobLevel: false,
  workerPaidMomo: true,
  employerPaidMomo: true,
  carriesEmployerPayment: true,
};

const decide = (
  facts: Partial<CommissionFacts> = {},
  settings: Partial<AgentCommissionSettings> = {},
) => decideCommission({ ...FACTS, ...facts }, { ...SETTINGS, ...settings });

describe('samePhone', () => {
  it('compares numbers written differently', () => {
    expect(samePhone('+242 06 111 11 11', '242061111111')).toBe(true);
    expect(samePhone('+242061111111', '+242061111112')).toBe(false);
  });

  it('never matches a missing or unreadable number', () => {
    expect(samePhone(null, '+242061111111')).toBe(false);
    expect(samePhone('n/a', 'n/a')).toBe(false);
  });
});

describe('decideCommission', () => {
  it('pays a clean placement', () => {
    expect(decide()).toEqual({ eligible: true });
  });

  it.each([
    ['commissions are off', {}, { amountFcfa: 0 }, 'Commissions désactivées'],
    ['the agent is suspended', { agentActive: false }, {}, 'Agent suspendu'],
    [
      "the agent's phone is the worker's",
      { workerPhones: ['+242 06 111 11 11', null] },
      {},
      'numéro du travailleur',
    ],
    [
      "the agent's phone is the worker's direct line",
      { workerPhones: ['242062222222', '242061111111'] },
      {},
      'numéro du travailleur',
    ],
    [
      "the agent's phone is the employer's",
      { employerPhone: '242061111111' },
      {},
      "numéro de l'employeur",
    ],
    [
      'the worker paid with wallet credit',
      { workerPaidMomo: false },
      {},
      "travailleur n'a pas payé",
    ],
    [
      'the employer paid with wallet credit',
      { employerPaidMomo: false },
      {},
      "L'employeur n'a pas payé",
    ],
    [
      'a multi-seat seat that did not carry the payment, in FIRST_ONLY',
      { employerCoveredAtJobLevel: true, carriesEmployerPayment: false },
      { multiSeatMode: 'FIRST_ONLY' as const },
      'plusieurs postes',
    ],
  ])('refuses when %s', (_label, facts, settings, reason) => {
    const decision = decide(facts, settings);
    expect(decision.eligible).toBe(false);
    expect(decision.eligible === false && decision.reason).toContain(reason);
  });

  it('accepts wallet credit when an admin turned the Mobile Money rule off', () => {
    expect(
      decide(
        { workerPaidMomo: false, employerPaidMomo: false },
        { requiresMomoWorker: false, requiresMomoEmployer: false },
      ),
    ).toEqual({ eligible: true });
  });

  it('pays every seat of a multi-seat offer in PER_PLACEMENT', () => {
    expect(
      decide({
        employerCoveredAtJobLevel: true,
        carriesEmployerPayment: false,
      }),
    ).toEqual({ eligible: true });
  });
});
