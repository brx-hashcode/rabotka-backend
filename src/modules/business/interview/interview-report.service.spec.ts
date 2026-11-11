import { InterviewReportService } from './interview-report.service';
import {
  buildInterviewReportHtml,
  interviewReportEmail,
  parseReport,
} from './interview-report';

const GOOD = JSON.stringify({
  resume: 'Candidate motivée, deux ans en salle, disponible en juin.',
  pointsForts: ['Expérience en service de mariage', null],
  pointsDeVigilance: ['Pas de permis'],
  reponsesCles: [
    { question: 'Disponibilité ?', reponse: 'Dès juin' },
    { question: '', reponse: 'x' },
  ],
  infosPratiques: { disponibilite: 'Juin', pretentions: null },
  avisRecruteur: '',
  prochainesEtapes: ['Appeler une référence'],
});

const NOTES =
  'Très à l’aise, deux ans de service en salle, dispo en juin, pas de permis.';

function interview(over: Record<string, unknown> = {}) {
  return {
    id: 'i1',
    business_id: 'b1',
    job_title: 'Serveur pour un mariage',
    candidate_name: 'Awa Diop',
    starts_at: new Date('2026-11-12T09:00:00Z'),
    mode: 'VIDEO',
    duration_minutes: 30,
    offer_id: 'o1',
    application_id: null,
    external_application_id: 'e1',
    cv_resume_id: null,
    business: { name: 'ZuaFood' },
    report: {
      notes: NOTES,
      report: null,
      generated_at: null,
      sent_at: null,
      updated_at: new Date(),
    },
    ...over,
  };
}

function setup(
  answers: string[],
  row: Record<string, unknown> | null = interview(),
) {
  const prisma = {
    interview: { findFirst: jest.fn().mockResolvedValue(row) },
    interviewReport: {
      upsert: jest.fn().mockImplementation(({ create }) => ({
        ...create,
        report: null,
        generated_at: null,
        sent_at: null,
        updated_at: new Date(),
      })),
      update: jest.fn().mockImplementation(({ data }) => ({
        notes: NOTES,
        report: null,
        generated_at: null,
        sent_at: null,
        updated_at: new Date(),
        ...data,
      })),
    },
    jobOffer: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ description: 'Service en salle.' }),
    },
    application: { findUnique: jest.fn() },
    externalApplication: {
      findUnique: jest.fn().mockResolvedValue({
        cv_resume_id: 'r1',
        answers: [
          { label: 'Permis ?', kind: 'YES_NO', value: 'no', passed: null },
        ],
      }),
    },
    cvScreeningResume: {
      findUnique: jest.fn().mockResolvedValue({
        summary: 'Bon profil.',
        strengths: ['Salle'],
        gaps: [],
      }),
    },
    businessMember: {
      findMany: jest.fn().mockResolvedValue([{ email: 'Chosen@Example.com' }]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    business: {
      findUnique: jest.fn().mockResolvedValue({
        profile: { email: 'owner@example.com', first_name: 'Ana' },
      }),
    },
  };
  const llm = {
    invoke: jest.fn(() =>
      Promise.resolve({ output: { content: answers.shift() ?? '' } }),
    ),
  };
  const mail = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const layout = { wrap: jest.fn((html: string) => Promise.resolve(html)) };
  const subscriptions = { businessOf: jest.fn().mockResolvedValue('b1') };
  const service = new InterviewReportService(
    prisma as never,
    subscriptions as never,
    llm as never,
    mail as never,
    layout as never,
  );
  return { service, prisma, llm, mail };
}

const actor = { profileId: 'p1', memberId: 'm1' };

describe('parseReport', () => {
  it('reads the JSON leniently: null items dropped, empty questions dropped', () => {
    const r = parseReport('```json\n' + GOOD + '\n```');
    expect(r?.pointsForts).toEqual(['Expérience en service de mariage']);
    expect(r?.reponsesCles).toEqual([
      { question: 'Disponibilité ?', reponse: 'Dès juin' },
    ]);
    expect(r?.infosPratiques).toEqual({
      disponibilite: 'Juin',
      pretentions: '',
      mobilite: '',
    });
  });

  it('refuses prose or a report without a summary', () => {
    expect(parseReport('Voici le compte rendu.')).toBeNull();
    expect(parseReport('{"resume": ""}')).toBeNull();
  });
});

