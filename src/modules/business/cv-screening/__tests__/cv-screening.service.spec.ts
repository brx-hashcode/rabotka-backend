import { Readable } from 'node:stream';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CvScreeningService } from '../cv-screening.service';
import { CV_SCREENING_PROGRESS } from '../cv-screening.events';

const PDF = Buffer.from('%PDF-1.7 a cv that is not really one');
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]);

const file = (name: string, buffer = PDF, mimetype = 'application/pdf') => ({
  originalname: name,
  mimetype,
  size: buffer.length,
  buffer,
});

const entitlements = (over: Record<string, unknown> = {}) => ({
  cvQuota: 10,
  cvRemaining: 10,
  cvBatchMax: 3,
  cvFileMaxMb: 1,
  cvRetentionDays: 30,
  trialLocked: [],
  ...over,
});

const JOB = {
  jobTitle: 'Caissier',
  jobText: 'Tenir la caisse, accueillir les clients, faire les inventaires.',
};

const ANSWER = JSON.stringify({
  isCv: true,
  candidate: { name: 'Awa', email: 'a@b.c', phone: '06' },
  criteria: { skills: 80, experience: 60 },
  summary: 'Bien.',
  strengths: ['Caisse'],
  gaps: [],
});

function make() {
  const prisma: any = {
    jobOffer: { findFirst: jest.fn() },
    externalApplication: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
    businessSubscription: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ plan: { cv_retention_days: 30 } }),
    },
    cvScreening: {
      create: jest.fn().mockImplementation(({ data }) => ({
        ...data,
        status: 'PROCESSING',
        created_at: new Date(),
        purged_at: null,
        resumes: data.resumes.create.map((r: object, i: number) => ({
          ...r,
          id: `r${i}`,
          status: 'QUEUED',
          score: null,
          created_at: new Date(),
        })),
      })),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockReturnValue('screening-update'),
    },
    cvResumeMessage: {
      deleteMany: jest.fn().mockReturnValue('messages-delete'),
    },
    cvComparisonMessage: {
      deleteMany: jest.fn().mockReturnValue('comparison-messages-delete'),
    },
    cvScreeningResume: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockReturnValue('resume-update'),
    },
    $transaction: jest.fn().mockResolvedValue([]),
  };
  const storage: any = {
    upload: jest
      .fn()
      .mockImplementation((_b: Buffer, name: string) => ({ key: `k/${name}` })),
    download: jest.fn(),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const queue: any = { addJob: jest.fn().mockResolvedValue('job') };
  const llm: any = {
    invoke: jest.fn().mockResolvedValue({ output: { content: ANSWER } }),
    usableChain: jest.fn().mockResolvedValue([
      { provider: 'google', model: 'g' },
      { provider: 'openai', model: 'o' },
    ]),
    invokeWith: jest.fn().mockResolvedValue({ output: { content: ANSWER } }),
  };
  const subscriptions: any = {
    businessOf: jest.fn().mockResolvedValue('b1'),
    entitlements: jest.fn().mockResolvedValue(entitlements()),
    consumeCv: jest.fn().mockResolvedValue({ subscriptionId: 'sub-1' }),
    releaseCv: jest.fn().mockResolvedValue(undefined),
  };
  const systemConfig: any = { get: jest.fn().mockResolvedValue('kyc-bucket') };
  const config: any = { get: jest.fn().mockReturnValue('') };
  const events: any = { emit: jest.fn() };
  const service = new CvScreeningService(
    prisma,
    storage,
    queue,
    llm,
    subscriptions,
    systemConfig,
    config,
    events,
  );
  return { service, prisma, storage, queue, llm, subscriptions, events };
}

const queued = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  status: 'QUEUED',
  mime_type: 'image/png',
  storage_key: 'k/r1.png',
  storage_bucket: 'kyc-bucket',
  created_at: new Date(),
  screening: {
    id: 's1',
    subscription_id: 'sub-1',
    job_title: 'Caissier',
    job_text: 'Tenir la caisse.',
  },
  ...over,
});

const closing = (statuses: string[]) => ({
  id: 's1',
  job_title: 'Caissier',
  status: 'PROCESSING',
  business: { profile_id: 'p1' },
  resumes: statuses.map((status, i) => ({
    status,
    score: status === 'SCORED' ? 70 + i : null,
  })),
});

