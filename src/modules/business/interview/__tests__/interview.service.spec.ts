import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InterviewService, hashToken } from '../interview.service';

const inHours = (h: number) =>
  new Date(Date.now() + h * 3_600_000).toISOString();

const loaded = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  business_id: 'b1',
  cv_resume_id: 'r1',
  application_id: null,
  offer_id: null,
  job_title: 'Caissier',
  candidate_name: 'Grâce',
  candidate_email: 'grace@example.com',
  starts_at: new Date(Date.now() + 48 * 3_600_000),
  duration_minutes: 45,
  mode: 'IN_PERSON',
  location: 'Avenue de la Paix',
  message: null,
  status: 'PENDING',
  response_note: null,
  responded_at: null,
  token_hash: 'h',
  reminded_at: null,
  created_at: new Date(),
  updated_at: new Date(),
  business: {
    name: 'ZuaFood',
    profile_id: 'p1',
    profile: { avatar_url: null, email: 'boss@zua.cg' },
  },
  application: null,
  ...over,
});

function make() {
  const prisma: any = {
    cvScreeningResume: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'r1',
        status: 'SCORED',
        candidate: { name: 'Grâce', email: 'Grace@Example.com' },
        screening: { job_title: 'Caissier', offer_id: null },
      }),
    },
    application: { findFirst: jest.fn() },
    // A careers-page candidate refused? (none here)
    externalApplication: { findFirst: jest.fn().mockResolvedValue(null) },
    // Who of the business is e-mailed: the holder, no team yet.
    business: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'b1',
        profile: { email: 'boss@zua.cg', first_name: 'Awa' },
      }),
    },
    businessMember: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    interview: {
      create: jest.fn().mockImplementation(({ data }) => loaded(data)),
      update: jest.fn().mockImplementation(({ data }) => loaded(data)),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue(loaded()),
      findUnique: jest.fn().mockResolvedValue(loaded()),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const subscriptions: any = {
    businessOf: jest.fn().mockResolvedValue('b1'),
    entitlements: jest.fn().mockResolvedValue({ videoInterviews: false }),
  };
  const mail: any = { sendMail: jest.fn().mockResolvedValue({ jobId: 'j' }) };
  const layout: any = {
    wrap: jest.fn((html: string) => Promise.resolve(html)),
  };
  const events: any = { emit: jest.fn() };
  return {
    service: new InterviewService(prisma, subscriptions, mail, layout, events),
    prisma,
    mail,
    events,
    subscriptions,
  };
}

const slot = {
  startsAt: inHours(48),
  durationMinutes: 45,
  mode: 'IN_PERSON' as const,
  location: 'Avenue de la Paix',
};