describe('InterviewReportService', () => {
  it('scopes every call to the business', async () => {
    const { service, prisma } = setup([], null);
    await expect(service.get(actor, 'i1')).rejects.toThrow('introuvable');
    expect(prisma.interview.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'i1', business_id: 'b1' } }),
    );
  });

  it('saves the notes, cut to the limit', async () => {
    const { service, prisma } = setup([]);
    await service.saveNotes(actor, 'i1', 'x'.repeat(9000));
    const arg = prisma.interviewReport.upsert.mock.calls[0][0];
    expect(arg.create.notes).toHaveLength(8000);
    expect(arg.create).toMatchObject({
      business_id: 'b1',
      updated_by_member_id: 'm1',
    });
  });

  it('needs notes before writing', async () => {
    const { service, llm } = setup(
      [],
      interview({ report: { notes: 'court', report: null } }),
    );
    await expect(service.write(actor, 'i1')).rejects.toThrow('notes');
    expect(llm.invoke).not.toHaveBeenCalled();
  });

  it('writes from the notes, with the offer, the form and the CV as context', async () => {
    const { service, llm, prisma } = setup([GOOD]);
    const out = await service.write(actor, 'i1');
    expect(out.report?.resume).toContain('Candidate motivée');
    const [messages, options] = llm.invoke.mock.calls[0] as unknown as [
      { content: string }[],
      { tier: string },
    ];
    expect(options.tier).toBe('writing');
    const human = messages[1].content;
    expect(human).toContain(NOTES);
    expect(human).toContain('Service en salle.');
    expect(human).toContain('Permis ? : no');
    expect(human).toContain('Bon profil.');
    expect(prisma.cvScreeningResume.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'r1' } }),
    );
  });

  it('asks once more when the first answer is not JSON, then gives up', async () => {
    const retried = setup(['Bien sûr !', GOOD]);
    await expect(retried.service.write(actor, 'i1')).resolves.toBeTruthy();
    expect(retried.llm.invoke).toHaveBeenCalledTimes(2);

    const failed = setup(['non', 'toujours pas']);
    await expect(failed.service.write(actor, 'i1')).rejects.toThrow(
      'réessayez',
    );
  });

  it('sends to the team members chosen only, e-mail only', async () => {
    const report = parseReport(GOOD);
    const { service, mail, prisma } = setup(
      [],
      interview({
        report: {
          notes: NOTES,
          report,
          generated_at: new Date(),
          sent_at: null,
          updated_at: new Date(),
        },
      }),
    );
    const out = await service.send(actor, 'i1', [
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(prisma.businessMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ business_id: 'b1', status: 'ACTIVE' }),
      }),
    );
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(mail.sendMail.mock.calls[0][0].to).toBe('chosen@example.com');
    expect(out.sentTo).toBe(1);
    expect(prisma.interviewReport.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { sent_at: expect.any(Date) } }),
    );
  });

  it('refuses to send a report not written yet', async () => {
    const { service, mail } = setup([]);
    await expect(service.send(actor, 'i1')).rejects.toThrow('Rédigez');
    expect(mail.sendMail).not.toHaveBeenCalled();
  });
});

describe('interviewReportEmail', () => {
  it('escapes what the team wrote', () => {
    const r = parseReport(GOOD)!;
    const html = interviewReportEmail(
      { ...r, resume: '<script>x</script>' },
      {
        candidateName: 'Awa',
        jobTitle: 'Serveur',
        when: 'jeudi',
        url: 'https://x',
      },
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('Points de vigilance');
  });
});

describe('buildInterviewReportHtml', () => {
  it('numbers only the sections with content, and escapes the text', () => {
    const r = parseReport(GOOD)!;
    const html = buildInterviewReportHtml({
      report: { ...r, avisRecruteur: '', resume: '<b>x</b>' },
      businessName: 'ZuaFood',
      candidateName: 'Awa <Diop>',
      jobTitle: 'Serveur',
      when: 'jeudi',
      mode: 'En visio',
      durationMinutes: 30,
      generatedAt: '11 novembre 2026',
      logo: null,
    });
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('Awa &lt;Diop&gt;');
    expect(html).not.toContain('Avis du recruteur');
    // Résumé, points, réponses, infos, prochaines étapes: 05 is the last one.
    expect(html).toContain('>05<');
    expect(html).not.toContain('>06<');
  });
});