describe('CvScreeningService', () => {
  describe('addFiles: a large batch sent in several requests', () => {
    const opened = (over: Record<string, unknown> = {}) => ({
      id: 's1',
      external: false,
      offer_id: null,
      job_title: 'Caissier',
      job_text: 'Tenir la caisse.',
      purged_at: null,
      expires_at: new Date(Date.now() + 86_400_000),
      _count: { resumes: 2 },
      ...over,
    });

    it('adds the CVs to the screening, for its job, charged on their own', async () => {
      const { service, prisma } = make();
      prisma.cvScreening.findFirst = jest.fn().mockResolvedValue(opened());
      const create = jest
        .spyOn(service, 'create')
        .mockResolvedValue({} as never);

      await service.addFiles('p1', 's1', [file('c.pdf')]);

      expect(create).toHaveBeenCalledWith(
        'p1',
        [expect.objectContaining({ originalname: 'c.pdf' })],
        { jobTitle: 'Caissier', jobText: 'Tenir la caisse.' },
        's1',
      );
    });

    it('holds the plan’s CVs per analysis for the whole screening', async () => {
      const { service, prisma, subscriptions } = make();
      subscriptions.entitlements.mockResolvedValue(
        entitlements({ cvBatchMax: 3 }),
      );
      prisma.cvScreening.findFirst = jest.fn().mockResolvedValue(opened());
      await expect(
        service.addFiles('p1', 's1', [file('c.pdf'), file('d.pdf')]),
      ).rejects.toThrow('3 CV par analyse');
    });

    it('refuses an offer’s shared screening, one purged, or another business’s', async () => {
      const { service, prisma } = make();
      prisma.cvScreening.findFirst = jest
        .fn()
        .mockResolvedValueOnce(opened({ external: true }))
        .mockResolvedValueOnce(opened({ purged_at: new Date() }))
        .mockResolvedValueOnce(null);
      await expect(
        service.addFiles('p1', 's1', [file('c.pdf')]),
      ).rejects.toThrow('nouvelle analyse');
      await expect(
        service.addFiles('p1', 's1', [file('c.pdf')]),
      ).rejects.toThrow('conservation');
      await expect(
        service.addFiles('p1', 's1', [file('c.pdf')]),
      ).rejects.toThrow('introuvable');
    });
  });

  describe('create', () => {
    it('stores the CVs privately, takes them from the plan and queues one job each', async () => {
      const { service, storage, subscriptions, queue, prisma } = make();
      const result = await service.create(
        'p1',
        [file('a.pdf'), file('b.png', PNG, 'image/png')],
        JOB,
      );

      expect(subscriptions.consumeCv).toHaveBeenCalledWith('b1', 2);
      expect(storage.upload).toHaveBeenCalledTimes(2);
      expect(storage.upload.mock.calls[0][2]).toMatchObject({
        access: 'private',
        bucket: 'kyc-bucket',
        mimeType: 'application/pdf',
      });
      expect(prisma.cvScreening.create.mock.calls[0][0].data).toMatchObject({
        business_id: 'b1',
        subscription_id: 'sub-1',
        offer_id: null,
        job_title: 'Caissier',
      });
      // Each CV records the period it was charged to.
      expect(
        prisma.cvScreening.create.mock.calls[0][0].data.resumes.create,
      ).toEqual([
        expect.objectContaining({ subscription_id: 'sub-1' }),
        expect.objectContaining({ subscription_id: 'sub-1' }),
      ]);
      expect(queue.addJob).toHaveBeenCalledTimes(2);
      expect(result.total).toBe(2);
    });

    it('gives the CVs back and deletes the files when the screening cannot be saved', async () => {
      const { service, prisma, storage, subscriptions, queue } = make();
      prisma.cvScreening.create.mockRejectedValueOnce(new Error('db down'));

      await expect(
        service.create('p1', [file('a.pdf'), file('b.pdf')], JOB),
      ).rejects.toThrow('a échoué');

      expect(subscriptions.releaseCv).toHaveBeenCalledWith('sub-1', 2);
      expect(storage.delete).toHaveBeenCalledTimes(2);
      expect(queue.addJob).not.toHaveBeenCalled();
    });

    it('measures against an offer of the business only', async () => {
      const { service, prisma } = make();
      prisma.jobOffer.findFirst.mockResolvedValue({
        id: 'o1',
        title: 'Vendeur',
        description: 'Vendre.',
        employment_type: 'CDI',
        city: 'Pointe-Noire',
        country_name: 'Congo',
        is_remote: false,
        note: null,
        category: { name: 'Commerce' },
      });
      await service.create('p1', [file('a.pdf')], { offerId: 'o1' });
      expect(prisma.jobOffer.findFirst.mock.calls[0][0].where).toEqual({
        id: 'o1',
        employer_id: 'p1',
        deleted_at: null,
      });
      const data = prisma.cvScreening.create.mock.calls[0][0].data;
      expect(data.offer_id).toBe('o1');
      expect(data.job_text).toContain('Type : CDI');
      expect(data.job_text).toContain('Lieu : Pointe-Noire, Congo');
    });

    it('says a trial gets it with a paid plan', async () => {
      const { service, subscriptions } = make();
      subscriptions.entitlements.mockResolvedValue(
        entitlements({ cvQuota: 0, trialLocked: ['cvAnalysis'] }),
      );
      await expect(service.create('p1', [file('a.pdf')], JOB)).rejects.toThrow(
        /après votre essai/,
      );
    });

    it('refuses when the plan does not include it', async () => {
      const { service, subscriptions, storage } = make();
      subscriptions.entitlements.mockResolvedValue(
        entitlements({ cvQuota: 0 }),
      );
      await expect(service.create('p1', [file('a.pdf')], JOB)).rejects.toThrow(
        ForbiddenException,
      );
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('holds to the plan’s batch size, file size and the accepted types', async () => {
      const { service, subscriptions } = make();
      await expect(
        service.create('p1', [file('1'), file('2'), file('3'), file('4')], JOB),
      ).rejects.toThrow('3 CV par analyse : retirez-en 1');
      await expect(
        service.create(
          'p1',
          [{ ...file('gros.pdf'), size: 2 * 1024 * 1024 }],
          JOB,
        ),
      ).rejects.toThrow('« gros.pdf » dépasse 1 Mo');
      await expect(
        service.create(
          'p1',
          [
            file(
              'notes.txt',
              Buffer.from('juste du texte, pas un cv'),
              'text/plain',
            ),
          ],
          JOB,
        ),
      ).rejects.toThrow("n'est pas reconnu");
      expect(subscriptions.consumeCv).not.toHaveBeenCalled();
    });

    it('needs a job: an offer, or a title and a description', async () => {
      const { service } = make();
      await expect(
        service.create('p1', [file('a.pdf')], { jobTitle: 'Caissier' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('gives the CVs back and cleans up when storing fails', async () => {
      const { service, storage, subscriptions, prisma } = make();
      storage.upload
        .mockResolvedValueOnce({ key: 'k/first' })
        .mockRejectedValueOnce(new Error('S3 down'));
      await expect(
        service.create('p1', [file('a.pdf'), file('b.pdf')], JOB),
      ).rejects.toThrow("L'envoi des CV a échoué");
      expect(subscriptions.releaseCv).toHaveBeenCalledWith('sub-1', 2);
      expect(storage.delete).toHaveBeenCalledWith('k/first', {
        bucket: 'kyc-bucket',
      });
      expect(prisma.cvScreening.create).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('says which CVs are a Rabotka applicant’s', async () => {
      const { service, prisma } = make();
      const resume = (id: string) => ({
        id,
        status: 'SCORED',
        score: 80,
        created_at: new Date(),
        file_name: `${id}.txt`,
        mime_type: 'text/plain',
        size_bytes: 3,
        storage_key: 'k',
        criteria: {},
        summary: '',
        strengths: [],
        gaps: [],
        candidate: null,
        error: null,
      });
      prisma.cvScreening.findFirst = jest.fn().mockResolvedValue({
        id: 's1',
        job_title: 'Dev',
        job_text: '…',
        status: 'DONE',
        created_at: new Date(),
        expires_at: new Date(),
        purged_at: null,
        offer_id: 'o1',
        external: true,
        resumes: [resume('r1'), resume('r2')],
      });
      prisma.application = {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'a1', cv_resume_id: 'r1' }]),
      };

      const detail = await service.get('p1', 's1');

      expect(
        Object.fromEntries(detail.resumes.map((r) => [r.id, r.applicationId])),
      ).toEqual({ r1: 'a1', r2: null });
    });
  });

  describe('addToOffer', () => {
    const files = [
      {
        originalname: 'Awa Ngoma a1.txt',
        mimetype: 'text/plain',
        size: 3,
        buffer: Buffer.from('cv!'),
        tag: 'a1',
      },
    ];
    const created = (id: string) => ({
      id,
      resumes: [{ id: 'r-a1', fileName: 'Awa Ngoma a1.txt' }],
    });

    it('opens the offer’s screening, marks it shared and links each file to its resume', async () => {
      const { service, prisma } = make();
      prisma.cvScreening.findFirst = jest.fn().mockResolvedValue(null);
      const create = jest
        .spyOn(service, 'create')
        .mockResolvedValue(created('s1') as never);

      const out = await service.addToOffer('p1', 'o1', files);

      expect(create.mock.calls[0][3]).toBeUndefined();
      expect(prisma.cvScreening.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { external: true },
      });
      expect(prisma.cvScreeningResume.update).toHaveBeenCalledWith({
        where: { id: 'r-a1' },
        data: { file_name: 'Awa Ngoma.txt' },
      });
      expect(out).toEqual({
        screeningId: 's1',
        resumeIds: new Map([['a1', 'r-a1']]),
      });
    });

    it('joins the one already open, so every candidate can be compared', async () => {
      const { service, prisma } = make();
      prisma.cvScreening.findFirst = jest.fn().mockResolvedValue({ id: 's0' });
      const create = jest
        .spyOn(service, 'create')
        .mockResolvedValue(created('s0') as never);

      await service.addToOffer('p1', 'o1', files);

      expect(create.mock.calls[0][3]).toBe('s0');
      expect(prisma.cvScreening.update).not.toHaveBeenCalled();
    });
  });

  describe('process', () => {
    it('reads a photo with vision, saves the weighted score and reports progress', async () => {
      const { service, prisma, storage, llm, events, subscriptions } = make();
      prisma.cvScreeningResume.findUnique.mockResolvedValue(queued());
      storage.download.mockResolvedValue({ body: Readable.from([PNG]) });
      prisma.cvScreening.findUnique.mockResolvedValue(
        closing(['SCORED', 'QUEUED']),
      );

      await service.process('r1');

      const [messages, options] = llm.invoke.mock.calls[0];
      expect(options).toMatchObject({ tier: 'document' });
      expect(messages[1].content[1].type).toBe('image_url');
      const update = prisma.cvScreeningResume.updateMany.mock.calls[0][0];
      expect(update.where).toEqual({ id: 'r1', status: 'QUEUED' });
      // (80*35 + 60*30) / 65
      expect(update.data).toMatchObject({ status: 'SCORED', score: 71 });
      expect(subscriptions.releaseCv).not.toHaveBeenCalled();
      expect(events.emit).toHaveBeenCalledWith(CV_SCREENING_PROGRESS, {
        profileId: 'p1',
        screeningId: 's1',
        done: 1,
        total: 2,
      });
    });

    it('sends a scanned PDF to the providers that read PDFs', async () => {
      const { service, prisma, storage, llm } = make();
      prisma.cvScreeningResume.findUnique.mockResolvedValue(
        queued({ mime_type: 'application/pdf' }),
      );
      storage.download.mockResolvedValue({ body: Readable.from([PDF]) });
      prisma.cvScreening.findUnique.mockResolvedValue(closing(['SCORED']));

      await service.process('r1');

      expect(llm.invoke).not.toHaveBeenCalled();
      expect(llm.invokeWith).toHaveBeenCalledTimes(1);
      expect(llm.invokeWith.mock.calls[0][0]).toEqual({
        provider: 'google',
        model: 'g',
      });
    });

    it('asks once more when the answer is not JSON', async () => {
      const { service, prisma, storage, llm } = make();
      prisma.cvScreeningResume.findUnique.mockResolvedValue(queued());
      storage.download.mockResolvedValue({ body: Readable.from([PNG]) });
      prisma.cvScreening.findUnique.mockResolvedValue(closing(['SCORED']));
      llm.invoke
        .mockResolvedValueOnce({
          output: { content: 'Voici mon avis : bon profil.' },
        })
        .mockResolvedValueOnce({ output: { content: ANSWER } });

      await service.process('r1');

      expect(llm.invoke).toHaveBeenCalledTimes(2);
      expect(
        prisma.cvScreeningResume.updateMany.mock.calls[0][0].data.status,
      ).toBe('SCORED');
    });

    it('gives back a document that is not a CV', async () => {
      const { service, prisma, storage, llm, subscriptions } = make();
      prisma.cvScreeningResume.findUnique.mockResolvedValue(queued());
      storage.download.mockResolvedValue({ body: Readable.from([PNG]) });
      prisma.cvScreening.findUnique.mockResolvedValue(closing(['UNREADABLE']));
      llm.invoke.mockResolvedValue({ output: { content: '{"isCv": false}' } });

      await service.process('r1');

      expect(
        prisma.cvScreeningResume.updateMany.mock.calls[0][0].data.status,
      ).toBe('UNREADABLE');
      expect(subscriptions.releaseCv).toHaveBeenCalledWith('sub-1', 1);
    });

    it('gives back a CV every model failed on', async () => {
      const { service, prisma, storage, llm, subscriptions } = make();
      prisma.cvScreeningResume.findUnique.mockResolvedValue(queued());
      storage.download.mockResolvedValue({ body: Readable.from([PNG]) });
      prisma.cvScreening.findUnique.mockResolvedValue(closing(['FAILED']));
      llm.invoke.mockRejectedValue(new Error('chain exhausted'));

      await service.process('r1');

      expect(
        prisma.cvScreeningResume.updateMany.mock.calls[0][0].data.status,
      ).toBe('FAILED');
      expect(subscriptions.releaseCv).toHaveBeenCalledWith('sub-1', 1);
    });

    it('gives a failed CV back to the period it was charged to, not the screening’s', async () => {
      const { service, prisma, storage, llm, subscriptions } = make();
      // An offer's screening opened under an older period; this CV was
      // charged to the period running when it arrived.
      prisma.cvScreeningResume.findUnique.mockResolvedValue(
        queued({ subscription_id: 'sub-now' }),
      );
      storage.download.mockResolvedValue({ body: Readable.from([PNG]) });
      prisma.cvScreening.findUnique.mockResolvedValue(closing(['FAILED']));
      llm.invoke.mockRejectedValue(new Error('chain exhausted'));

      await service.process('r1');

      expect(subscriptions.releaseCv).toHaveBeenCalledWith('sub-now', 1);
      expect(subscriptions.releaseCv).not.toHaveBeenCalledWith('sub-1', 1);
    });

    it('leaves a CV already decided alone', async () => {
      const { service, prisma, llm } = make();
      prisma.cvScreeningResume.findUnique.mockResolvedValue(
        queued({ status: 'SCORED' }),
      );
      await service.process('r1');
      expect(llm.invoke).not.toHaveBeenCalled();
      expect(prisma.cvScreeningResume.updateMany).not.toHaveBeenCalled();
    });

    it('says nothing when an offer’s own screening closes: candidates arrive one by one', async () => {
      const { service, prisma, storage, events } = make();
      prisma.cvScreeningResume.findUnique.mockResolvedValue(queued());
      storage.download.mockResolvedValue({ body: Readable.from([PNG]) });
      prisma.cvScreening.findUnique.mockResolvedValue({
        ...closing(['SCORED']),
        external: true,
      });

      await service.process('r1');

      expect(prisma.cvScreening.updateMany).toHaveBeenCalled();
      expect(
        events.emit.mock.calls.some(
          ([name]: [string]) => name === 'profile.notification.create',
        ),
      ).toBe(false);
    });

    it('closes the screening after its last CV and tells the business, once', async () => {
      const { service, prisma, storage, events } = make();
      prisma.cvScreeningResume.findUnique.mockResolvedValue(queued());
      storage.download.mockResolvedValue({ body: Readable.from([PNG]) });
      prisma.cvScreening.findUnique.mockResolvedValue(
        closing(['SCORED', 'SCORED', 'UNREADABLE']),
      );

      await service.process('r1');

      expect(prisma.cvScreening.updateMany).toHaveBeenCalledWith({
        where: { id: 's1', status: 'PROCESSING' },
        data: { status: 'DONE' },
      });
      const notification = events.emit.mock.calls.find(
        ([name]: [string]) => name === 'profile.notification.create',
      );
      expect(notification[1]).toMatchObject({
        recipientId: 'p1',
        input: {
          type: 'CV_SCREENING_DONE',
          screeningId: 's1',
          scored: 2,
          best: 71,
        },
      });

      // Another CV closing at the same moment finds it already closed.
      events.emit.mockClear();
      prisma.cvScreening.updateMany.mockResolvedValue({ count: 0 });
      prisma.cvScreeningResume.findUnique.mockResolvedValue(queued());
      storage.download.mockResolvedValue({ body: Readable.from([PNG]) });
      await service.process('r1');
      expect(
        events.emit.mock.calls.some(
          ([name]: [string]) => name === 'profile.notification.create',
        ),
      ).toBe(false);
    });
  });

  describe('list', () => {
    it('sums each analysis up: best candidate, average, verdict spread', async () => {
      const { service, prisma } = make();
      prisma.cvScreening.count = jest.fn().mockResolvedValue(1);
      const resume = (status: string, score: number | null, name?: string) => ({
        status,
        score,
        candidate: name ? { name } : null,
      });
      prisma.cvScreening.findMany.mockResolvedValue([
        {
          id: 's1',
          job_title: 'Caissier',
          offer_id: null,
          status: 'DONE',
          created_at: new Date('2026-10-27T08:00:00Z'),
          expires_at: new Date('2026-11-26T08:00:00Z'),
          purged_at: null,
          resumes: [
            resume('SCORED', 62, 'Jordy'),
            resume('SCORED', 91, 'Grâce'),
            resume('SCORED', 35, 'Prince'),
            resume('UNREADABLE', null),
          ],
        },
      ]);

      const { items, total } = await service.list('p1', 0, 20);

      expect(total).toBe(1);
      expect(items[0]).toMatchObject({
        total: 4,
        scored: 3,
        bestScore: 91,
        bestCandidate: 'Grâce',
        averageScore: 63,
        bands: { very: 1, good: 1, partial: 0, low: 1 },
      });
    });
  });

  describe('backfillCareers', () => {
    const scored = (id: string) => ({
      id,
      cv_text: 'CV',
      candidate: { name: 'Awa', yearsExperience: 9, email: 'a@b.c' },
      screening: { job_title: 'Hôtesse', job_text: 'Accueil.' },
    });

    it('adds the career to older CVs and keeps the rest of the analysis', async () => {
      const { service, prisma } = make();
      prisma.$queryRaw = jest
        .fn()
        .mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
      prisma.cvScreeningResume.findUnique = jest
        .fn()
        .mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve(scored(where.id)),
        );
      prisma.cvScreeningResume.update = jest.fn().mockResolvedValue({});
      const assess = jest
        .spyOn(service as any, 'assess')
        .mockResolvedValueOnce({
          candidate: {
            experiences: [{ title: 'Hôtesse' }],
            experienceMonths: 36,
            relevantMonths: 30,
            yearsExperience: 3,
          },
        })
        // Not readable for its career: marked, not retried.
        .mockResolvedValueOnce(null);

      await expect(service.backfillCareers()).resolves.toBe(2);
      expect(assess).toHaveBeenCalledTimes(2);
      expect(prisma.cvScreeningResume.update.mock.calls[0][0]).toEqual({
        where: { id: 'r1' },
        data: {
          candidate: {
            name: 'Awa',
            email: 'a@b.c',
            yearsExperience: 3,
            experiences: [{ title: 'Hôtesse' }],
            experienceMonths: 36,
            relevantMonths: 30,
          },
        },
      });
      expect(
        prisma.cvScreeningResume.update.mock.calls[1][0].data.candidate,
      ).toMatchObject({ experiences: [], yearsExperience: 9 });
    });

    it('leaves a CV for the next run when the provider fails', async () => {
      const { service, prisma } = make();
      prisma.$queryRaw = jest.fn().mockResolvedValue([{ id: 'r1' }]);
      prisma.cvScreeningResume.findUnique = jest
        .fn()
        .mockResolvedValue(scored('r1'));
      prisma.cvScreeningResume.update = jest.fn();
      jest.spyOn(service as any, 'assess').mockRejectedValue(new Error('down'));

      await expect(service.backfillCareers()).resolves.toBe(0);
      expect(prisma.cvScreeningResume.update).not.toHaveBeenCalled();
    });
  });

  describe('sweep', () => {
    it('purges each CV past its own retention, and keeps the scores', async () => {
      const { service, prisma, storage } = make();
      const now = new Date('2026-12-01T00:00:00Z');
      (prisma.cvScreening as any).updateMany = jest
        .fn()
        .mockResolvedValue({ count: 1 });
      prisma.cvScreeningResume.findMany
        .mockResolvedValueOnce([]) // stuck
        .mockResolvedValueOnce([
          {
            id: 'r1',
            screening_id: 's1',
            storage_key: 'k/r1.pdf',
            storage_bucket: 'kyc-bucket',
            candidate: { name: 'Awa', email: 'a@b.c', phone: '06' },
          },
        ]);

      await expect(service.sweep(now)).resolves.toEqual({
        stuck: 0,
        purged: 1,
      });

      // Due by its own date, or its screening's for a CV from before.
      expect(
        prisma.cvScreeningResume.findMany.mock.calls[1][0].where.AND[0].OR,
      ).toEqual([
        { expires_at: { lte: now } },
        { expires_at: null, screening: { expires_at: { lte: now } } },
      ]);
      expect(storage.delete).toHaveBeenCalledWith('k/r1.pdf', {
        bucket: 'kyc-bucket',
      });
      expect(prisma.cvScreeningResume.update.mock.calls[0][0]).toEqual({
        where: { id: 'r1' },
        data: {
          storage_key: null,
          storage_bucket: null,
          cv_text: null,
          candidate: { name: 'Awa', email: null, phone: null },
        },
      });
      // The conversations quote the CV: purged with it.
      expect(prisma.cvResumeMessage.deleteMany).toHaveBeenCalledWith({
        where: { resume_id: 'r1' },
      });
      expect(prisma.cvComparisonMessage.deleteMany).toHaveBeenCalledWith({
        where: { comparison: { resume_ids: { has: 'r1' } } },
      });
      // The screening is marked purged once none of its CVs keeps anything.
      expect(
        (prisma.cvScreening as any).updateMany.mock.calls[0][0].data,
      ).toEqual({ purged_at: now });
    });

    it('keeps the key of a file the storage would not delete, to try again', async () => {
      const { service, prisma, storage } = make();
      (prisma.cvScreening as any).updateMany = jest
        .fn()
        .mockResolvedValue({ count: 0 });
      prisma.cvScreeningResume.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 'r1',
            screening_id: 's1',
            storage_key: 'k/r1.pdf',
            storage_bucket: null,
            candidate: null,
          },
        ]);
      storage.delete.mockRejectedValueOnce(new Error('S3 down'));

      await service.sweep(new Date('2026-12-01T00:00:00Z'));

      const data = prisma.cvScreeningResume.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('storage_key');
      expect(data.cv_text).toBeNull();
    });

    it('gives up CVs stuck in the queue, and gives them back', async () => {
      const { service, prisma, subscriptions } = make();
      prisma.cvScreeningResume.findMany.mockResolvedValueOnce([queued()]);
      prisma.cvScreening.findUnique.mockResolvedValue(closing(['FAILED']));
      (prisma.cvScreening as any).updateMany = jest
        .fn()
        .mockResolvedValue({ count: 0 });

      await expect(service.sweep()).resolves.toEqual({ stuck: 1, purged: 0 });

      expect(
        prisma.cvScreeningResume.updateMany.mock.calls[0][0].data.status,
      ).toBe('FAILED');
      expect(subscriptions.releaseCv).toHaveBeenCalledWith('sub-1', 1);
    });
  });
});
