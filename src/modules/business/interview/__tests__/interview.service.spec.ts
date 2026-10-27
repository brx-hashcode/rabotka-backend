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
    interview: {
      create: jest.fn().mockImplementation(({ data }) => loaded(data)),
      update: jest.fn().mockImplementation(({ data }) => loaded(data)),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue(loaded()),
      findUnique: jest.fn().mockResolvedValue(loaded()),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const subscriptions: any = { businessOf: jest.fn().mockResolvedValue('b1') };
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
});
