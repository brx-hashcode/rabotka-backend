import {
  AFTER_CALL_DELAY_MS,
  InterviewReportService,
} from './interview-report.service';
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
    business: { name: 'ZuaFood', profile_id: 'bp1' },
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
  const transcripts = {
    merged: jest.fn().mockResolvedValue(''),
    span: jest.fn().mockResolvedValue({ first: null, last: null }),
  };
  const prisma = {
    interview: {
      findFirst: jest.fn().mockResolvedValue(row),
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    interviewReport: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      upsert: jest.fn().mockImplementation(({ create }) => ({
        notes: NOTES,
        report: null,
        generated_at: null,
        sent_at: null,
        updated_at: new Date(),
        ...create,
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
  const subscriptions = {
    businessOf: jest.fn().mockResolvedValue('b1'),
    entitlements: jest.fn().mockResolvedValue({ videoInterviews: true }),
  };
  const delayed = {
    isDelayed: jest.fn().mockResolvedValue(true),
    promote: jest.fn().mockResolvedValue(undefined),
  };
  const queue = {
    addJob: jest.fn().mockResolvedValue('job1'),
    getQueue: jest.fn(() => ({
      getJob: jest.fn().mockResolvedValue(delayed),
    })),
  };
  const events = { emit: jest.fn() };
  const service = new InterviewReportService(
    prisma as never,
    subscriptions as never,
    llm as never,
    mail as never,
    layout as never,
    transcripts as never,
    queue as never,
    events as never,
  );
  return {
    service,
    prisma,
    llm,
    mail,
    transcripts,
    queue,
    delayed,
    events,
    subscriptions,
  };
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

  it('refuses the AI report when the plan lacks the visio, notes kept', async () => {
    const { service, queue, subscriptions } = setup([], interview());
    subscriptions.entitlements.mockResolvedValue({ videoInterviews: false });
    await expect(service.write(actor, 'i1')).rejects.toThrow(
      'formules supérieures',
    );
    expect(queue.addJob).not.toHaveBeenCalled();
  });

  it('queues the writing and answers at once, without the model', async () => {
    const { service, llm, queue, prisma } = setup([GOOD]);
    const out = await service.write(actor, 'i1');
    expect(queue.addJob).toHaveBeenCalledWith('interview-report-queue', {
      interviewId: 'i1',
      memberId: 'm1',
    });
    expect(llm.invoke).not.toHaveBeenCalled();
    expect(prisma.interviewReport.upsert.mock.calls[0][0].update).toMatchObject(
      {
        writing_started_at: expect.any(Date),
        writing_error: null,
      },
    );
    expect(out.writing).toBe(true);
  });

  it('asked again while it is written: nothing more is queued', async () => {
    const { service, queue } = setup(
      [],
      interview({
        report: {
          notes: NOTES,
          report: null,
          generated_at: null,
          sent_at: null,
          updated_at: new Date(),
          writing_started_at: new Date(),
        },
      }),
    );
    const out = await service.write(actor, 'i1');
    expect(queue.addJob).not.toHaveBeenCalled();
    expect(out.writing).toBe(true);
  });

  it('writes from the notes, with the offer, the form and the CV as context, then tells the team', async () => {
    const { service, llm, prisma, events } = setup([GOOD]);
    await service.generate({ interviewId: 'i1', memberId: 'm1' });
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
    const saved = prisma.interviewReport.upsert.mock.calls[0][0].update;
    expect(saved.report.resume).toContain('Candidate motivée');
    expect(saved).toMatchObject({
      writing_started_at: null,
      writing_error: null,
    });
    expect(events.emit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        recipientId: 'bp1',
        input: expect.objectContaining({
          type: 'INTERVIEW_REPORT_READY',
          ok: true,
        }),
      }),
    );
  });

  it('writes from the transcript alone, merged by time, with no notes typed', async () => {
    const { service, llm, transcripts } = setup(
      [GOOD],
      interview({ report: null }),
    );
    transcripts.merged.mockResolvedValue(
      '[10:03] Awa Diop : J’ai fait deux ans de service en salle.\n[10:04] Paul : Et vos disponibilités ?',
    );
    await expect(service.write(actor, 'i1')).resolves.toBeTruthy();
    await service.generate({ interviewId: 'i1', memberId: null });
    const human = (llm.invoke.mock.calls[0][0] as { content: string }[])[1]
      .content;
    expect(human).toContain('TRANSCRIPTION DE L’ENTRETIEN');
    expect(human).toContain('[10:03] Awa Diop');
    expect(transcripts.merged).toHaveBeenCalledWith('i1');
  });

  it('tells the model the times really held, not only the planned ones', async () => {
    const { service, llm, transcripts } = setup(
      [GOOD],
      interview({
        call_started_at: new Date('2026-11-12T09:12:00Z'),
        ended_at: new Date('2026-11-12T09:40:00Z'),
      }),
    );
    transcripts.span.mockResolvedValue({
      first: new Date('2026-11-12T09:13:00Z'),
      last: new Date('2026-11-12T09:39:00Z'),
    });
    await service.generate({ interviewId: 'i1', memberId: 'm1' });
    const human = (llm.invoke.mock.calls[0][0] as { content: string }[])[1]
      .content;
    expect(human).toContain('de 10:12 à 10:40 (prévu à 10:00)');
    expect(human).toContain('28 min');
  });

  it('keeps the first moment the business joined the call', async () => {
    const { service, prisma } = setup([]);
    await service.markStarted(actor, 'i1');
    expect(prisma.interview.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { call_started_at: expect.any(Date) } }),
    );
    const again = setup(
      [],
      interview({ call_started_at: new Date('2026-11-12T09:12:00Z') }),
    );
    await again.service.markStarted(actor, 'i1');
    expect(again.prisma.interview.update).not.toHaveBeenCalled();
  });

  it('e-mails « Votre compte rendu est prêt » to the member who ran it', async () => {
    const { service, mail, prisma } = setup([GOOD]);
    prisma.businessMember.findFirst.mockResolvedValue({
      email: 'Paul@Example.com',
    });
    await service.generate({ interviewId: 'i1', memberId: 'm1' });
    expect(prisma.businessMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'm1', business_id: 'b1' }),
      }),
    );
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    const sent = mail.sendMail.mock.calls[0][0] as {
      to: string;
      subject: string;
      html: string;
    };
    expect(sent.to).toBe('paul@example.com');
    expect(sent.subject).toContain('Votre compte rendu est prêt');
    expect(sent.html).toContain('Candidate motivée');
    expect(sent.html).toContain('entretiens?compte-rendu=i1');
  });

  it('e-mails the recruiting contacts when no member ran it, never when it failed', async () => {
    const owner = setup([GOOD]);
    owner.prisma.businessMember.findMany.mockResolvedValue([
      { email: 'rh@example.com', name: 'Léa RH', is_owner: false },
    ]);
    await owner.service.generate({ interviewId: 'i1', memberId: null });
    expect(
      owner.mail.sendMail.mock.calls.map((c) => (c[0] as { to: string }).to),
    ).toEqual(['owner@example.com', 'rh@example.com']);

    const failed = setup(['non', 'toujours pas']);
    await failed.service.generate({ interviewId: 'i1', memberId: 'm1' });
    expect(failed.mail.sendMail).not.toHaveBeenCalled();
  });

  it('keeps the report when the e-mail fails', async () => {
    const { service, mail, prisma, events } = setup([GOOD]);
    mail.sendMail.mockRejectedValue(new Error('smtp down'));
    await service.generate({ interviewId: 'i1', memberId: null });
    expect(
      prisma.interviewReport.upsert.mock.calls[0][0].update.report,
    ).toBeTruthy();
    expect(events.emit).toHaveBeenCalled();
  });

  it('asks once more when the first answer is not JSON, then tells the team it failed', async () => {
    const retried = setup(['Bien sûr !', GOOD]);
    await retried.service.generate({ interviewId: 'i1', memberId: 'm1' });
    expect(retried.llm.invoke).toHaveBeenCalledTimes(2);

    const failed = setup(['non', 'toujours pas']);
    await failed.service.generate({ interviewId: 'i1', memberId: 'm1' });
    expect(
      failed.prisma.interviewReport.upsert.mock.calls[0][0].update,
    ).toMatchObject({
      writing_started_at: null,
      writing_error: expect.stringContaining('réessayez'),
    });
    expect(failed.events.emit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        input: expect.objectContaining({ ok: false }),
      }),
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

describe('the report after the call', () => {
  it('« Terminer »: written by itself two minutes later, once', async () => {
    const { service, queue, prisma } = setup(
      [GOOD],
      interview({ report: null }),
    );
    await service.afterCall('i1', 'm1');
    expect(queue.addJob).toHaveBeenCalledWith(
      expect.any(String),
      { interviewId: 'i1', memberId: 'm1', auto: true },
      { delay: AFTER_CALL_DELAY_MS, jobId: 'interview-report-after-call-i1' },
    );
    const at = prisma.interviewReport.upsert.mock.calls[0][0].create
      .writing_started_at as Date;
    expect(at.getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  it('never over a report already written, nor without the plan', async () => {
    const written = setup(
      [],
      interview({
        report: {
          notes: NOTES,
          report: null,
          generated_at: new Date(),
          sent_at: null,
          updated_at: new Date(),
        },
      }),
    );
    await written.service.afterCall('i1', 'm1');
    expect(written.queue.addJob).not.toHaveBeenCalled();

    const noPlan = setup([], interview({ report: null }));
    noPlan.subscriptions.entitlements.mockResolvedValue({
      videoInterviews: false,
    });
    await noPlan.service.afterCall('i1', 'm1');
    expect(noPlan.queue.addJob).not.toHaveBeenCalled();
  });

  it('« Rédiger maintenant » runs the waiting job now, instead of queuing another', async () => {
    const { service, queue, delayed } = setup(
      [],
      interview({
        report: {
          notes: NOTES,
          report: null,
          generated_at: null,
          sent_at: null,
          updated_at: new Date(),
          writing_started_at: new Date(Date.now() + 90_000),
        },
      }),
    );
    const v = await service.write(actor, 'i1');
    expect(delayed.promote).toHaveBeenCalled();
    expect(queue.addJob).not.toHaveBeenCalled();
    expect(v.writing).toBe(true);
    expect(v.scheduledFor).toBeNull();
  });

  it('says when it will be written while it waits', async () => {
    const { service } = setup(
      [],
      interview({
        report: {
          notes: NOTES,
          report: null,
          generated_at: null,
          sent_at: null,
          updated_at: new Date(),
          writing_started_at: new Date(Date.now() + 90_000),
        },
      }),
    );
    const v = await service.get(actor, 'i1');
    expect(v.writing).toBe(true);
    expect(v.scheduledFor).toEqual(expect.any(String));
  });

  it('nothing said, nothing noted: no report and no « failed » notice', async () => {
    const { service, llm, events, prisma } = setup(
      [GOOD],
      interview({
        report: {
          notes: '',
          report: null,
          generated_at: null,
          sent_at: null,
          updated_at: new Date(),
        },
      }),
    );
    await service.generate({ interviewId: 'i1', memberId: null, auto: true });
    expect(llm.invoke).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    expect(prisma.interviewReport.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { writing_started_at: null } }),
    );
  });

  it('ends a call nobody ended, half an hour after its planned end, and writes its report', async () => {
    const now = new Date('2026-11-15T12:00:00Z');
    const { service, prisma, queue } = setup([], interview({ report: null }));
    prisma.interview.findMany.mockResolvedValue([
      // Ended 10:30 + 30 min: past.
      {
        id: 'old',
        starts_at: new Date('2026-11-15T10:00:00Z'),
        duration_minutes: 30,
      },
      // A 2 h interview from 10:00: not over yet with its half hour.
      {
        id: 'long',
        starts_at: new Date('2026-11-15T10:00:00Z'),
        duration_minutes: 120,
      },
    ]);
    await expect(service.endForgotten(now)).resolves.toBe(1);
    expect(prisma.interview.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.interview.updateMany).toHaveBeenCalledWith({
      where: { id: 'old', ended_at: null },
      data: { ended_at: new Date('2026-11-15T10:30:00Z') },
    });
    expect(queue.addJob).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ auto: true, memberId: null }),
      expect.objectContaining({ delay: 0 }),
    );
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
