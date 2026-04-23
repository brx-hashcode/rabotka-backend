import {
  computeContractPublicReference,
  inferMissionDurationDaysFromNote,
  missionEndDateInclusive,
  formatDurationFr,
  paymentFlowPayModeFr,
  addUtcCalendarDays,
  resolveMissionPeriodForContractPdf,
  MONTHLY_CONTRACT_END_OFFSET_DAYS,
} from '../contract-template.helpers';

describe('contract-template.helpers', () => {
  describe('computeContractPublicReference', () => {
    it('matches RBT-CONTRAT-{year}-{8hex} and is stable', () => {
      const createdAt = new Date('2026-06-15T12:00:00.000Z');
      const a = computeContractPublicReference({
        contractId: '7715f409-3534-4ba9-917d-85142652b0d1',
        createdAt,
      });
      const b = computeContractPublicReference({
        contractId: '7715f409-3534-4ba9-917d-85142652b0d1',
        createdAt,
      });
      expect(a).toBe(b);
      expect(a).toMatch(/^RBT-CONTRAT-2026-[0-9A-F]{8}$/);
    });
  });

  describe('inferMissionDurationDaysFromNote', () => {
    it('defaults to 1', () => {
      expect(inferMissionDurationDaysFromNote(null)).toBe(1);
      expect(inferMissionDurationDaysFromNote('')).toBe(1);
      expect(inferMissionDurationDaysFromNote('no duration here')).toBe(1);
    });
    it('parses jours in note', () => {
      expect(inferMissionDurationDaysFromNote('Mission 5 jours')).toBe(5);
      expect(inferMissionDurationDaysFromNote('durée 12 j.')).toBe(12);
    });
  });

  describe('missionEndDateInclusive', () => {
    it('adds N-1 calendar days in UTC', () => {
      const start = new Date(Date.UTC(2026, 1, 1, 10, 0, 0));
      const end = missionEndDateInclusive(start, 3);
      expect(end.getUTCDate()).toBe(3);
      expect(end.getUTCMonth()).toBe(1);
    });
  });

  describe('formatDurationFr', () => {
    it('singular and plural', () => {
      expect(formatDurationFr(1)).toBe('1 jour');
      expect(formatDurationFr(4)).toBe('4 jours');
    });
  });

  describe('paymentFlowPayModeFr', () => {
    it('maps enum', () => {
      expect(paymentFlowPayModeFr('DAILY')).toContain('journée');
      expect(paymentFlowPayModeFr(null)).toBe('-');
    });
  });

  describe('addUtcCalendarDays', () => {
    it('adds 30 days from acceptance anchor', () => {
      const accept = new Date(Date.UTC(2026, 3, 16, 14, 0, 0));
      const end = addUtcCalendarDays(accept, MONTHLY_CONTRACT_END_OFFSET_DAYS);
      expect(end.getUTCMonth()).toBe(4);
      expect(end.getUTCDate()).toBe(16);
    });
  });

  describe('resolveMissionPeriodForContractPdf', () => {
    it('uses acceptance + 30 days for MONTHLY regardless of note', () => {
      const contractCreatedAt = new Date(Date.UTC(2026, 3, 16, 10, 0, 0));
      const scheduledAt = new Date(Date.UTC(2026, 3, 16, 9, 0, 0));
      const p = resolveMissionPeriodForContractPdf({
        scheduledAt,
        contractCreatedAt,
        paymentFlow: 'MONTHLY',
        jobNote: '3 jours',
      });
      expect(p.durationLabel).toBe('30 jours');
      expect(p.endDate?.getUTCMonth()).toBe(4);
      expect(p.endDate?.getUTCDate()).toBe(16);
    });

    it('keeps note-based duration for DAILY', () => {
      const p = resolveMissionPeriodForContractPdf({
        scheduledAt: new Date(Date.UTC(2026, 1, 1, 8, 0, 0)),
        contractCreatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
        paymentFlow: 'DAILY',
        jobNote: '5 jours',
      });
      expect(p.durationLabel).toBe('5 jours');
      expect(p.endDate?.getUTCDate()).toBe(5);
    });
  });
});
