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
      expect(queue.addJob).toHaveBeenCalledTimes(2);
      expect(result.total).toBe(2);
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

    it('leaves a CV already decided alone', async () => {
      const { service, prisma, llm } = make();
      prisma.cvScreeningResume.findUnique.mockResolvedValue(
        queued({ status: 'SCORED' }),
      );
      await service.process('r1');
      expect(llm.invoke).not.toHaveBeenCalled();
      expect(prisma.cvScreeningResume.updateMany).not.toHaveBeenCalled();
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

  describe('sweep', () => {
    it('purges files and contact details past retention, and keeps the scores', async () => {
      const { service, prisma, storage } = make();
      const now = new Date('2026-12-01T00:00:00Z');
      prisma.cvScreening.findMany.mockResolvedValue([
        {
          id: 's1',
          resumes: [
            {
              id: 'r1',
              storage_key: 'k/r1.pdf',
              storage_bucket: 'kyc-bucket',
              candidate: { name: 'Awa', email: 'a@b.c', phone: '06' },
            },
            {
              id: 'r2',
              storage_key: null,
              storage_bucket: null,
              candidate: null,
            },
          ],
        },
      ]);

      await expect(service.sweep(now)).resolves.toEqual({
        stuck: 0,
        purged: 1,
      });

      expect(prisma.cvScreening.findMany.mock.calls[0][0].where).toEqual({
        expires_at: { lte: now },
        purged_at: null,
      });
      expect(storage.delete).toHaveBeenCalledTimes(1);
      expect(storage.delete).toHaveBeenCalledWith('k/r1.pdf', {
        bucket: 'kyc-bucket',
      });
      expect(prisma.cvScreeningResume.update.mock.calls[0][0]).toEqual({
        where: { id: 'r1' },
        data: {
          storage_key: null,
          storage_bucket: null,
          candidate: { name: 'Awa', email: null, phone: null },
        },
      });
      expect(prisma.cvScreening.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { purged_at: now },
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('gives up CVs stuck in the queue, and gives them back', async () => {
      const { service, prisma, subscriptions } = make();
      prisma.cvScreeningResume.findMany.mockResolvedValue([queued()]);
      prisma.cvScreening.findUnique.mockResolvedValue(closing(['FAILED']));

      await expect(service.sweep()).resolves.toEqual({ stuck: 1, purged: 0 });

      expect(
        prisma.cvScreeningResume.updateMany.mock.calls[0][0].data.status,
      ).toBe('FAILED');
      expect(subscriptions.releaseCv).toHaveBeenCalledWith('sub-1', 1);
    });
  });
});
