import {
  computeContractPublicReference,
  inferMissionDurationDaysFromNote,
  missionEndDateInclusive,
  formatDurationFr,
  paymentFlowPayModeFr,
  addUtcCalendarDays,
  resolveMissionPeriodForContractPdf,
  MONTHLY_CONTRACT_END_OFFSET_DAYS,
  contractDescriptionSummary,
  CONTRACT_DESCRIPTION_COLUMN_CHARS,
  CONTRACT_DESCRIPTION_MAX_LINES,
} from '../contract-template.helpers';
import { EmploymentType } from '@prisma/client';

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

    it.each([
      EmploymentType.CDI,
      EmploymentType.CDD,
      EmploymentType.STAGE,
    ])('derives no period for a %s — nobody here knows one', (employmentType) => {
      // The term starts when the person actually begins working, off-platform,
      // on a day nobody reports to us, and `scheduled_at` on these types is the
      // day applications closed. Before this, a permanent contract came out of
      // the generator saying it lasted "1 jour" with both dates blank — a
      // falsehood on a legal document, stated with total confidence.
      const p = resolveMissionPeriodForContractPdf({
        scheduledAt: new Date(Date.UTC(2026, 1, 1, 8, 0, 0)),
        contractCreatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
        paymentFlow: 'MONTHLY',
        jobNote: null,
        employmentType,
      });
      expect(p.durationLabel).toBe('à convenir entre les parties');
      expect(p.startDate).toBeNull();
      expect(p.endDate).toBeNull();
    });

    it('still derives a period when the type is absent, i.e. a MISSION', () => {
      // Defaults to MISSION everywhere: a missing field must behave as it
      // always has, never silently take the new branch.
      const p = resolveMissionPeriodForContractPdf({
        scheduledAt: new Date(Date.UTC(2026, 1, 1, 8, 0, 0)),
        contractCreatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
        paymentFlow: 'DAILY',
        jobNote: '5 jours',
      });
      expect(p.durationLabel).toBe('5 jours');
    });
  });
});

describe('contractDescriptionSummary', () => {
  /** The real one that broke the layout: bullets, blank lines, five paragraphs. */
  const PLUMBING = `Nous constatons plusieurs symptômes liés à notre surpresseur et à la salle de bain :
- Fuite d'eau apparente : Il y'a un peu d'eau sur le carrelage à l'entrée de la salle de bain.

 - Bruits anormaux dans la tuyauterie : Dès que le surpresseur démarre ou l'ouverture d'un quelconque robinet de la maison, on entend un fort bruit de gonflement suivi d'un sifflement directement au niveau du robinet de lavabo de la salle de bain.

Précision: Le surpresseur est installé à l'extérieur loin de la salle de bain.

N.B: Je souhaiterais un diagnostic et possible une réparation, en cas de non entente, votre déplacement sera payé.`;

  /** Lays the summary out the way the column will. */
  const wrapped = (text: string): string[] => {
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length <= CONTRACT_DESCRIPTION_COLUMN_CHARS) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines;
  };

  it('never exceeds three lines in the column', () => {
    // The point of the whole helper: a longer row pushed the table past the
    // page and took the contract's layout with it.
    expect(wrapped(contractDescriptionSummary(PLUMBING)).length).toBeLessThanOrEqual(
      CONTRACT_DESCRIPTION_MAX_LINES,
    );
  });

  it('flattens the author’s own line breaks', () => {
    // Carrying bullets and blank lines into a narrow cell is most of what
    // wrecked the row — what gets measured should be the text, not the layout.
    const out = contractDescriptionSummary(PLUMBING);
    expect(out).not.toContain('\n');
    expect(out).not.toMatch(/ {2}/);
  });

  it('opens with the employer’s own first words', () => {
    expect(contractDescriptionSummary(PLUMBING)).toMatch(
      /^Nous constatons plusieurs symptômes/,
    );
  });

  it('marks that there is more, without a stray punctuation mark', () => {
    const out = contractDescriptionSummary(PLUMBING);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/[\s,;:.-]…$/u);
  });

  it('cuts on a word boundary, never mid-word', () => {
    const out = contractDescriptionSummary(PLUMBING);
    const lastWord = out.slice(0, -1).trim().split(' ').pop() ?? '';
    expect(PLUMBING.replace(/\s+/gu, ' ')).toContain(lastWord);
  });

  it('leaves a short description exactly as written', () => {
    const short = 'Réparer le robinet de la cuisine.';
    expect(contractDescriptionSummary(short)).toBe(short);
    expect(contractDescriptionSummary(short)).not.toContain('…');
  });

  it('gives the template a dash rather than an empty cell', () => {
    // The rest of the contract's variables use '-' for absent values; an empty
    // cell reads as a rendering fault.
    expect(contractDescriptionSummary(null)).toBe('-');
    expect(contractDescriptionSummary('   \n  ')).toBe('-');
  });

  it('still cuts a single word too long for one line', () => {
    // A URL, usually. Without the hard cut there is no boundary to break on.
    const wall = 'a'.repeat(400);
    const out = contractDescriptionSummary(wall);
    expect(wrapped(out).length).toBeLessThanOrEqual(CONTRACT_DESCRIPTION_MAX_LINES);
    expect(out.endsWith('…')).toBe(true);
  });

  it('drops the list markers it inherits', () => {
    // Run into one paragraph, a leading "-" reads as a stray dash.
    const out = contractDescriptionSummary('Titre :\n- premier point\n- second');
    expect(out).not.toContain('- ');
  });
});