describe('InterviewService', () => {
  describe('create', () => {
    it('invites a CV candidate by e-mail, with the calendar file and a private link', async () => {
      const { service, prisma, mail } = make();
      const view = await service.create('p1', { ...slot, cvResumeId: 'r1' });

      const data = prisma.interview.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        business_id: 'b1',
        cv_resume_id: 'r1',
        candidate_name: 'Grâce',
        candidate_email: 'grace@example.com',
        job_title: 'Caissier',
        mode: 'IN_PERSON',
      });
      expect(data.token_hash).toMatch(/^[0-9a-f]{64}$/);
      const sent = mail.sendMail.mock.calls[0][0];
      expect(sent.to).toBe('grace@example.com');
      expect(sent.subject).toContain('Invitation à un entretien');
      expect(sent.html).toMatch(/\/entretien\/[A-Za-z0-9_-]{32}/);
      // The message only: the answer link in the text, no button.
      expect(sent.html).toContain('répondre à l’invitation</a>');
      expect(sent.html).not.toContain('margin:24px 0;');
      expect(sent.attachments[0]).toMatchObject({ filename: 'entretien.ics' });
      expect(view).toMatchObject({
        candidateEmail: 'grace@example.com',
        status: 'PENDING',
      });
    });

    it('needs exactly one candidate, an address in person, a link for a video, a date ahead', async () => {
      const { service } = make();
      await expect(service.create('p1', slot)).rejects.toThrow(
        'Choisissez le candidat',
      );
      await expect(
        service.create('p1', {
          ...slot,
          cvResumeId: 'r1',
          applicationId: 'a1',
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.create('p1', { ...slot, cvResumeId: 'r1', location: '' }),
      ).rejects.toThrow('adresse');
      await expect(
        service.create('p1', {
          ...slot,
          cvResumeId: 'r1',
          mode: 'VIDEO',
          location: 'meet.google.com/abc',
        }),
      ).rejects.toThrow('https://');
      await expect(
        service.create('p1', {
          ...slot,
          cvResumeId: 'r1',
          startsAt: inHours(-1),
        }),
      ).rejects.toThrow('à venir');
      await expect(
        service.create('p1', {
          ...slot,
          cvResumeId: 'r1',
          durationMinutes: 50,
        }),
      ).rejects.toThrow('Durée');
    });

    it('asks for an e-mail when the CV has none', async () => {
      const { service, prisma } = make();
      prisma.cvScreeningResume.findFirst.mockResolvedValue({
        id: 'r1',
        status: 'SCORED',
        candidate: { name: 'Prince', email: null },
        screening: { job_title: 'Caissier', offer_id: null },
      });
      await expect(
        service.create('p1', { ...slot, cvResumeId: 'r1' }),
      ).rejects.toThrow('e-mail du candidat');
      await service.create('p1', {
        ...slot,
        cvResumeId: 'r1',
        candidateEmail: 'prince@example.com',
      });
      expect(
        prisma.interview.create.mock.calls[0][0].data.candidate_email,
      ).toBe('prince@example.com');
    });

    it('plans a CV analysed for a Rabotka applicant on their application', async () => {
      const { service, prisma } = make();
      prisma.application.findFirst
        // The application that CV was analysed for…
        .mockResolvedValueOnce({ id: 'a1' })
        // …then the application itself, as the applicant path reads it.
        .mockResolvedValueOnce({
          id: 'a1',
          job_offer: { id: 'o1', title: 'Vendeur', status: 'ACTIVE' },
          worker: { first_name: 'Awa', last_name: 'K.' },
        });

      await service.create('p1', { ...slot, cvResumeId: 'r1' });

      expect(prisma.application.findFirst.mock.calls[0][0].where).toEqual({
        cv_resume_id: 'r1',
        cv_resume: { screening: { business_id: 'b1' } },
      });
      const { data } = prisma.interview.create.mock.calls[0][0];
      expect(data.application_id).toBe('a1');
      expect(data.cv_resume_id).toBeNull();
      // Read from their profile at send time, as for any applicant.
      expect(data.candidate_email).toBeNull();
      expect(prisma.cvScreeningResume.findFirst).not.toHaveBeenCalled();
    });

    it('invites an applicant in-app, by their own e-mail, never kept for the business', async () => {
      const { service, prisma, mail, events } = make();
      prisma.application.findFirst.mockResolvedValue({
        id: 'a1',
        job_offer: { id: 'o1', title: 'Vendeur' },
        worker: { first_name: 'Awa', last_name: 'K.' },
      });
      prisma.interview.create.mockImplementation(({ data }: { data: object }) =>
        loaded({
          ...data,
          application: { worker: { id: 'w1', email: 'awa@example.com' } },
        }),
      );

      const view = await service.create('p1', { ...slot, applicationId: 'a1' });

      expect(prisma.application.findFirst.mock.calls[0][0].where).toEqual({
        id: 'a1',
        job_offer: { employer_id: 'p1' },
        deleted_at: null,
      });
      expect(
        prisma.interview.create.mock.calls[0][0].data.candidate_email,
      ).toBeNull();
      expect(mail.sendMail.mock.calls[0][0].to).toBe('awa@example.com');
      expect(events.emit).toHaveBeenCalledWith(
        'profile.notification.create',
        expect.objectContaining({
          recipientId: 'w1',
          input: expect.objectContaining({ type: 'INTERVIEW_INVITED' }),
        }),
      );
      expect(view.candidateEmail).toBeNull();
    });
  });

  describe('the candidate’s answer', () => {
    it('finds the invitation by the hash of its link', async () => {
      const { service, prisma } = make();
      await service.byToken('tok');
      expect(prisma.interview.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { token_hash: hashToken('tok') } }),
      );
      prisma.interview.findUnique.mockResolvedValue(null);
      await expect(service.byToken('nope')).rejects.toThrow(NotFoundException);
    });

    it('records the answer and tells the business, in-app and by e-mail', async () => {
      const { service, prisma, mail, events } = make();
      await service.respond('tok', 'CONFIRMED', null);
      expect(prisma.interview.update.mock.calls[0][0].data).toMatchObject({
        status: 'CONFIRMED',
      });
      expect(events.emit).toHaveBeenCalledWith(
        'profile.notification.create',
        expect.objectContaining({
          recipientId: 'p1',
          input: expect.objectContaining({
            type: 'INTERVIEW_ANSWERED',
            answer: 'CONFIRMED',
          }),
        }),
      );
      expect(mail.sendMail.mock.calls[0][0].to).toBe('boss@zua.cg');
    });

    it('asks which times suit when another one is requested, and refuses a cancelled or past one', async () => {
      const { service, prisma } = make();
      await expect(
        service.respond('tok', 'RESCHEDULE_REQUESTED', '  '),
      ).rejects.toThrow('moments');
      prisma.interview.findUnique.mockResolvedValue(
        loaded({ status: 'CANCELLED' }),
      );
      await expect(service.respond('tok', 'CONFIRMED')).rejects.toThrow(
        'annulé',
      );
      prisma.interview.findUnique.mockResolvedValue(
        loaded({ starts_at: new Date(Date.now() - 1000) }),
      );
      await expect(service.respond('tok', 'CONFIRMED')).rejects.toThrow(
        'passé',
      );
    });
  });

  describe('the rules added after the audit', () => {
    it('sends no « demain » reminder for an interview within the day', async () => {
      const { service, prisma } = make();
      await service.create('p1', {
        ...slot,
        startsAt: inHours(5),
        cvResumeId: 'r1',
        candidateEmail: 'grace@example.com',
      });
      expect(
        prisma.interview.create.mock.calls[0][0].data.reminded_at,
      ).toBeInstanceOf(Date);

      const later = make();
      await later.service.create('p1', { ...slot, cvResumeId: 'r1' });
      expect(
        later.prisma.interview.create.mock.calls[0][0].data.reminded_at,
      ).toBeNull();
    });

    it('invites no candidate whose careers application was refused', async () => {
      const { service, prisma } = make();
      prisma.externalApplication.findFirst.mockResolvedValue({ id: 'x1' });
      await expect(
        service.create('p1', { ...slot, cvResumeId: 'r1' }),
      ).rejects.toThrow('refusée');
    });

    it('invites a careers candidate without a CV analysis, at the address they gave', async () => {
      const { service, prisma } = make();
      prisma.externalApplication.findFirst.mockResolvedValue({
        id: 'x1',
        first_name: 'Grâce',
        last_name: 'Mavoungou',
        email: ' Grace@Example.com ',
        status: 'PENDING',
        job_offer: { id: 'o1', title: 'Caissier', status: 'ACTIVE' },
      });
      await service.create('p1', { ...slot, externalApplicationId: 'x1' });
      expect(prisma.interview.create.mock.calls[0][0].data).toMatchObject({
        external_application_id: 'x1',
        cv_resume_id: null,
        application_id: null,
        candidate_name: 'Grâce Mavoungou',
        candidate_email: 'grace@example.com',
      });
    });

    it('ignores the same answer again, and paces changes of mind', async () => {
      const { service, prisma, mail } = make();
      prisma.interview.findUnique.mockResolvedValue(
        loaded({ status: 'CONFIRMED', response_note: null }),
      );
      await service.respond('tok', 'CONFIRMED', null);
      expect(prisma.interview.update).not.toHaveBeenCalled();
      expect(mail.sendMail).not.toHaveBeenCalled();

      prisma.interview.findUnique.mockResolvedValue(
        loaded({ status: 'CONFIRMED', responded_at: new Date() }),
      );
      await expect(service.respond('tok', 'DECLINED', null)).rejects.toThrow(
        'patientez',
      );
    });
  });

  describe('candidates who are out', () => {
    it('cancels their interview and tells them', async () => {
      const { service, prisma, mail } = make();
      prisma.interview.findMany.mockResolvedValue([{ id: 'i1' }]);

      await expect(service.closeEnded()).resolves.toBe(1);

      expect(prisma.interview.update.mock.calls[0][0].data.status).toBe(
        'CANCELLED',
      );
      expect(mail.sendMail.mock.calls[0][0].subject).toContain(
        'Entretien annulé',
      );
    });

    it('leaves an uploaded CV alone: only applicants are followed', async () => {
      const { service, prisma } = make();

      await service.closeEnded();

      const { where } = prisma.interview.findMany.mock.calls[0][0];
      expect(where.OR).toEqual([
        { application: expect.anything() },
        { cv_resume: { external_application: { status: 'REFUSED' } } },
      ]);
      expect(where).not.toHaveProperty('offer');
    });

    it('refuses a new interview on an ended offer', async () => {
      const { service, prisma } = make();
      prisma.application.findFirst.mockResolvedValue({
        job_offer: { id: 'o1', title: 'Caissier', status: 'EXPIRED' },
        worker: { first_name: 'Awa', last_name: 'Ngoma' },
      });

      await expect(
        service.create('p1', { ...slot, applicationId: 'a1' }),
      ).rejects.toThrow('ne recrute plus');
    });
  });

  describe('reschedule and cancel', () => {
    it('a new time is a new invitation, with a new link and no old answer', async () => {
      const { service, prisma, mail } = make();
      await service.reschedule('p1', 'i1', slot);
      const data = prisma.interview.update.mock.calls[0][0].data;
      expect(data).toMatchObject({
        status: 'PENDING',
        response_note: null,
        reminded_at: null,
      });
      expect(data.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(mail.sendMail.mock.calls[0][0].subject).toContain(
        'Entretien modifié',
      );
    });

    it('a new Rabotka visio link needs the plan; Meet, or the room it has, does not', async () => {
      const room = `${process.env.BUSINESS_DASHBOARD_URL ?? 'https://business.rabotka.work'}/visio/Rabotka-abcdef1234`;
      const video = { ...slot, mode: 'VIDEO' as const };
      const { service, prisma, subscriptions } = make();
      await expect(
        service.create('p1', { ...video, cvResumeId: 'r1', location: room }),
      ).rejects.toThrow('formules supérieures');
      await expect(
        service.create('p1', {
          ...video,
          cvResumeId: 'r1',
          location: 'https://meet.google.com/abc-defg-hij',
        }),
      ).resolves.toBeTruthy();
      // The interview with its room, then « no other business has it ».
      const booked = {
        ...(await prisma.interview.findFirst()),
        location: room,
      };
      prisma.interview.findFirst
        .mockResolvedValueOnce(booked)
        .mockResolvedValueOnce(null);
      await expect(
        service.reschedule('p1', 'i1', { ...video, location: room }),
      ).resolves.toBeTruthy();
      subscriptions.entitlements.mockResolvedValue({ videoInterviews: true });
      prisma.interview.findFirst.mockResolvedValue(null);
      await expect(
        service.create('p1', { ...video, cvResumeId: 'r1', location: room }),
      ).resolves.toBeTruthy();
    });

    it('cancelling tells the candidate, with a calendar cancellation', async () => {
      const { service, mail } = make();
      await service.cancel('p1', 'i1');
      const sent = mail.sendMail.mock.calls[0][0];
      expect(sent.subject).toContain('Entretien annulé');
      expect(sent.attachments[0].content).toContain('METHOD:CANCEL');
    });
  });

  describe('remind', () => {
    it('reminds both sides once, the day before', async () => {
      const { service, prisma, mail } = make();
      prisma.interview.findMany.mockResolvedValue([loaded()]);
      await expect(service.remind()).resolves.toBe(1);
      expect(
        mail.sendMail.mock.calls.map((c: [{ to: string }]) => c[0].to),
      ).toEqual(['grace@example.com', 'boss@zua.cg']);
      prisma.interview.updateMany.mockResolvedValue({ count: 0 });
      mail.sendMail.mockClear();
      await expect(service.remind()).resolves.toBe(0);
      expect(mail.sendMail).not.toHaveBeenCalled();
    });
  });

  describe('several times offered', () => {
    const times = [inHours(72), inHours(48), inHours(96)];

    it('stores the times sorted, starts at the earliest, and invites without an agenda file', async () => {
      const { service, prisma, mail } = make();
      // As Prisma returns it with LOAD: the nested create comes back as rows.
      prisma.interview.create.mockImplementation(({ data }: any) =>
        loaded({
          ...data,
          slots: data.slots.create.map((x: { starts_at: Date }, n: number) => ({
            id: `s${n}`,
            starts_at: x.starts_at,
          })),
        }),
      );
      await service.create('p1', {
        ...slot,
        startsAt: undefined,
        options: times,
        cvResumeId: 'r1',
      });
      const data = prisma.interview.create.mock.calls[0][0].data;
      expect(data.starts_at.toISOString()).toBe(times[1]);
      expect(
        data.slots.create.map((x: { starts_at: Date }) =>
          x.starts_at.toISOString(),
        ),
      ).toEqual([times[1], times[0], times[2]]);
      const sent = mail.sendMail.mock.calls[0][0];
      expect(sent.html).toContain('Choisir mon créneau');
      expect(sent.attachments ?? []).toHaveLength(0);
    });

    it('refuses more than three, or one in the past', async () => {
      const { service } = make();
      await expect(
        service.create('p1', {
          ...slot,
          options: [...times, inHours(120)],
          cvResumeId: 'r1',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.create('p1', {
          ...slot,
          options: [inHours(48), inHours(-1)],
          cvResumeId: 'r1',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    const offered = (over: Record<string, unknown> = {}) =>
      loaded({
        starts_at: new Date(times[1]),
        slots: [
          { id: 's1', starts_at: new Date(times[1]) },
          { id: 's2', starts_at: new Date(times[0]) },
        ],
        ...over,
      });

    it('confirming is choosing one: the time becomes it, the others go, the agenda file follows', async () => {
      const { service, prisma, mail } = make();
      prisma.interview.findUnique.mockResolvedValue(offered());
      await service.respond('tok', 'CONFIRMED', null, 's2');
      const data = prisma.interview.update.mock.calls[0][0].data;
      expect(data.status).toBe('CONFIRMED');
      expect(data.starts_at.toISOString()).toBe(times[0]);
      expect(data.slots).toEqual({ deleteMany: {} });
      const chosen = mail.sendMail.mock.calls.find((c: any[]) =>
        c[0].subject.startsWith('Entretien confirmé'),
      );
      expect(chosen[0].attachments).toHaveLength(1);
    });

    it('asks to choose when no time or an unknown one is given', async () => {
      const { service, prisma } = make();
      prisma.interview.findUnique.mockResolvedValue(offered());
      await expect(
        service.respond('tok', 'CONFIRMED', null),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.respond('tok', 'CONFIRMED', null, 'nope'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('sends no reminder of a time not chosen yet', async () => {
      const { service, prisma } = make();
      await service.remind();
      expect(prisma.interview.findMany.mock.calls[0][0].where.slots).toEqual({
        none: {},
      });
    });
  });
});
